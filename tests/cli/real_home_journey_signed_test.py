"""Planted negatives for the signed-native-consumer mode of tests/e2e/real-home-journey.sh.

Each case runs the real runner script with deliberately bad signed-mode inputs and asserts that it
refuses before touching a fixture and that no receipt (positive or partial) is left behind. The
positive path needs genuine signed release assets and runs only in the release workflow.
"""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from kitlib_tmp import owned_tmp  # noqa: E402  (kitlib owned temp dirs: removed on exit and on HUP/INT/TERM)
from pysafe import run_bounded  # noqa: E402  (cancel-safe spawn: own process group, stdin DEVNULL, hard deadline)

RUNNER = Path(__file__).resolve().parents[1] / "e2e" / "real-home-journey.sh"
SHA = "a" * 40


class SignedRunnerRefusals(unittest.TestCase):
    def setUp(self):
        self._tmp = owned_tmp("real-home-journey-signed")
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.path).resolve()
        for name, version in (("prev", "0.2.37"), ("cand", "0.2.38")):
            (self.root / f"{name}.tar.gz").write_bytes(b"not-a-real-archive")
            (self.root / f"{name}.json").write_text(
                json.dumps({"schema_version": 1, "version": version, "assets": {"darwin-arm64": {}}}))
        self.receipt = self.root / "out" / "signed-consumer-darwin-arm64-attempt-1" / "receipt.json"

    def run_runner(self, **overrides):
        args = {
            "--candidate-archive": self.root / "cand.tar.gz",
            "--candidate-index": self.root / "cand.json",
            "--previous-archive": self.root / "prev.tar.gz",
            "--previous-index": self.root / "prev.json",
            "--work-dir": self.root / "work",
            "--platform": "darwin-arm64",
            "--source-sha": SHA,
            "--run-id": "12345",
            "--run-attempt": "1",
            "--receipt-out": self.receipt,
        }
        args.update(overrides)
        argv = ["sh", str(RUNNER)]
        for key, value in args.items():
            if value is not None:
                argv += [key, str(value)]
        env = {k: v for k, v in os.environ.items() if not k.startswith("JOURNEY_")}
        result = run_bounded(argv, env=env, timeout=60)
        if result.outcome != "OK":
            raise AssertionError(f"runner hung past 60s; process group killed: {argv[1]}")
        return SimpleNamespace(returncode=result.returncode, stdout=result.text("stdout"), stderr=result.text("stderr"))

    def assert_refused(self, proc, needle):
        self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn(needle, proc.stderr)
        self.assertFalse(self.receipt.exists(), "a refused run must not emit a receipt")
        self.assertFalse((self.root / "work" / "home").exists(), "refusal must precede fixture creation")

    def test_missing_bundle_is_rejected(self):
        proc = self.run_runner()
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assert_refused(proc, "bundle is missing or unsafe")

    def test_partial_signed_flags_are_rejected(self):
        proc = self.run_runner(**{"--receipt-out": None})
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertFalse(self.receipt.exists())

    def test_wrong_source_sha_is_rejected(self):
        proc = self.run_runner(**{"--source-sha": "NOT-HEX"})
        self.assert_refused(proc, "--source-sha must be lowercase hexadecimal")

    def test_short_source_sha_is_rejected(self):
        proc = self.run_runner(**{"--source-sha": "abc123"})
        self.assert_refused(proc, "--source-sha must be a Git object hash")

    def test_receipt_dir_must_match_platform_and_attempt(self):
        wrong = self.root / "out" / "signed-consumer-darwin-arm64-attempt-2" / "receipt.json"
        proc = self.run_runner(**{"--receipt-out": wrong})
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("signed receipt directory must be", proc.stderr)
        self.assertFalse(wrong.exists())

    def test_platform_missing_from_index_is_rejected(self):
        for name in ("prev", "cand"):
            Path(self.root / f"{name}.tar.gz.sigstore.json").write_text("{}")
        proc = self.run_runner(**{"--platform": "linux-x64",
                                  "--receipt-out": self.root / "out" / "signed-consumer-linux-x64-attempt-1" / "receipt.json"})
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn("has no asset for platform linux-x64", proc.stderr)

    def test_existing_receipt_is_never_overwritten(self):
        self.receipt.parent.mkdir(parents=True)
        self.receipt.write_text("stale")
        proc = self.run_runner()
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn("receipt path already exists", proc.stderr)
        self.assertEqual(self.receipt.read_text(), "stale")


if __name__ == "__main__":
    unittest.main()
