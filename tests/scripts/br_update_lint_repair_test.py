#!/usr/bin/env python3
"""LINTREPAIR (ompkit-fp72.135.3.50): repair admission in br-update-lint.py.

A content edit to a bead that fails bead-lint is admitted when the checks it
fails afterwards are a strict subset of the checks it failed before (it
repairs something and breaks nothing). Everything else keeps today's
contract: an edit that adds a failure or repairs nothing is refused, a
content edit combined with --claim or --status gets no repair admission, and
a standalone claim passes through unlinted as before.

Runs the real scripts/br-update-lint.py CLI against a fake `br`
(BR_UPDATE_REAL) serving one bead, the same harness as ac_phase_test.py.

Run: python3 tests/scripts/br_update_lint_repair_test.py
"""
from __future__ import annotations

import json
import os
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
import bead_lint  # noqa: E402
import kitlib_tmp  # noqa: E402  (owned temp dirs: removed on exit and HUP/INT/TERM)
from pysafe import run_bounded  # noqa: E402  (cancel-safe spawn: own process group, stdin DEVNULL, hard deadline)

UPDATE_LINT = str(SCRIPTS / "br-update-lint.py")
ENFORCED_AT = "2026-10-24T00:00:00.000001Z"
CODE_ACC = (
    "- [ ] [a] [build] parser handles tags; planted negative: an untagged line is refused\n"
    "- [ ] [a] [landed] on origin/main"
)
# An open time item beside code items: elapsed-time-mix, which a description
# edit cannot repair (its fix is a split or a checker change).
MIXED_ACC = CODE_ACC + "\n- [ ] [b] [after 7d] measured over 7 days; planted negative: a one-day sample is rejected"
BAD_DESC = "no sections here"
GOOD_DESC = "WHAT: (a) gate parser tags; (b) measure the gate. WHY: early submissions bounce."
# Lettered scope matches CODE_ACC's single letter, so this bead fails nothing.
CLEAN_DESC = "WHAT: (a) gate parser tags. WHY: early submissions bounce."
FAKE_BR = """#!/usr/bin/env python3
import json, os, sys
if os.environ.get("FAKE_BR_FAIL"):
    sys.exit(5)
beads = json.load(open(os.environ["FAKE_BR_BEAD"], encoding="utf-8"))
beads = beads if isinstance(beads, list) else [beads]
args = sys.argv[1:]
if "list" in args:
    print(json.dumps(beads))
    sys.exit(0)
if "show" in args:
    print(json.dumps([bead for bead in beads if bead["id"] in args][:1]))
    sys.exit(0)
sys.exit(2)
"""
# Every spelling of a claim move (CLAIMLINT ompkit-fp72.135.3.50 [b]).
CLAIM_MOVES = (("--claim",), ("--status", "in_progress"), ("-s", "in_progress"), ("--status=in_progress",))


def fixture(desc: str = BAD_DESC, acc: str = MIXED_ACC, bead_id: str = "rpr-1") -> dict:
    return {
        "id": bead_id, "title": "Repair admission fixture", "status": "open", "priority": 2,
        "issue_type": "task", "labels": ["gate"], "description": desc, "acceptance_criteria": acc,
        "created_at": ENFORCED_AT, "assignee": None, "dependencies": [],
    }


def checks(bead: dict) -> list[str]:
    return sorted({f.split(":", 1)[0] for f in bead_lint.lint_bead_failures(bead, {bead["id"]})})


