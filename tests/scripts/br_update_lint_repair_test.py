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
import runpy
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
PROJECTION = runpy.run_path(UPDATE_LINT)
ENFORCED_AT = "2026-10-24T00:00:00.000001Z"
CODE_ACC = (
    "- [ ] [a] [build] parser handles tags `true` -> rc 0; planted negative: an untagged line is refused\n"
    "- [ ] [a] [landed] on origin/main `true` -> rc 0"
)
# An open time item beside code items: elapsed-time-mix, which a description
# edit cannot repair (its fix is a split or a checker change).
MIXED_ACC = CODE_ACC + "\n- [ ] [b] [after 7d] measured over 7 days; planted negative: a one-day sample is rejected"
PRIORART_SUFFIX = "\nGOAL: fixture bead for a lint test; measured by this test.\nNATIVE: none needed for a fixture.\nEXISTING: none, a fixture.\nDECISION: EXTEND the lint under test; no new tool.\nBEST: none, a fixture."
BAD_DESC = "no sections here" + PRIORART_SUFFIX
GOOD_DESC = "WHAT: (a) gate parser tags; (b) measure the gate. WHY: early submissions bounce." + PRIORART_SUFFIX
CLEAN_DESC = "WHAT: (a) gate parser tags. WHY: early submissions bounce." + PRIORART_SUFFIX
FAKE_BR = """#!/usr/bin/env python3
import json, os, sys
bead = json.load(open(os.environ["FAKE_BR_BEAD"], encoding="utf-8"))
args = sys.argv[1:]
if "show" in args or "list" in args:
    print(json.dumps([bead]))
    sys.exit(0)
sys.exit(2)
"""


