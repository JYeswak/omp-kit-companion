#!/usr/bin/env python3
"""Exercise candidate indexing with detached minimum/certified OMP receipts."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "native-candidate.py"
with (ROOT / "scripts" / "omp-compat.json").open(encoding="utf-8") as source:
    COMPAT = json.load(source)
MINIMUM = COMPAT["minimum"]
CERTIFIED = COMPAT["certified"]
PLATFORMS = ("darwin-arm64-none", "darwin-x64-none", "linux-arm64-gnu", "linux-x64-gnu")
PROOF_NAMES = {
    "status", "doctor", "fast", "full", "lsp", "lsp_setup", "memory", "memory_off",
    "mnemopi_manual", "model_roles", "mcp", "mcp_readiness", "project_preflight", "lsp_deep",
    "memory_audit", "redactor_warning",
}

spec = importlib.util.spec_from_file_location("native_candidate", SCRIPT)
if spec is None or spec.loader is None:
    raise RuntimeError(f"cannot load {SCRIPT}")
native_candidate = importlib.util.module_from_spec(spec)
sys.dont_write_bytecode = True
spec.loader.exec_module(native_candidate)


# Isolate receipt aggregation from the production CLI's clean-checkout precondition.
def allow_test_source(source_sha: str) -> None:
    if len(source_sha) != 40:
        raise AssertionError("candidate did not preserve the source SHA shape")
setattr(native_candidate, "verified_source", allow_test_source)


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


class CandidateReceiptTests(unittest.TestCase):
    def setUp(self) -> None:
        scratch = ROOT / "var" / "agent-tmp"
        scratch.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="native-candidate-test-", dir=scratch)
        self.root = Path(self.temp.name)
        self.assets = self.root / "assets"
        self.receipts = self.root / "receipts"
        self.version = "1.2.3"
        self.source_sha = "a" * 40
        self.asset_by_platform = {}
        self._write_assets()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _write_assets(self) -> None:
        for platform in PLATFORMS:
            os_name, arch, libc = platform.split("-")
            directory = self.assets / ("candidate-" + platform)
            filename = f"omp-kit-v{self.version}-{platform}.tar"
            archive = ("fixture archive " + platform).encode()
            (directory / filename).parent.mkdir(parents=True, exist_ok=True)
            (directory / filename).write_bytes(archive)
            asset = {
                "os": os_name,
                "arch": arch,
                "libc": libc,
                "filename": filename,
                "sha256": hashlib.sha256(archive).hexdigest(),
                "manifest_sha256": "b" * 64,
            }
            write_json(directory / "asset.json", asset)
            self.asset_by_platform[platform] = asset

    def _write_receipts(self, tracks=("minimum", "certified"), omit=None) -> None:
        for platform in PLATFORMS:
            for track in tracks:
                if omit == (platform, track):
                    continue
                receipt = {
                    "schema_version": 1,
                    "version": self.version,
                    "source_sha": self.source_sha,
                    "platform": platform,
                    "asset": self.asset_by_platform[platform],
                    "omp_track": track,
                    "requested_omp_version": MINIMUM if track == "minimum" else CERTIFIED,
                    "omp_version": MINIMUM if track == "minimum" else CERTIFIED,
                    "proofs": {
                        name: {"status": "PASS", "stdout_sha256": "c" * 64}
                        for name in PROOF_NAMES
                    },
                    "certified": True,
                }
                write_json(
                    self.receipts / f"native-receipt-{platform}-{track}" / "receipt.json",
                    receipt,
                )

    def _args(self):
        return types.SimpleNamespace(
            version=self.version,
            source_sha=self.source_sha,
            assets=str(self.assets),
            receipts=str(self.receipts),
            out=str(self.root / "out"),
        )

    def test_candidate_records_both_versions_for_each_certified_platform(self) -> None:
        self._write_receipts()

        self.assertEqual(native_candidate.candidate(self._args()), 0)
        release_index = json.loads((self.root / "out" / "release-index.json").read_text(encoding="utf-8"))
        proof = json.loads((self.root / "out" / "candidate-proof.json").read_text(encoding="utf-8"))

        self.assertEqual(set(release_index["assets"]), set(PLATFORMS))
        self.assertEqual(proof["omp_versions"], {"minimum": MINIMUM, "certified": CERTIFIED})
        self.assertEqual(proof["certified_platforms"], list(PLATFORMS))
        self.assertEqual(
            proof["platform_omp_versions"],
            {platform: {"minimum": MINIMUM, "certified": CERTIFIED} for platform in PLATFORMS},
        )

    def test_candidate_refuses_when_minimum_receipts_are_missing(self) -> None:
        self._write_receipts(tracks=("certified",))

        with self.assertRaisesRegex(ValueError, f"minimum={MINIMUM}"):
            native_candidate.candidate(self._args())

    def test_candidate_refuses_when_certified_receipts_are_missing(self) -> None:
        self._write_receipts(tracks=("minimum",))

        with self.assertRaisesRegex(ValueError, f"certified={CERTIFIED}"):
            native_candidate.candidate(self._args())

    def test_incomplete_platform_is_not_advertised_when_other_platforms_have_both_versions(self) -> None:
        incomplete = PLATFORMS[0]
        self._write_receipts(omit=(incomplete, "certified"))

        self.assertEqual(native_candidate.candidate(self._args()), 0)
        release_index = json.loads((self.root / "out" / "release-index.json").read_text(encoding="utf-8"))
        proof = json.loads((self.root / "out" / "candidate-proof.json").read_text(encoding="utf-8"))

        self.assertNotIn(incomplete, release_index["assets"])
        self.assertNotIn(incomplete, proof["platform_omp_versions"])
        self.assertEqual(set(proof["certified_platforms"]), set(PLATFORMS[1:]))

    def test_refusal_detail_names_failing_stage_and_scenarios(self) -> None:
        payload = {
            "data": {"test": {
                "status": "FAIL",
                "stages": {"fast": {"status": "PASS"}, "full": {"status": "FAIL"}},
                "failures": ["G4 live scenario planted-fail"],
                "live_scenarios": {"expected_ids": ["planted-fail", "planted-pass"], "observed_ids": ["planted-pass"]},
            }},
            "errors": [{"code": "LIVE_FAIL", "message": "planted-fail refused"}],
        }
        child = types.SimpleNamespace(returncode=1, stdout=json.dumps(payload).encode(), stderr=b"tail")
        detail = native_candidate.refusal_detail("test --full", child)
        self.assertEqual(detail["command"], "test --full")
        self.assertEqual(detail["rc"], 1)
        self.assertEqual(detail["failed_stages"], ["full"])
        self.assertIn("G4 live scenario planted-fail", detail["failures"])
        self.assertEqual(detail["missing_scenarios"], ["planted-fail"])



class CertEnvTests(unittest.TestCase):
    """RELEASE BLOCKER A2: the CI-judge signal must survive the scrubbed env."""

    def test_github_actions_passes_through_when_set(self) -> None:
        home, root = Path("/tmp/home"), Path("/tmp/root")
        saved = os.environ.get("GITHUB_ACTIONS")
        os.environ["GITHUB_ACTIONS"] = "true"
        try:
            env = native_candidate.cert_env(home, root)
        finally:
            if saved is None:
                del os.environ["GITHUB_ACTIONS"]
            else:
                os.environ["GITHUB_ACTIONS"] = saved
        self.assertEqual(env["GITHUB_ACTIONS"], "true")
        self.assertEqual(env["CI"], "true")
        self.assertEqual(env["HOME"], "/tmp/home")

    def test_github_actions_absent_when_unset(self) -> None:
        home, root = Path("/tmp/home"), Path("/tmp/root")
        saved = os.environ.pop("GITHUB_ACTIONS", None)
        try:
            env = native_candidate.cert_env(home, root)
        finally:
            if saved is not None:
                os.environ["GITHUB_ACTIONS"] = saved
        self.assertNotIn("GITHUB_ACTIONS", env)
        self.assertEqual(env["CI"], "true")

if __name__ == "__main__":
    unittest.main()
