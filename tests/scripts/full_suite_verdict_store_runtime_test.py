#!/usr/bin/env python3
"""RUNTIMEMISS1 (ompkit-fp72.120.16.242): a PASS stored under another runtime id reads RUNTIME_MISMATCH, never MISS.

0.2.91: the lead's PATH had agent-bin first, the push-time verdict ran without it, the env digests differed and both
store reads came back MISS, so release-local reported VERDICT_STARVED and re-ran a 15 min suite for a passed tree.
Run: python3 -B tests/scripts/full_suite_verdict_store_runtime_test.py
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import kitlib_tmp  # noqa: E402  (owned temp dirs, removed on exit)

spec = importlib.util.spec_from_file_location("verdict_store", ROOT / "scripts" / "full-suite-verdict-store.py")
store = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(store)
metrics = store.load_metrics(ROOT)

PREFIX = "Darwin/arm64/bun-1.3.0/python-3.12.0"
EXTRA = "/Users/seat/.local/share/omp-kit/agent-bin"
ENV_A = {"FULL_SUITE_RUNTIME_ID": "", "FULL_SUITE_TIMEOUT_SECS": "1800", "GIT_EXEC_PATH": "/usr/libexec/git-core",
         "LANG": "C", "PATH": os.pathsep.join(("/opt/homebrew/bin", "/usr/bin", "/bin"))}
ENV_B = {**ENV_A, "PATH": os.pathsep.join((EXTRA, ENV_A["PATH"]))}
RUNTIME_A = f"{PREFIX}/env-{metrics.environment_digest(ENV_A)}"
RUNTIME_B = f"{PREFIX}/env-{metrics.environment_digest(ENV_B)}"


def plant(directory: Path) -> Path:
    """A PASS record judged under runtime A, named as the store names it."""
    path = directory / f"{'a' * 40}.main.0001.json"
    path.write_text(json.dumps({"runtime": RUNTIME_A, "verdict": "PASS"}), encoding="utf-8")
    return path


def accept(path: Path, stored: str) -> tuple[dict | None, str]:
    entry = json.loads(path.read_text(encoding="utf-8"))
    return (entry, "VALID") if entry["runtime"] == stored else (None, "runtime mismatch")


class RuntimeMismatch(unittest.TestCase):
    def test_planted_extra_path_entry_reads_runtime_mismatch(self) -> None:
        with kitlib_tmp.owned_tmp("verdict-runtime") as tmp:
            plant(Path(tmp))
            others = store.other_runtime_records(Path(tmp).glob("*.json"), RUNTIME_B, accept)
        result = store.read_back(None, others, metrics, PREFIX, ENV_B)
        self.assertTrue(result.startswith("RUNTIME_MISMATCH"), result)
        self.assertIn("PATH added " + EXTRA, result)
        self.assertIn("env-" + RUNTIME_A.rsplit("-", 1)[1], result)
        self.assertIn("env-" + RUNTIME_B.rsplit("-", 1)[1], result)
        self.assertNotEqual(result, "PASS")

    def test_control_same_runtime_reads_pass(self) -> None:
        with kitlib_tmp.owned_tmp("verdict-runtime") as tmp:
            entry, _reason = accept(plant(Path(tmp)), RUNTIME_A)
            others = store.other_runtime_records(Path(tmp).glob("*.json"), RUNTIME_A, accept)
        self.assertEqual(others, [])
        self.assertEqual(store.read_back(entry, others, metrics, PREFIX, ENV_A), "PASS")

    def test_mutant_without_scan_reads_miss(self) -> None:
        with kitlib_tmp.owned_tmp("verdict-runtime") as tmp:
            plant(Path(tmp))
        self.assertEqual(store.read_back(None, [], metrics, PREFIX, ENV_B), "MISS")

    def test_version_field_difference_is_named(self) -> None:
        result = store.describe_runtime_mismatch(metrics, RUNTIME_A, PREFIX.replace("bun-1.3.0", "bun-1.3.1"), ENV_A)
        self.assertIn("bun bun-1.3.0 -> bun-1.3.1", result)


if __name__ == "__main__":
    unittest.main(verbosity=2)
