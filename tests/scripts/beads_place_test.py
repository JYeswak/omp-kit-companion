#!/usr/bin/env python3
"""CUTGRAPH1 (ompkit-774u.61) box e: scripts/beads_place.py placement.

A deterministic two-goal fixture tracker (JSONL in an owned temp dir, read via
--db): a release-gate title must land under the release goal on the gate bead,
with the dep-add step pointing the target at the new bead; a docs title under
the same tracker lands on the docs goal (paired control); a tracker with no
open goal exits 3 (planted negative); the script is read-only.

Run: python3 tests/scripts/beads_place_test.py
"""
from __future__ import annotations

import hashlib
import json
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
import beads_place  # noqa: E402
import kitlib_tmp  # noqa: E402  (owned temp dirs: removed on exit and HUP/INT/TERM)
from pysafe import run_bounded  # noqa: E402


def row(bid: str, title: str, labels=(), deps=(), status: str = "open", desc: str = "") -> dict:
    return {"id": bid, "title": title, "status": status, "labels": list(labels), "description": desc,
            "dependencies": [{"issue_id": bid, "depends_on_id": d, "type": t} for d, t in deps]}


ROWS = [
    row("fx-epic", "Release substrate epic"),
    row("fx-rel", "Release train 7 ships when the release gate passes", ["kind:goal"],
        [("fx-rel.1", "blocks"), ("fx-pin", "blocks")]),
    row("fx-rel.1", "Release gate refuses a candidate without a full-suite pass", deps=[("fx-epic", "parent-child")]),
    row("fx-pin", "Pin installed hooks to the release version"),
    row("fx-docs", "Documentation site explains every verb", ["kind:goal"], [("fx-guide", "blocks")]),
    row("fx-guide", "Write the operator guide pages for the docs site"),
    row("fx-shut", "Closed release goal from the last train", ["kind:goal"], [("fx-old", "blocks")], status="closed"),
    row("fx-old", "Release gate candidate pass for the previous train release gate", status="closed"),
]


class Place(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.work = kitlib_tmp.owned_tmp("beads-place-test")
        cls.db = Path(cls.work.path) / "issues.jsonl"
        cls.db.write_text("".join(json.dumps(r) + "\n" for r in ROWS), encoding="utf-8")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.work.cleanup()

    def run_cli(self, *args: str, db: Path | None = None) -> tuple[int, dict]:
        res = run_bounded([sys.executable, str(SCRIPTS / "beads_place.py"), *args,
                           "--db", str(db or self.db), "--json"], 60, cwd=str(ROOT))
        return res.returncode, json.loads(res.stdout.decode())

    def test_release_gate_title_picks_release_goal(self) -> None:
        before = hashlib.sha256(self.db.read_bytes()).hexdigest()
        rc, out = self.run_cli("--title", "release gate must check the candidate suite pass")
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["goal"]["id"], "fx-rel")
        self.assertEqual(out["target"]["id"], "fx-rel.1")
        self.assertEqual(out["parent"], "fx-epic")
        self.assertIn("--labels goal-path:fx-rel_1", out["commands"][0])
        self.assertIn("--parent fx-epic", out["commands"][0])
        self.assertNotIn("--deps", out["commands"][0])
        self.assertEqual(out["commands"][1], "br dep add fx-rel.1 <NEW_ID>")
        self.assertNotIn("fx-shut", [r["goal"] for r in out["ranking"]])
        self.assertEqual(hashlib.sha256(self.db.read_bytes()).hexdigest(), before)

    def test_docs_title_picks_docs_goal(self) -> None:
        rc, out = self.run_cli("--title", "operator guide page for the docs site")
        self.assertEqual(rc, 0, out)
        self.assertEqual((out["goal"]["id"], out["target"]["id"]), ("fx-docs", "fx-guide"))
        self.assertEqual(out["commands"][1], "br dep add fx-guide <NEW_ID>")

    def test_no_open_goal_exits_3(self) -> None:
        bare = Path(self.work.path) / "bare.jsonl"
        bare.write_text("".join(json.dumps(r) + "\n" for r in ROWS
                                if "kind:goal" not in r["labels"]), encoding="utf-8")
        rc, out = self.run_cli("--title", "release gate", db=bare)
        self.assertEqual((rc, out["verdict"]), (3, "NO_OPEN_GOAL"))
        self.assertIn("kind:intake", out["advice"])

    def test_tokenizer_linear_on_long_near_miss(self) -> None:
        self.assertEqual(beads_place.tokens("The Release-gate, v2!"), ["release", "gate", "v2"])
        self.assertEqual(beads_place.tokens("a ! ? of"), [])
        start = time.monotonic()
        beads_place.tokens("a-" * 200_000 + "!")
        self.assertLess(time.monotonic() - start, 2.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