class RepairAdmission(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.work = kitlib_tmp.owned_tmp("br-update-repair-test")
        cls.root = Path(cls.work.path)
        cls.fake_br = cls.root / "br"
        cls.fake_br.write_text(FAKE_BR, encoding="utf-8")
        cls.fake_br.chmod(0o700)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.work.cleanup()

    def run_update(self, bead: dict | list[dict], *flags: str, new_desc: str | None = None,
                   fail: bool = False) -> tuple[int, str]:
        beads = bead if isinstance(bead, list) else [bead]
        state = self.root / f"state-{self.id().rsplit('.', 1)[-1]}-{time.monotonic_ns()}"
        (state / ".beads").mkdir(parents=True)
        bead_file = state / "bead.json"
        bead_file.write_text(json.dumps(beads), encoding="utf-8")
        argv = ["update", *(item["id"] for item in beads), *flags]
        if new_desc is not None:
            desc_file = state / "desc.md"
            desc_file.write_text(new_desc, encoding="utf-8")
            argv += ["--description-file", str(desc_file)]
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(state),
            "XDG_STATE_HOME": str(state),
            "BR_UPDATE_REAL": str(self.fake_br),
            "BR_UPDATE_PROJECT": str(state),
            "FAKE_BR_BEAD": str(bead_file),
            **({"FAKE_BR_FAIL": "1"} if fail else {}),
        }
        result = run_bounded([sys.executable, UPDATE_LINT, *argv], 60, env=env, cwd=str(state))
        self.assertEqual(result.outcome, "OK")
        return result.returncode, result.stderr.decode("utf-8", "replace")

    def refused_checks(self, err: str) -> list[str]:
        """The check NAMES on the one LINT_REFUSED line. Entries carry details
        ('elapsed-time-mix:<item text>') that may hold commas, so names are
        matched against the checker's own list rather than split."""
        lines = [line for line in err.splitlines() if "LINT_REFUSED " in line]
        self.assertEqual(len(lines), 1, err)
        listed = lines[0].split("LINT_REFUSED ", 1)[1].split(": this ", 1)[0]
        known = (*bead_lint.GATE_CHECKS, "br-lint-template")
        return sorted(name for name in known if listed.startswith(name) or f",{name}" in listed)

    def test_fixture_failure_sets_are_what_the_cases_assume(self) -> None:
        self.assertEqual(checks(fixture()), ["b-what-why-acc", "elapsed-time-mix"])
        self.assertEqual(checks(fixture(GOOD_DESC)), ["elapsed-time-mix"])
        self.assertEqual(checks(fixture(CLEAN_DESC, CODE_ACC)), [])

    def test_strict_improvement_is_admitted(self) -> None:
        # Repairs b-what-why-acc; elapsed-time-mix remains, owned by a different fix.
        rc, err = self.run_update(fixture(), new_desc=GOOD_DESC)
        self.assertEqual(rc, 0, err)
        self.assertIn("LINT_REPAIR_ADMITTED", err)
        self.assertIn("b-what-why-acc", err)

    def test_edit_that_adds_a_failure_is_refused_naming_it(self) -> None:
        # Planted negative: the same repair while dropping every label adds a-label.
        rc, err = self.run_update(fixture(), "--set-labels", "", new_desc=GOOD_DESC)
        self.assertEqual(rc, 4, err)
        self.assertIn("a-label", self.refused_checks(err))

    def test_edit_that_repairs_nothing_is_refused(self) -> None:
        # Planted negative: a title-only edit leaves the same failures, so nothing is admitted.
        rc, err = self.run_update(fixture(), "--title", "Renamed fixture")
        self.assertEqual(rc, 4, err)
        self.assertEqual(sorted(self.refused_checks(err)), ["b-what-why-acc", "elapsed-time-mix"])

    def test_claim_or_status_move_gets_no_repair_admission(self) -> None:
        # Planted negative: the improving edit combined with a claim or a status move
        # gets no repair admission: it is refused while any check fails.
        for flags in (("--claim",), ("--status", "in_progress"), ("--status", "in_review")):
            with self.subTest(flags=flags):
                rc, err = self.run_update(fixture(), *flags, new_desc=GOOD_DESC)
                self.assertEqual(rc, 4, err)
                self.assertNotIn("LINT_REPAIR_ADMITTED", err)

    def test_claim_on_a_failing_bead_is_refused_naming_the_checks(self) -> None:
        # CLAIMLINT planted negative: J-107, no worker picks up a bead that fails lint.
        for flags in CLAIM_MOVES:
            with self.subTest(flags=flags):
                rc, err = self.run_update(fixture(), *flags)
                self.assertEqual(rc, 4, err)
                self.assertIn("this claim would start work on rpr-1", err)
                self.assertEqual(self.refused_checks(err), ["b-what-why-acc", "elapsed-time-mix"])

    def test_claim_on_a_passing_bead_is_admitted(self) -> None:
        # Paired control: the same moves on a bead that passes every check.
        for flags in CLAIM_MOVES:
            with self.subTest(flags=flags):
                rc, err = self.run_update(fixture(CLEAN_DESC, CODE_ACC), *flags)
                self.assertEqual((rc, err), (0, ""))

    def test_parking_and_priority_moves_on_a_failing_bead_pass_through(self) -> None:
        # Releasing or reprioritising a failing bead is not a claim and is never blocked.
        for flags in (("--status", "open", "--assignee", ""), ("--priority", "1"), ("--status", "blocked")):
            with self.subTest(flags=flags):
                rc, err = self.run_update(fixture(), *flags)
                self.assertEqual((rc, err), (0, ""))

    def test_multi_id_claim_judges_every_id(self) -> None:
        # Planted negative: a passing first id cannot carry a failing second one through.
        clean = fixture(CLEAN_DESC, CODE_ACC, "rpr-ok")
        rc, err = self.run_update([clean, fixture(bead_id="rpr-bad")], "--claim")
        self.assertEqual(rc, 4, err)
        self.assertIn("rpr-bad", err)
        rc, err = self.run_update([clean, fixture(CLEAN_DESC, CODE_ACC, "rpr-ok2")], "--claim")
        self.assertEqual((rc, err), (0, ""))

    def test_claim_fails_closed_when_lint_cannot_run(self) -> None:
        # A claim needs a PASS: an unreadable tracker refuses it, while a content edit
        # keeps the fail-open contract (exit 3, the shim warns and allows).
        rc, err = self.run_update(fixture(CLEAN_DESC, CODE_ACC), "--claim", fail=True)
        self.assertEqual(rc, 4, err)
        self.assertIn("LINT_UNAVAILABLE", err)
        rc, err = self.run_update(fixture(CLEAN_DESC, CODE_ACC), "--title", "Renamed", fail=True)
        self.assertEqual(rc, 3, err)
        self.assertIn("LINT_GATE_UNVERIFIED", err)

    def test_clean_edit_is_still_admitted_without_a_repair_note(self) -> None:
        rc, err = self.run_update(fixture(CLEAN_DESC, CODE_ACC), "--title", "Renamed clean fixture")
        self.assertEqual((rc, err), (0, ""))


if __name__ == "__main__":
    unittest.main()
