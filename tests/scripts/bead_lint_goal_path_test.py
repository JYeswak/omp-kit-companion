#!/usr/bin/env python3
"""Retirement controls through real create/update gates and native readiness.

Large acyclic graphs, reference mentions and epic children need no synthetic
placement edge. Real prerequisites, cycles and closed work remain native br's
responsibility; acceptance replay remains covered by bead_lint_test.py and
 tests/cli/verify.test.ts.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
import bead_lint
import kitlib_tmp
from pysafe import run_bounded

REAL_BR = shutil.which("br")
POST = "2026-10-31T00:00:00Z"
DESC = "WHAT: implement the widget. WHY: preserve requested behavior."
ACC = "- [ ] [a] [build] widget builds `true` -> rc 0; planted negative: bad input refused"


class LiveGates(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not REAL_BR:
            raise RuntimeError("native br is required on PATH")
        cls.work = kitlib_tmp.owned_tmp("retired-lint-gates")
        cls.root = Path(cls.work.path)
        cls.repo = cls.root / "tracker"
        cls.repo.mkdir()
        cls.db = str(cls.repo / ".beads" / "beads.db")
        cls.env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(cls.root),
                   "XDG_STATE_HOME": str(cls.root / "state"),
                   "OMP_KIT_FLEET_WATCH_CONFIG": str(cls.root / "no-fleet.json")}
        cls.br("init", "--prefix", "fx")

        def bead(bid, *, labels=(), deps=(), status="open", desc=DESC):
            row = bead_lint.mkbead(bid, labels=list(labels), desc=desc, acc=ACC,
                                   created_at=POST, deps=list(deps), comments=[], status=status)
            row.update(title=bid, updated_at=POST, source_repo=".", created_by="RetireTest")
            row.pop("source_repo_path", None)
            return row

        dep = bead_lint.dep_to
        rows = [bead("fx-goal", labels=["kind:goal"]),
                bead("fx-child", deps=[dep("fx-child", "fx-goal", "parent-child")]),
                bead("fx-loose"),
                bead("fx-mention", desc=DESC + " Historical reference: fx-loose."),
                bead("fx-blocked", deps=[dep("fx-blocked", "fx-loose")]),
                bead("fx-closed", status="closed"),
                bead("fx-held", status="in_progress"),
                bead("fx-root")]
        rows[-2]["assignee"] = "PeerOwner"
        for index in range(25):
            bid = f"fx-fan{index}"
            rows.append(bead(bid, deps=[dep(bid, "fx-root")]))
        for index in range(6):
            bid = f"fx-deep{index}"
            target = "fx-root" if index == 0 else f"fx-deep{index - 1}"
            rows.append(bead(bid, deps=[dep(bid, target)]))
        (cls.repo / ".beads" / "issues.jsonl").write_text(
            "".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        cls.br("sync", "--import-only")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.work.cleanup()

    @classmethod
    def native(cls, *args):
        return run_bounded([REAL_BR, *args, "--db", cls.db], 60, env=cls.env, cwd=str(cls.repo))

    @classmethod
    def br(cls, *args):
        result = cls.native(*args)
        if result.returncode != 0:
            raise RuntimeError(f"br {args} rc={result.returncode}: {result.stderr.decode()}")
        return result.stdout.decode()

    def update(self, bid):
        env = dict(self.env, BR_UPDATE_REAL=REAL_BR, BR_UPDATE_PROJECT=str(self.repo), BR_UPDATE_DB=self.db)
        result = run_bounded([sys.executable, str(SCRIPTS / "br-update-lint.py"),
                              "update", bid, "--description", DESC], 120, env=env, cwd=str(self.repo))
        return result.returncode, result.stderr.decode()

    def guard(self, *args):
        entry = self.root / "entry.sh"
        entry.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        entry.chmod(0o700)
        env = dict(self.env, BR_SHIM_REAL=REAL_BR, BR_SHIM_PROJECT=str(self.repo), BR_SHIM_DB=self.db,
                   BR_SHIM_AGENT="RetireTest", BR_SHIM_ENTRY=str(entry))
        result = run_bounded([sys.executable, str(SCRIPTS / "br-create-guard.py"), "create", *args,
                              "--db", self.db, "--actor", "RetireTest"], 120, env=env, cwd=str(self.repo))
        return result.returncode, result.stdout.decode() + result.stderr.decode()

    def ready_ids(self):
        rows = json.loads(self.br("ready", "--json", "--limit", "0"))
        rows = rows.get("issues", rows) if isinstance(rows, dict) else rows
        return {row["id"] for row in rows}

    def test_authorized_create_needs_no_goal_label_or_edge(self):
        rc, out = self.guard("--title", "Independent widget", "-t", "task",
                             "--description", DESC, "--acceptance", ACC)
        self.assertEqual(rc, 0, out)
        rows = json.loads(self.br("list", "--status", "all", "--limit", "0", "--json"))
        rows = rows.get("issues", rows) if isinstance(rows, dict) else rows
        created = next(row for row in rows if row["title"] == "Independent widget")
        self.assertIn(created["id"], self.ready_ids())

    def test_updates_need_no_placement_or_reference_edges(self):
        for bid in ("fx-loose", "fx-child", "fx-mention"):
            with self.subTest(bid=bid):
                self.assertEqual(self.update(bid), (0, ""))

    def test_large_acyclic_graph_is_admitted_but_real_prerequisite_blocks(self):
        self.assertEqual(self.update("fx-root"), (0, ""))
        ready = self.ready_ids()
        self.assertIn("fx-root", ready)
        self.assertNotIn("fx-fan0", ready)
        self.assertNotIn("fx-deep5", ready)
        self.assertNotIn("fx-blocked", ready)
        self.assertIn("fx-loose", ready)

    def test_epic_child_is_ready_but_closed_and_foreign_claims_are_not_available(self):
        ready = self.ready_ids()
        self.assertIn("fx-child", ready)
        self.assertNotIn("fx-closed", ready)
        result = self.native("update", "fx-held", "--claim", "--actor", "OtherWorker")
        self.assertNotEqual(result.returncode, 0, result.stdout.decode() + result.stderr.decode())
        held = json.loads(self.br("show", "fx-held", "--json"))
        held = held[0] if isinstance(held, list) else held
        self.assertEqual(held["assignee"], "PeerOwner")

    def test_native_cycle_is_rejected_with_acyclic_control(self):
        result = self.native("dep", "add", "fx-loose", "fx-blocked")
        self.assertNotEqual(result.returncode, 0, result.stdout.decode() + result.stderr.decode())
        missing = self.native("dep", "add", "fx-loose", "fx-missing")
        self.assertNotEqual(missing.returncode, 0, missing.stdout.decode() + missing.stderr.decode())
        self.br("dep", "add", "fx-loose", "fx-root")
        self.assertNotIn("fx-loose", self.ready_ids())


if __name__ == "__main__":
    unittest.main(verbosity=2)