def fixture(desc: str = BAD_DESC, acc: str = MIXED_ACC) -> dict:
    return {
        "id": "rpr-1", "title": "Repair admission fixture", "status": "open", "priority": 2,
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

    def run_update(self, bead: dict, *flags: str, new_desc: str | None = None) -> tuple[int, str]:
        state = self.root / f"state-{self.id().rsplit('.', 1)[-1]}-{time.monotonic_ns()}"
        (state / ".beads").mkdir(parents=True)
        bead_file = state / "bead.json"
        bead_file.write_text(json.dumps(bead), encoding="utf-8")
        argv = ["update", bead["id"], *flags]
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
        listed = lines[0].split("LINT_REFUSED ", 1)[1].split(": this edit ", 1)[0]
        known = bead_lint.GATE_CHECKS
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
        # Planted negative: repairing scope while introducing a placeholder is not an improvement.
        rc, err = self.run_update(fixture(), new_desc=GOOD_DESC + " TODO")
        self.assertEqual(rc, 4, err)
        self.assertIn("h-placeholders", self.refused_checks(err))

    def test_edit_that_repairs_nothing_is_refused(self) -> None:
        # Planted negative: a title-only edit leaves the same failures, so nothing is admitted.
        rc, err = self.run_update(fixture(), "--title", "Renamed fixture")
        self.assertEqual(rc, 4, err)
        self.assertEqual(sorted(self.refused_checks(err)), ["b-what-why-acc", "elapsed-time-mix"])

    def test_claim_or_status_move_gets_no_repair_admission(self) -> None:
        # Planted negative: the improving edit combined with a claim or a status move
        # is judged exactly as today (refused while any check fails).
        for flags in (("--claim",), ("--status", "in_progress"), ("--status", "in_review")):
            with self.subTest(flags=flags):
                rc, err = self.run_update(fixture(), *flags, new_desc=GOOD_DESC)
                self.assertEqual(rc, 4, err)
                self.assertNotIn("LINT_REPAIR_ADMITTED", err)

    def test_standalone_claim_keeps_todays_pass_through(self) -> None:
        # A replayable acceptance (J-2026-10-29-22): MIXED_ACC's [after 7d] box is refused at claim
        # by REPLAYABLE1, which bead-replayable.test.ts covers; the bead still fails b-what-why-acc.
        rc, err = self.run_update(fixture(BAD_DESC, CODE_ACC), "--claim")
        self.assertEqual((rc, err), (0, ""))

    def test_metatype_only_admits_unchanged_legacy_contract(self) -> None:
        legacy = fixture(BAD_DESC, "- [ ] Keep the original live obligation unchanged.")
        for flags in (("--type", "epic"), ("-t", "epic"), ("--type=epic",)):
            with self.subTest(flags=flags):
                rc, err = self.run_update(legacy, *flags)
                self.assertEqual((rc, err), (0, ""))

    def test_metatype_does_not_exempt_content_edits(self) -> None:
        for flags in (("--description", BAD_DESC),
                      ("--acceptance-criteria", "- [ ] An unreplayable replacement")):
            with self.subTest(flags=flags):
                rc, err = self.run_update(fixture(), "--type", "epic", *flags)
                self.assertEqual(rc, 4, err)
                self.assertIn("LINT_REFUSED", err)

    def test_metatype_does_not_exempt_review_entry(self) -> None:
        bead = fixture(CLEAN_DESC, CODE_ACC)
        bead["created_at"] = "2026-11-14T00:00:00Z"
        rc, err = self.run_update(bead, "--type", "task", "--status", "in_review")
        self.assertEqual(rc, 4, err)
        self.assertIn("AC_UNTICKED_BUILD_LANDED", err)

    def test_clean_edit_is_still_admitted_without_a_repair_note(self) -> None:
        rc, err = self.run_update(fixture(CLEAN_DESC, CODE_ACC), "--title", "Renamed clean fixture")
        self.assertEqual((rc, err), (0, ""))

    def project(self, body: str, *flags: str) -> str:
        args = PROJECTION["parse_update"](["update", "rpr-1", *flags])
        return PROJECTION["prospective"](fixture(CLEAN_DESC, body), args, str(self.root))["acceptance_criteria"]

    def test_checkbox_projection_preserves_markers_and_text(self) -> None:
        body = "- [ ] Alpha\r\n  * [X] Beta, gamma\r\n+[\u00a0] Delta\r\n"
        self.assertEqual(
            self.project(body, "--check-acceptance", "1,3", "--uncheck-acceptance", "BETA, GAMMA"),
            "- [x] Alpha\r\n  * [ ] Beta, gamma\r\n+[x] Delta\r\n")
        self.assertEqual(self.project(body, "--check-acceptance", "Beta, gamma"), body)
        self.assertEqual(
            self.project("- [ ] Alpha\n- [ ] Alpha extended\n", "--check-acceptance", "ALPHA"),
            "- [x] Alpha\n- [ ] Alpha extended\n")
        self.assertEqual(
            self.project(body, "--check-acceptance", "Alpha", "--check-acceptance", "Delta"),
            "- [x] Alpha\r\n  * [X] Beta, gamma\r\n+[x] Delta\r\n")

    def test_checkbox_projection_ignores_fenced_examples(self) -> None:
        for body in ("````markdown\n- [ ] example\n```\n- [ ] still code\n````\n- [ ] real\n",
                     "~~~\n- [ ] example\n~~~ trailing text\n- [ ] still code\n~~~\n- [ ] real\n"):
            with self.subTest(body=body):
                self.assertEqual(self.project(body, "--check-acceptance", "1"),
                                 body.replace("- [ ] real", "- [x] real"))

    def test_checkbox_selectors_are_validated_before_projection(self) -> None:
        body = "- [ ] same first\n- [ ] same second\n"
        for flags in (("--check-acceptance", "0"),
                      ("--check-acceptance", "1,99"),
                      ("--check-acceptance", "missing"),
                      ("--check-acceptance", "same"),
                      ("--check-acceptance", "1", "--uncheck-acceptance", "1"),
                      ("--check-acceptance", "3", "--add-acceptance", "new item")):
            with self.subTest(flags=flags), self.assertRaises(ValueError):
                self.project(body, *flags)
        with self.assertRaises(ValueError):
            self.project("```\n- [ ] example\n", "--add-acceptance", "new item")

    def test_checkbox_edits_precede_appending_and_reject_replacement_conflicts(self) -> None:
        body = "* [ ] Alpha\r\n* [X] Beta\r\n\r\n"
        self.assertEqual(
            self.project(body, "--check-acceptance", "1", "--add-acceptance", " New item "),
            "* [x] Alpha\r\n* [X] Beta\r\n* [ ] New item\r\n\r\n")
        replacement = "* [ ] Other\r\n* [X] Beta\r\n\r\n"
        for flag in ("--check-acceptance", "--uncheck-acceptance", "--add-acceptance"):
            with self.subTest(flag=flag), self.assertRaises(ValueError):
                self.project(body, "--acceptance-criteria", replacement, flag, "1")

    def test_standalone_checkbox_update_does_not_add_a_legacy_lint_gate(self) -> None:
        rc, err = self.run_update(fixture(), "--check-acceptance", "1")
        self.assertEqual((rc, err), (0, ""))


if __name__ == "__main__":
    unittest.main()
