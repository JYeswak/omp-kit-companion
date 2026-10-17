#!/usr/bin/env python3
"""Exercise candidate indexing with detached minimum/certified OMP receipts."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import types
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "native-candidate.py"
with (ROOT / "scripts" / "omp-compat.json").open(encoding="utf-8") as source:
    COMPAT = json.load(source)
MINIMUM = COMPAT["minimum"]
CERTIFIED = COMPAT["certified"]
PLATFORMS = ("darwin-arm64-none", "darwin-x64-none", "linux-arm64-gnu", "linux-x64-gnu")
RELEASE_PLATFORMS = ("darwin-arm64-none", "linux-arm64-gnu", "linux-x64-gnu")
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
                        name: {
                            "status": "PASS", "stdout_sha256": "c" * 64,
                            **({"stage_durations_ms": {"manifest": 1}} if name == "full" else {}),
                        }
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

    def test_full_receipt_with_telemetry_error_and_no_durations_is_accepted(self) -> None:
        self._write_receipts()
        platform = PLATFORMS[0]
        path = self.receipts / f"native-receipt-{platform}-minimum" / "receipt.json"
        receipt = json.loads(path.read_text(encoding="utf-8"))
        del receipt["proofs"]["full"]["stage_durations_ms"]
        receipt["telemetry_error"] = "native full report omitted stage-start marker(s)"
        write_json(path, receipt)

        self.assertEqual(
            native_candidate.certified_omp_versions(
                self._args(), platform, self.asset_by_platform[platform],
                {"minimum": MINIMUM}, PROOF_NAMES),
            {"minimum": MINIMUM})

    def test_full_receipt_with_invalid_stage_durations_is_rejected(self) -> None:
        self._write_receipts()
        platform = PLATFORMS[0]
        path = self.receipts / f"native-receipt-{platform}-minimum" / "receipt.json"
        receipt = json.loads(path.read_text(encoding="utf-8"))
        receipt["proofs"]["full"]["stage_durations_ms"] = {"manifest": -1}
        write_json(path, receipt)

        with self.assertRaisesRegex(ValueError, "detached native proof"):
            native_candidate.certified_omp_versions(
                self._args(), platform, self.asset_by_platform[platform],
                {"minimum": MINIMUM}, PROOF_NAMES)

    def test_incomplete_platform_is_not_advertised_when_other_platforms_have_both_versions(self) -> None:
        incomplete = PLATFORMS[0]
        self._write_receipts(omit=(incomplete, "certified"))

        self.assertEqual(native_candidate.candidate(self._args()), 0)
        release_index = json.loads((self.root / "out" / "release-index.json").read_text(encoding="utf-8"))
        proof = json.loads((self.root / "out" / "candidate-proof.json").read_text(encoding="utf-8"))

        self.assertNotIn(incomplete, release_index["assets"])
        self.assertNotIn(incomplete, proof["platform_omp_versions"])
        self.assertEqual(set(proof["certified_platforms"]), set(PLATFORMS[1:]))

    def test_release_candidate_refuses_failing_linux_x64_ship_leg(self) -> None:
        self._write_receipts()
        receipt_path = self.receipts / "native-receipt-linux-x64-gnu-minimum" / "receipt.json"
        failed_receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        failed_receipt["certified"] = False
        failed_receipt["failure"] = "planted linux-x64 minimum certification failure"
        write_json(receipt_path, failed_receipt)
        args = self._args()
        args.release = True

        with self.assertRaisesRegex(ValueError, "linux-x64-gnu"):
            native_candidate.candidate(args)

        self.assertFalse((self.root / "out" / "release-index.json").exists())
        self.assertFalse((self.root / "out" / "candidate-proof.json").exists())

    def test_release_candidate_excludes_certified_darwin_x64(self) -> None:
        self._write_receipts()
        args = self._args()
        args.release = True

        self.assertEqual(native_candidate.candidate(args), 0)
        release_index = json.loads((self.root / "out" / "release-index.json").read_text(encoding="utf-8"))
        proof = json.loads((self.root / "out" / "candidate-proof.json").read_text(encoding="utf-8"))

        self.assertEqual(set(release_index["assets"]), set(RELEASE_PLATFORMS))
        self.assertEqual(proof["certified_platforms"], list(RELEASE_PLATFORMS))

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

    def test_refusal_detail_attaches_probe_tail_on_failing_deep_probe(self) -> None:
        payload = {
            "data": {"deep_probe": {
                "checks": {"lsp_ok": True, "hover": False, "references": False},
                "timeout_observation": "hover exceeded 5000 ms",
                "json_rpc_trace": [{"id": n} for n in range(12)],
            }},
            "errors": [{"code": "LSP_INCOMPLETE", "message": "planted probe failure"}],
        }
        child = types.SimpleNamespace(returncode=1, stdout=json.dumps(payload).encode(), stderr=b"tail")
        detail = native_candidate.refusal_detail("lsp-deep", child)
        self.assertEqual(detail["probe_tail"]["failed_checks"], ["hover", "references"])
        self.assertEqual(detail["probe_tail"]["timeout_observation"], "hover exceeded 5000 ms")
        self.assertEqual(detail["probe_tail"]["json_rpc_trace"], [{"id": n} for n in range(4, 12)])

    def test_refusal_detail_omits_probe_tail_when_probe_clean_or_absent(self) -> None:
        clean = {
            "data": {"deep_probe": {"checks": {"lsp_ok": True}, "json_rpc_trace": []}},
            "errors": [{"code": "OTHER", "message": "planted"}],
        }
        child = types.SimpleNamespace(returncode=1, stdout=json.dumps(clean).encode(), stderr=b"tail")
        self.assertNotIn("probe_tail", native_candidate.refusal_detail("lsp-deep", child))
        absent = {"data": {}, "errors": [{"code": "OTHER", "message": "planted"}]}
        child = types.SimpleNamespace(returncode=1, stdout=json.dumps(absent).encode(), stderr=b"tail")
        self.assertNotIn("probe_tail", native_candidate.refusal_detail("lsp-deep", child))




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


class ScopedRunTests(unittest.TestCase):
    """fp72.48: certification children die as a group, so teardown never races live writers."""

    def test_timeout_reaps_detached_grandchild_and_tree_removes_cleanly(self) -> None:
        work = Path(tempfile.mkdtemp(prefix="scoped-writer-", dir=ROOT / "var" / "agent-tmp"))
        self.addCleanup(shutil.rmtree, work, True)
        late = work / "late.txt"
        pidfile = work / "writer.pid"
        # Child detaches a grandchild that writes into the tree, then sleeps
        # past the timeout: without a group kill the grandchild survives and a
        # later rmtree races it (native Errno 66 masking a 900 s timeout).
        inner_path = work / "writer.py"
        inner_path.write_text(
            "import os, time\n"
            f"open({str(pidfile)!r}, 'w').write(str(os.getpid()))\n"
            f"open({str(late)!r}, 'a').write('late\\n')\n"
            "time.sleep(300)\n",
            encoding="utf-8")
        script = (
            "import subprocess, sys\n"
            f"subprocess.Popen([sys.executable, {str(inner_path)!r}])\n"
            "import time; time.sleep(60)\n"
        )
        with self.assertRaises(subprocess.TimeoutExpired):
            native_candidate.run_scoped(
                [sys.executable, "-c", script],
                cwd=str(work), env=os.environ.copy(), timeout=5)
        writer = int(pidfile.read_text(encoding="utf-8").strip())
        for _ in range(100):
            try:
                os.kill(writer, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        else:
            self.fail("detached writer survived the group kill")
        shutil.rmtree(work)
        self.assertFalse(work.exists())

    def test_clean_exit_returns_completed_process(self) -> None:
        result = native_candidate.run_scoped(
            [sys.executable, "-c", "print('ok')"],
            cwd=str(ROOT), env=os.environ.copy(), timeout=60)
        self.assertEqual(result.returncode, 0)
        self.assertIn(b"ok", result.stdout)

    def test_timeout_receipt_names_interrupted_ladder_stage_and_elapsed_ms(self) -> None:
        work = Path(tempfile.mkdtemp(prefix="interrupted-ladder-", dir=ROOT / "var" / "agent-tmp"))
        self.addCleanup(shutil.rmtree, work, True)
        with self.assertRaises(subprocess.TimeoutExpired) as timeout:
            native_candidate.run_scoped(
                ["/bin/sh", str(ROOT / "scripts" / "ladder.sh"), "--selftest-interruption", "e2e-live", str(work)],
                cwd=str(ROOT), env=os.environ.copy(), timeout=0.15)

        detail = native_candidate.timeout_detail("full", timeout.exception, 0.15)
        self.assertTrue(detail["timed_out"])
        self.assertEqual(detail["current_stage"]["name"], "e2e-live")
        self.assertGreaterEqual(detail["current_stage"]["elapsed_ms"], 100)

class FullProofTests(unittest.TestCase):
    def test_passing_full_proof_retains_stage_durations_without_telemetry_error(self) -> None:
        child = types.SimpleNamespace(
            stdout=b"full report",
            stderr=(b"OMP_KIT_STAGE_START name=harness-gate started_at_ms=100\n"
                    b"OMP_KIT_STAGE_START name=e2e-live started_at_ms=220\n"),
        )
        test = {"stages": {
            "harness-gate": {"status": "PASS"},
            "e2e-live": {"status": "PASS"},
            "optional-stage": {"status": "NOT_RUN"},
        }}
        receipt = {"proofs": {}}

        proof = native_candidate.proof_record(
            "full", child, test, finished_at_ms=300, receipt=receipt)

        self.assertEqual(proof["status"], "PASS")
        self.assertEqual(proof["stdout_sha256"], hashlib.sha256(child.stdout).hexdigest())
        self.assertEqual(proof["stage_durations_ms"], {"harness-gate": 120, "e2e-live": 80})
        self.assertEqual(receipt["proofs"]["full"], proof)
        self.assertNotIn("telemetry_error", receipt)

    def test_missing_stage_marker_records_bounded_telemetry_without_refusing_full_proof(self) -> None:
        child = types.SimpleNamespace(
            stdout=b"full report",
            stderr=b"OMP_KIT_STAGE_START name=harness-gate started_at_ms=100\n",
        )
        stages = {"harness-gate": {"status": "PASS"}}
        stages.update({f"missing-{index:03}": {"status": "PASS"} for index in range(40)})
        receipt = {"proofs": {}}

        proof = native_candidate.proof_record(
            "full", child, {"stages": stages}, finished_at_ms=300, receipt=receipt)

        self.assertEqual(proof["status"], "PASS")
        self.assertNotIn("stage_durations_ms", proof)
        self.assertEqual(receipt["proofs"]["full"], proof)
        self.assertIn("telemetry_error", receipt)
        self.assertIn("missing-", receipt["telemetry_error"])
        self.assertLessEqual(len(receipt["telemetry_error"]), 300)


if __name__ == "__main__":
    unittest.main()
