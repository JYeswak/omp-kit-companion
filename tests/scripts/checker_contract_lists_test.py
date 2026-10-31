#!/usr/bin/env python3
"""Exercise checker-contract fixture seeds against a planted gate-only addition."""
from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[2]


def _load(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


kitlib_tmp = _load("kitlib_tmp", ROOT / "scripts" / "kitlib_tmp.py")
kitlib_run = _load("kitlib_run", ROOT / "scripts" / "kitlib_run.py")


def _run_suite(path: Path, env: dict[str, str]) -> tuple[int, str]:
    result = kitlib_run.run(
        ["sh", str(path)],
        deadline_s=180,
        cwd=ROOT,
        env=env,
        stdin=b"",
    )
    output = (result.stdout + result.stderr).decode("utf-8", errors="replace")
    if result.timed_out:
        return 124, f"{output}\nkitlib-run: suite exceeded 180s"
    if result.rc is None:
        return 125, f"{output}\nkitlib-run: process exit status unavailable"
    return result.rc, output


class CheckerContractFixtureLists(unittest.TestCase):
    def test_both_fixture_seed_lists_reject_a_gate_only_checker(self) -> None:
        scratch_root = ROOT / "var" / "agent-tmp"
        scratch_root.mkdir(parents=True, exist_ok=True)
        with kitlib_tmp.owned_tmp("checker-list-drift", root=str(scratch_root)) as scratch:
            work = Path(scratch)
            gate_override = work / "pre-push-gate-with-planted-checker.sh"
            gate = (ROOT / "scripts" / "pre-push-gate.sh").read_text(encoding="utf-8")
            marker = "\tcheck-staged-br-init.test.sh"
            gate_override.write_text(
                gate.replace(
                    marker,
                    "\tchecker-list-drift-probe.test.sh \\\n" + marker,
                    1,
                ),
                encoding="utf-8",
            )
            gate_override.chmod(0o755)

            for suite_name, override_name in (
                ("pre-push-gate.test.sh", "OMP_KIT_PRE_PUSH_ADAPTER"),
                ("savefirst-pre-push.test.sh", "OMP_KIT_TEST_GATE_OVERRIDE"),
            ):
                with self.subTest(suite=suite_name):
                    suite = ROOT / "tests" / "cli" / suite_name
                    env = os.environ.copy()
                    env["TMPDIR"] = str(work)
                    env["OMP_KIT_CHECKER_CONTRACT_DRIFT_PROBE"] = "1"
                    env["OMP_KIT_CASE_CWD"] = str(ROOT)
                    env.pop("OMP_KIT_PRE_PUSH_ADAPTER", None)
                    env.pop("OMP_KIT_TEST_GATE_OVERRIDE", None)

                    rc, output = _run_suite(suite, env)
                    self.assertEqual(rc, 0, f"unmodified gate control failed:\n{output}")
                    self.assertIn("checker-contract fixture control PASS", output)

                    env[override_name] = str(gate_override)
                    rc, output = _run_suite(suite, env)
                    self.assertNotEqual(rc, 0, f"gate-only checker unexpectedly passed:\n{output}")
                    self.assertIn(
                        "pre-push-gate: missing checker contract checker-list-drift-probe.test.sh",
                        output,
                    )


if __name__ == "__main__":
    unittest.main()
