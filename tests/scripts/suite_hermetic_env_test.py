#!/usr/bin/env python3
"""PLANFIRST1: measured test children cannot inherit the parent gate's authority."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from kitlib_run import run
from kitlib_tmp import owned_tmp


class SuiteHermeticEnvironmentTests(unittest.TestCase):
    def test_gate_controls_are_absent_and_normal_control_survives_in_both_modes(self) -> None:
        # These are pre-push's stage exports, plus a future key proving the whole namespace is private.
        gate_controls = {name: "caller-gate-authority" for name in (
            "FRESH_GATE_REPO", "FRESH_GATE_LEDGER", "FRESH_GATE_PASSED_OUT",
            "FRESH_GATE_PASSED_IN", "FRESH_GATE_TEST_BUDGET_SECS", "FRESH_GATE_SKIP_REGEX",
            "FRESH_GATE_FUTURE_CONTROL",
        )}
        for mode in ("0", "1"):
            with self.subTest(hermetic=mode), owned_tmp(
                "suite-gate-env-test", root=str(ROOT / "var/agent-tmp")
            ) as directory:
                archive, scratch = Path(directory) / "archive", Path(directory) / "scratch"
                archive.mkdir()
                scratch.mkdir()
                result = run([
                    "sh", str(ROOT / "scripts/suite-hermetic-env.sh"),
                    "--archive", str(archive), "--scratch", str(scratch), "--suite", "gate-env-test",
                    "--allow-env", "PLANFIRST_CONTROL", "--allow-env", "FRESH_GATE_REPO", "--",
                    sys.executable, "-c",
                    "import json,os; print(json.dumps({'gate': sorted(k for k in os.environ "
                    "if k.startswith('FRESH_GATE_')), 'control': os.environ.get('PLANFIRST_CONTROL')}))",
                ], cwd=str(archive), deadline_s=10, env={
                    **os.environ, **gate_controls, "PLANFIRST_CONTROL": "retained",
                    "OMP_KIT_SUITE_HERMETIC_ENABLE": mode, "OMP_KIT_SUITE_FENCE_ENABLE": "0",
                })
                self.assertEqual(result.rc, 0, result.stderr)
                child = json.loads(result.stdout.decode().splitlines()[-1])
                self.assertEqual(child["gate"], [], "a nested fixture must not borrow parent gate authority")
                self.assertEqual(child["control"], "retained")


if __name__ == "__main__":
    unittest.main()
