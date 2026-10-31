#!/usr/bin/env python3
"""CUTGRAPH1 (ompkit-774u.61) boxes d and f: m-goal-path and the check-f goal exemption.

Check-level cases run over deterministic JSONL-shaped fixtures, each planted
negative beside a paired control. The gate cases build a real tracker with the
native `br` in an owned temp dir and drive the real create guard
(scripts/br-create-guard.py) and update gate (scripts/br-update-lint.py):
an unplaced create and an unplaced update are refused naming the open goal and
the `br dep add` remedy; the placed create and the placed update are admitted.
Native `br` is a hard precondition of this file (the gates call it).

Run: python3 tests/scripts/bead_lint_goal_path_test.py
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
import bead_lint  # noqa: E402
import kitlib_tmp  # noqa: E402  (owned temp dirs: removed on exit and HUP/INT/TERM)
from pysafe import run_bounded  # noqa: E402  (own process group, stdin DEVNULL, hard deadline)

POST = bead_lint.GOAL_PATH_CUTOVER
PRE = "2026-10-30T23:59:59.999999Z"
mk, dep = bead_lint.mkbead, bead_lint.dep_to
DESC = "WHAT: (a) a widget. WHY: needed."
ACC = "- [ ] [a] [build] widget builds `true` -> rc 0; planted negative: bad input refused"


def tracker() -> list[dict]:
    return [
        mk("g-rel", labels=["kind:goal"], deps=[dep("g-rel", "w-gate")]),
        mk("g-shut", status="closed", labels=["kind:goal"], deps=[dep("g-shut", "w-shut")]),
        mk("w-gate", deps=[dep("w-gate", "w-deep")], created_at=POST),
        mk("w-deep", created_at=POST),
        mk("w-shut", created_at=POST),
        mk("w-loose", created_at=POST),
        mk("w-old", created_at=PRE),
        mk("w-parent", created_at=POST, deps=[dep("w-parent", "g-rel", "parent-child")]),
        mk("w-intake", labels=["kind:intake"], created_at=POST),
    ]


def by(rows: list[dict], bid: str) -> dict:
    return next(r for r in rows if r["id"] == bid)


class GoalPath(unittest.TestCase):
    def test_unplaced_refused_naming_goals_and_remedy(self) -> None:
        rows = tracker()
        got = bead_lint.goal_path_failure(by(rows, "w-loose"), rows)
        self.assertEqual(len(got), 1, got)
        self.assertTrue(got[0].startswith("m-goal-path:GOAL_PATH_MISSING w-loose"), got)
        self.assertIn("g-rel", got[0])
        self.assertNotIn("g-shut", got[0])
        self.assertIn("br dep add g-rel w-loose", got[0])

    def test_placed_any_depth_admitted(self) -> None:
        rows = tracker()
        self.assertEqual(bead_lint.goal_path_failure(by(rows, "w-gate"), rows), [])
        self.assertEqual(bead_lint.goal_path_failure(by(rows, "w-deep"), rows), [])

    def test_intake_and_goal_admitted(self) -> None:
        rows = tracker()
        self.assertEqual(bead_lint.goal_path_failure(by(rows, "w-intake"), rows), [])
        self.assertEqual(bead_lint.goal_path_failure(by(rows, "g-rel"), rows), [])

    def test_closed_goal_path_refused(self) -> None:
        rows = tracker()
        self.assertTrue(bead_lint.goal_path_failure(by(rows, "w-shut"), rows))
        # Control: the same bead under the open goal is admitted.
        rows[0]["dependencies"].append(dep("g-rel", "w-shut"))
        self.assertEqual(bead_lint.goal_path_failure(by(rows, "w-shut"), rows), [])

    def test_parent_child_does_not_place(self) -> None:
        rows = tracker()
        self.assertTrue(bead_lint.goal_path_failure(by(rows, "w-parent"), rows))

    def test_create_label_target(self) -> None:
        rows = tracker()
        placed = mk("<new>", labels=["x", "goal-path:w-deep"], created_at=POST)
        under_shut = mk("<new>", labels=["x", "goal-path:w-shut"], created_at=POST)
        bare = mk("<new>", created_at=POST)
        self.assertEqual(bead_lint.goal_path_failure(placed, rows), [])
        self.assertTrue(bead_lint.goal_path_failure(under_shut, rows))
        got = bead_lint.goal_path_failure(bare, rows)
        self.assertTrue(got and "g-rel" in got[0] and "br dep add g-rel <NEW_ID>" in got[0], got)

    def test_tracker_without_goal_not_judged(self) -> None:
        rows = [r for r in tracker() if not bead_lint.is_goal(r)]
        self.assertEqual(bead_lint.goal_path_failure(by(rows, "w-loose"), rows), [])

    def test_report_splits_enforced_and_legacy(self) -> None:
        self.assertEqual(bead_lint.goal_path_report(tracker()), {
            "enforced": ["w-loose", "w-parent", "w-shut"], "legacy": ["w-old"]})

    def test_lint_bead_failures_needs_graph(self) -> None:
        rows = tracker()
        bead = by(rows, "w-loose")
        ids = {r["id"] for r in rows}
        self.assertFalse(any(f.startswith("m-goal-path") for f in bead_lint.lint_bead_failures(bead, ids)))
        self.assertTrue(any(f.startswith("m-goal-path")
                            for f in bead_lint.lint_bead_failures(bead, ids, graph=rows)))


class CheckF(unittest.TestCase):
    def test_goal_with_23_blockers_and_23_dependents_passes(self) -> None:
        beads = [mk("goal", labels=["kind:goal"], deps=[dep("goal", f"b{n:02d}") for n in range(23)])]
        beads += [mk(f"b{n:02d}") for n in range(23)]
        beads += [mk(f"k{n:02d}", deps=[dep(f"k{n:02d}", "goal")]) for n in range(23)]
        self.assertEqual(bead_lint.check_f(beads)[0], [])
        # Control: the same fan without the goal label is refused.
        beads[0]["labels"] = ["selftest"]
        self.assertIn("goal", bead_lint.check_f(beads)[0])

    def test_train_to_train_link_passes(self) -> None:
        def train(n: int, prev: str | None) -> list[dict]:
            gid = f"t{n}"
            deps = [dep(gid, f"t{n}w0")] + ([dep(gid, prev)] if prev else [])
            work = [mk(f"t{n}w{i}", deps=[dep(f"t{n}w{i}", f"t{n}w{i + 1}")] if i < 3 else [])
                    for i in range(4)]
            return [mk(gid, labels=["kind:goal"], deps=deps)] + work
        beads = train(1, None) + train(2, "t1") + train(3, "t2")
        self.assertEqual(bead_lint.check_f(beads)[0], [])
        # Control: unlabel the trains and the same links chain past 4.
        for b in beads:
            b["labels"] = ["selftest"]
        self.assertTrue(bead_lint.check_f(beads)[0])

    def test_deep_work_chain_below_goal_refused(self) -> None:
        beads = [mk("goal", labels=["kind:goal"], deps=[dep("goal", "c0")])]
        beads += [mk(f"c{n}", deps=[dep(f"c{n}", f"c{n + 1}")] if n < 5 else []) for n in range(6)]
        bad, detail = bead_lint.check_f(beads)
        self.assertIn("c0", bad)
        self.assertEqual(detail["c0"], "chain depth 5 > 4")
        # Control: four deep is admitted.
        beads = [mk("goal", labels=["kind:goal"], deps=[dep("goal", "c0")])]
        beads += [mk(f"c{n}", deps=[dep(f"c{n}", f"c{n + 1}")] if n < 4 else []) for n in range(5)]
        self.assertNotIn("c0", bead_lint.check_f(beads)[0])


REAL_BR = shutil.which("br")


class LiveGates(unittest.TestCase):
    """Real create guard and update gate over a real native-br fixture tracker."""

    @classmethod
    def setUpClass(cls) -> None:
        if not REAL_BR:
            raise RuntimeError("native br is required on PATH for the live gate cases")
        cls.work = kitlib_tmp.owned_tmp("goal-path-gates")
        cls.root = Path(cls.work.path)
        cls.repo = cls.root / "tracker"
        cls.repo.mkdir()
        cls.db = str(cls.repo / ".beads" / "beads.db")
        cls.env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(cls.root),
                   "XDG_STATE_HOME": str(cls.root / "state"),
                   "OMP_KIT_FLEET_WATCH_CONFIG": str(cls.root / "no-fleet.json")}
        cls.br("init", "--prefix", "fx")
        # created_at is pinned by importing JSONL through native br, so the
        # post-cutover and legacy cases hold whatever the wall clock says.
        def bead(bid: str, title: str, labels: list[str], at: str, deps=(), desc: str = DESC) -> dict:
            edges = [dep(bid, *d) if isinstance(d, tuple) else dep(bid, d) for d in deps]
            row = mk(bid, labels=labels, desc=desc, acc=ACC, created_at=at, deps=edges, comments=[])
            row.update(title=title, updated_at=at, source_repo=".", created_by="GoalPathTest")
            row.pop("source_repo_path", None)
            return row
        rows = [bead("fx-goal", "Release goal for the next train", ["kind:goal"], POST,
                     ["fx-onpath.2", "fx-mention", "fx-stray"]),
                bead("fx-onpath.2", "Release gate checks the installed hooks", ["fixture"], POST),
                bead("fx-loose", "Loose bead with no goal", ["fixture"], POST),
                bead("fx-legacy", "Legacy bead with no goal", ["fixture"], PRE),
                # i-mention-edges: fx-mention names two beads whose only edges point AT it
                # (incoming related and parent-child), the ompkit-9t6f2 shape.
                bead("fx-mention", "Bead mentioning its linked peers", ["fixture"], POST,
                     desc="WHAT: (a) a widget, see fx-peer and fx-kid. WHY: needed."),
                bead("fx-peer", "Peer pointing at the mentioning bead", ["kind:intake"], POST,
                     [("fx-mention", "related")]),
                bead("fx-kid", "Child of the mentioning bead", ["kind:intake"], POST,
                     [("fx-mention", "parent-child")]),
                # Planted negative: a mention with no edge either way.
                bead("fx-stray", "Bead mentioning an unlinked bead", ["fixture"], POST,
                     desc="WHAT: (a) a widget, see fx-loose. WHY: needed.")]
        (cls.repo / ".beads" / "issues.jsonl").write_text(
            "".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
        cls.br("sync", "--import-only")
        cls.goal, cls.on_path, cls.loose, cls.legacy = "fx-goal", "fx-onpath.2", "fx-loose", "fx-legacy"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.work.cleanup()

    @classmethod
    def br(cls, *args: str) -> str:
        res = run_bounded([REAL_BR, *args, "--db", cls.db], 60, env=cls.env, cwd=str(cls.repo))
        if res.returncode != 0:
            raise RuntimeError(f"br {args} rc={res.returncode}: {res.stderr.decode()[:400]}")
        return res.stdout.decode()

    def guard(self, *argv: str) -> tuple[int, str]:
        entry = self.root / "entry.sh"
        entry.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        entry.chmod(0o700)
        env = dict(self.env, BR_SHIM_REAL=REAL_BR, BR_SHIM_PROJECT=str(self.repo),
                   BR_SHIM_DB=self.db, BR_SHIM_AGENT="GoalPathTest", BR_SHIM_ENTRY=str(entry))
        res = run_bounded([sys.executable, str(SCRIPTS / "br-create-guard.py"), "create", *argv,
                           "--db", self.db, "--actor", "GoalPathTest"], 120, env=env, cwd=str(self.repo))
        return res.returncode, res.stdout.decode() + res.stderr.decode()

    def update(self, bead_id: str, *edit: str) -> tuple[int, str]:
        env = dict(self.env, BR_UPDATE_REAL=REAL_BR, BR_UPDATE_PROJECT=str(self.repo),
                   BR_UPDATE_DB=self.db)
        res = run_bounded([sys.executable, str(SCRIPTS / "br-update-lint.py"), "update", bead_id,
                           *(edit or ("--description", DESC + " Edited."))],
                          120, env=env, cwd=str(self.repo))
        return res.returncode, res.stderr.decode()

    def test_mention_with_incoming_edges_admitted_on_label_add(self) -> None:
        rc, err = self.update("fx-mention", "--add-label", "needs-director")
        self.assertEqual(rc, 0, err)
        self.assertNotIn("LINT_REFUSED", err)
        self.assertNotIn("UNVERIFIED", err)

    def test_mention_without_edge_refused_on_label_add(self) -> None:
        rc, err = self.update("fx-stray", "--add-label", "needs-director")
        self.assertEqual(rc, 4, err)
        self.assertIn("i-mention-edges", err)

    def create_args(self, title: str, labels: str) -> list[str]:
        return ["--title", title, "-t", "task", "-l", labels,
                "--description", DESC, "--acceptance", ACC]

    def test_unplaced_create_refused_through_real_guard(self) -> None:
        rc, out = self.guard(*self.create_args("Unplaced widget work", "fixture"))
        self.assertEqual(rc, 4, out)
        self.assertIn("LINT_REFUSED", out)
        self.assertIn("m-goal-path:GOAL_PATH_MISSING", out)
        self.assertIn(self.goal, out)
        self.assertIn(f"br dep add {self.goal} <NEW_ID>", out)

    def test_dotted_target_create_admitted_and_stored_through_real_guard(self) -> None:
        label = "goal-path:" + bead_lint.encode_goal_path_id(self.on_path)
        self.assertEqual(label, "goal-path:fx-onpath_2")
        rc, out = self.guard(*self.create_args("Placed widget work", f"fixture,{label}"))
        self.assertEqual(rc, 0, out)
        self.assertNotIn("m-goal-path", out)
        self.assertNotIn("UNVERIFIED", out)
        # Native br stored it: the encoded label passes br's label validation.
        listed = json.loads(self.br("list", "--status", "all", "--limit", "0", "--json"))
        listed = listed.get("issues", listed) if isinstance(listed, dict) else listed
        stored = [r for r in listed if r["title"] == "Placed widget work"]
        self.assertEqual(len(stored), 1, stored)
        self.assertIn(label, stored[0]["labels"])

    def test_raw_dotted_label_is_refused_by_native_br(self) -> None:
        # Planted negative: the unencoded dotted id passes the lint (it decodes the
        # same) but native br refuses the label, so the placer must never print it.
        rc, out = self.guard(*self.create_args("Raw dotted label work",
                                               f"fixture,goal-path:{self.on_path}"))
        self.assertNotEqual(rc, 0, out)
        self.assertNotIn("m-goal-path", out)

    def test_label_codec(self) -> None:
        enc, dec = bead_lint.encode_goal_path_id, bead_lint.decode_goal_path_id
        for bid in ("ompkit-774u.60", "ompkit-fp72.135.3.71", "fx-goal", "a_b-c.4"):
            self.assertEqual(dec(enc(bid)), bid)
        self.assertEqual(enc("ompkit-fp72.135.3.71"), "ompkit-fp72_135_3_71")
        self.assertEqual(dec("a_b"), "a_b")
        self.assertEqual(dec("x_１"), "x_１")

    def test_intake_create_admitted_through_real_guard(self) -> None:
        rc, out = self.guard(*self.create_args("Intake widget work", "kind:intake"))
        self.assertEqual(rc, 0, out)
        self.assertNotIn("UNVERIFIED", out)

    def test_unplaced_update_refused_through_real_gate(self) -> None:
        rc, err = self.update(self.loose)
        self.assertEqual(rc, 4, err)
        self.assertIn("m-goal-path", err)
        self.assertIn(f"br dep add {self.goal} {self.loose}", err)

    def test_placed_update_admitted_through_real_gate(self) -> None:
        rc, err = self.update(self.on_path)
        self.assertEqual(rc, 0, err)
        self.assertNotIn("UNVERIFIED", err)

    def test_legacy_update_admitted_with_warning(self) -> None:
        rc, err = self.update(self.legacy)
        self.assertEqual(rc, 0, err)
        self.assertIn(f"GOAL_PATH_LEGACY {self.legacy}", err)
        self.assertIn(f"br dep add {self.goal} {self.legacy}", err)
        self.assertNotIn("UNVERIFIED", err)


if __name__ == "__main__":
    unittest.main(verbosity=2)
