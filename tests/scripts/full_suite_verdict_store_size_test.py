#!/usr/bin/env python3
"""VERDICTSIZE1: a verdict record larger than 1 MiB reads back; a record past the bound still refuses.

The 2026-11-02 main-role records reached 1,065,616 bytes, and json_value() refused every one of them at the old
1 MiB bound, so release-local read each full-suite PASS as MISS. Run: python3 tests/scripts/full_suite_verdict_store_size_test.py
"""
from __future__ import annotations

import importlib.util
import json
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


class RecordSize(unittest.TestCase):
    def test_measured_size_reads_back(self) -> None:
        with kitlib_tmp.owned_tmp("verdict-size") as tmp:
            path = Path(tmp) / "record.json"
            path.write_text(json.dumps({"verdict": "PASS", "evidence": {"files": ["x" * 1_100_000]}}), encoding="utf-8")
            self.assertGreater(path.stat().st_size, 1 << 20)
            self.assertEqual(store.json_value(path)["verdict"], "PASS")

    def test_planted_negative_past_bound_refuses(self) -> None:
        with kitlib_tmp.owned_tmp("verdict-size") as tmp:
            path = Path(tmp) / "record.json"
            path.write_text(json.dumps({"verdict": "PASS", "pad": "x" * (store.MAX_RECORD_BYTES + 1)}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "bounded regular file"):
                store.json_value(path)


if __name__ == "__main__":
    unittest.main(verbosity=2)
