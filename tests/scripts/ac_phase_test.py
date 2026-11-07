#!/usr/bin/env python3
"""ACPHASE1 (ompkit-9e9w6) gate tests.

Golden parse cases come from tests/fixtures/ac-phase-cases.json, the corpus
the grade_wave mirror also reads, so the two parsers cannot drift. The
in_review gate runs through the real scripts/br-update-lint.py CLI with a fake
`br` (BR_UPDATE_REAL, the helper's injectable reader) serving bead JSON.
Create admission runs through br_create_guard_core.lint_prospective
with the clock pinned on each side of the cutover.

Run: python3 tests/scripts/ac_phase_test.py
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
import ac_phase  # noqa: E402
import bead_lint  # noqa: E402
import br_create_guard_core  # noqa: E402
import kitlib_tmp  # noqa: E402  (owned temp dirs: removed on exit and HUP/INT/TERM)
from pysafe import run_bounded  # noqa: E402  (cancel-safe spawn: own process group, stdin DEVNULL, hard deadline)

CASES = json.loads((ROOT / "tests" / "fixtures" / "ac-phase-cases.json").read_text(encoding="utf-8"))
CONTRACT_KEYS = ("index", "checked", "phase", "window", "multi", "text")
UPDATE_LINT = str(SCRIPTS / "br-update-lint.py")
ENFORCED_AT = "2026-10-24T00:00:00.000001Z"
LEGACY_AT = "2026-10-23T23:59:59.999999Z"
AUTHOR = "AuthorAgent"
GOOD_ACC = (
    "- [x] [a] [build] parser handles tags `true` -> rc 0; planted negative: an untagged line is refused\n"
    "- [x] [a] [landed] on origin/main `true` -> rc 0\n"
    "- [ ] [a] [live] release installed and the gate fires live `true` -> rc 0"
)
FAKE_BR = """#!/usr/bin/env python3
import json, os, sys
if os.environ.get("FAKE_BR_FAIL"):
    sys.stderr.write("fake br: tracker unreadable\\n")
    sys.exit(1)
bead = json.load(open(os.environ["FAKE_BR_BEAD"], encoding="utf-8"))
args = sys.argv[1:]
if "show" in args or "list" in args:
    print(json.dumps([bead]))
    sys.exit(0)
sys.exit(2)
"""


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def base_bead(**overrides) -> dict:
    bead = {
        "id": "acp-1",
        "title": "Phase gate fixture",
        "status": "in_progress",
        "priority": 2,
        "issue_type": "task",
        "labels": ["gate"],
        "description": "WHAT: (a) gate in_review on phases. WHY: early submissions bounce.",
        "acceptance_criteria": GOOD_ACC,
        "created_at": ENFORCED_AT,
        "assignee": AUTHOR,
        "dependencies": [],
    }
    bead.update(overrides)
    return bead


class Grammar(unittest.TestCase):
    def test_golden_cases(self) -> None:
        self.assertGreaterEqual(len(CASES), 12)
        for case in CASES:
            with self.subTest(case=case["name"]):
                got = [{key: item[key] for key in CONTRACT_KEYS} for item in ac_phase.parse(case["ac_text"])]
                self.assertEqual(got, case["expect"])

    def test_long_near_miss_inputs_stay_linear(self) -> None:
        # Timed near-misses: a huge leading run with no phase tag, an unclosed
        # bracket flood, and a whitespace flood before a bad checkbox.
        inputs = [
            "- [ ] " + "[a] " * 50_000 + "x",
            "- [ ] " + "[" * 200_000,
            "- [ ] [after " + "9" * 200_000,
            " " * 200_000 + "- [?] x",
            "- [ ] [" + "after " * 40_000 + "]",
        ]
        for text in inputs:
            start = time.monotonic()
            items = ac_phase.parse(text)
            elapsed = time.monotonic() - start
            self.assertLess(elapsed, 2.0, f"{elapsed:.3f}s on {text[:30]!r}")
            self.assertTrue(all(item["phase"] is None for item in items))

    def test_digest_is_tick_invariant_and_text_sensitive(self) -> None:
        ticked = "- [x] [build] a\n  - [X] [live] b\nprose [x] stays"
        want = hashlib.sha256("- [ ] [build] a\n  - [ ] [live] b\nprose [x] stays".encode("utf-8")).hexdigest()
        self.assertEqual(ac_phase.ac_sha256(ticked), want)
        self.assertEqual(ac_phase.ac_sha256(ticked.replace("[x] [build]", "[ ] [build]")), want)
        self.assertNotEqual(ac_phase.ac_sha256(ticked.replace("a\n", "a!\n")), want)
        self.assertNotEqual(ac_phase.ac_sha256(ticked.replace("prose [x]", "prose [ ]")), want)

    def test_cutover_boundary(self) -> None:
        self.assertTrue(ac_phase.is_enforced("2026-10-24T00:00:00Z"))
        self.assertTrue(ac_phase.is_enforced("2026-10-24T00:00:00.000000001Z"))
        self.assertFalse(ac_phase.is_enforced("2026-10-23T23:59:59.999999Z"))
        self.assertFalse(ac_phase.is_enforced("2026-10-23T19:26:43.090978Z"))
        self.assertTrue(ac_phase.is_enforced("2026-10-23T17:00:00-07:00"))
        self.assertFalse(ac_phase.is_enforced("2026-10-23T16:59:59-07:00"))
        for missing in (None, "", "yesterday"):
            self.assertTrue(ac_phase.is_enforced(missing), missing)

    def test_overall_verdict(self) -> None:
        def items(*pairs):
            return [{"phase": phase, "status": status} for phase, status in pairs]
        table = [
            (items(("build", "PASS"), ("landed", "PASS")), "PASS"),
            (items(("build", "PASS"), ("live", "PASS"), ("after", "PASS")), "PASS"),
            (items(("build", "PASS"), ("live", "WAITING")), "WAITING"),
            (items(("build", "PASS"), ("live", "WAITING"), ("after", "PASS")), "WAITING"),
            (items(("build", "PASS"), ("live", "FAIL")), "FAIL"),
            (items(("build", "FAIL"), ("live", "WAITING")), "FAIL"),
            (items(("build", "UNVERIFIED"), ("live", "WAITING")), "UNVERIFIED"),
            (items(("build", "WAITING")), "UNVERIFIED"),
            (items(("build", "PASS"), ("live", "UNVERIFIED")), "UNVERIFIED"),
            (items((None, "PASS"), ("live", "WAITING")), "WAITING"),
        ]
        for rows, want in table:
            self.assertEqual(ac_phase.overall_verdict(rows), want, rows)
        # Planted: an unmet [live]-only bead is WAITING, never a FAIL/REWORK.
        self.assertEqual(ac_phase.overall_verdict(items(("live", "WAITING"))), "WAITING")


class InReviewCli(unittest.TestCase):
    """Contract section 6 through the real br-update-lint.py exit contract."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.work = kitlib_tmp.owned_tmp("ac-phase-test")
        cls.root = Path(cls.work.path)
        cls.fake_br = cls.root / "br"
        cls.fake_br.write_text(FAKE_BR, encoding="utf-8")
        cls.fake_br.chmod(0o700)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.work.cleanup()

    def run_gate(self, bead: dict, *, argv: list[str] | None = None,
                 fail_br: bool = False) -> tuple[int, str]:
        """Run the real CLI against an isolated tracker repo."""
        state = self.root / f"state-{self.id().rsplit('.', 1)[-1]}-{time.monotonic_ns()}"
        (state / ".beads").mkdir(parents=True)
        bead_file = state / "bead.json"
        bead_file.write_text(json.dumps(bead), encoding="utf-8")
        project = state
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(state),
            "XDG_STATE_HOME": str(state),
            "BR_UPDATE_REAL": str(self.fake_br),
            "BR_UPDATE_PROJECT": str(project),
            "FAKE_BR_BEAD": str(bead_file),
        }
        if fail_br:
            env["FAKE_BR_FAIL"] = "1"
        result = run_bounded([sys.executable, UPDATE_LINT, *(argv or ["update", bead["id"], "--status", "in_review"])],
                             60, env=env, cwd=str(project))
        self.assertEqual(result.outcome, "OK")
        return result.returncode, result.stderr.decode("utf-8", "replace")

    def assert_refused(self, code: str, bead: dict, **kwargs) -> str:
        rc, err = self.run_gate(bead, **kwargs)
        self.assertEqual(rc, 4, err)
        refused = [line for line in err.splitlines() if "LINT_REFUSED " in line]
        self.assertEqual(len(refused), 1, err)
        self.assertIn(code, refused[0].split("LINT_REFUSED ", 1)[1].split(": this ", 1)[0], err)
        return err

    def test_ticked_build_landed_is_admitted(self) -> None:
        self.assertEqual(self.run_gate(base_bead()), (0, ""))
    def test_planted_unticked_build_landed(self) -> None:
        for marker in ("- [x] [a] [build]", "- [x] [a] [landed]"):
            with self.subTest(marker=marker):
                bead = base_bead(acceptance_criteria=GOOD_ACC.replace(marker, marker.replace("[x]", "[ ]")))
                err = self.assert_refused("AC_UNTICKED_BUILD_LANDED", bead)
                self.assertIn("item ", err)
                self.assertNotIn("[live] release installed", err.split("AC_UNTICKED_BUILD_LANDED", 2)[-1])

    def test_planted_untagged_and_multi(self) -> None:
        untagged = base_bead(acceptance_criteria=GOOD_ACC + "\n- [x] [a] docs written; planted negative RED")
        err = self.assert_refused("AC_PHASE_UNTAGGED", untagged)
        self.assertIn("docs written", err)
        multi = base_bead(acceptance_criteria=GOOD_ACC + "\n- [x] [a] [build] [live] docs live; planted negative RED")
        err = self.assert_refused("AC_PHASE_MULTI", multi)
        self.assertIn("docs live", err)

    def test_legacy_bead_is_admitted_with_notice(self) -> None:
        bead = base_bead(created_at=LEGACY_AT,
                         acceptance_criteria="- [ ] [a] untagged legacy item `true` -> rc 0; planted negative RED")
        rc, err = self.run_gate(bead)
        self.assertEqual(rc, 0, err)
        self.assertEqual(len(err.strip().splitlines()), 1, err)
        self.assertIn("AC_PHASE_LEGACY", err)
        # Control: the same bead one microsecond later is refused.
        self.assert_refused("AC_PHASE_UNTAGGED", dict(bead, created_at="2026-10-24T00:00:00Z"))

    def test_probe_failure_is_unverified(self) -> None:
        rc, err = self.run_gate(base_bead(), fail_br=True)
        self.assertEqual(rc, 3, err)
        self.assertIn("LINT_GATE_UNVERIFIED", err)

    def test_workflow_moves_stay_ungated(self) -> None:
        bead = base_bead(acceptance_criteria="- [ ] untagged")
        rc, err = self.run_gate(bead, argv=["update", "acp-1", "--status", "in_progress"])
        self.assertEqual((rc, err), (0, ""))


class CreateAdmission(unittest.TestCase):
    AFTER = datetime(2026, 10, 24, 0, 0, 1, tzinfo=timezone.utc)
    BEFORE = datetime(2026, 10, 23, 23, 59, 59, tzinfo=timezone.utc)

    def lint(self, acceptance: str, now: datetime) -> list[str]:
        parsed = br_create_guard_core.parse_create_args([
            "create", "Phase gate create", "-t", "task", "-l", "gate",
            "--description", "WHAT: (a) a widget. WHY: needed.",
            "--acceptance", acceptance,
        ])
        return br_create_guard_core.lint_prospective(parsed, [], str(ROOT), now=now)

    # REPLAYABLE1 (ompkit-fp72.135.3.71): every create box must also be one
    # `omp-kit verify` can replay, so these phase fixtures name a command; the
    # replayability refusal itself is tested in tests/cli/bead-replayable.test.ts.
    def test_planted_untagged_create_refused_naming_the_line(self) -> None:
        line = "- [ ] [a] widget builds `true` -> rc 0; planted negative: bad input refused"
        failures = self.lint(line, self.AFTER)
        self.assertEqual(len(failures), 1, failures)
        self.assertTrue(failures[0].startswith("l-ac-phase:AC_PHASE_UNTAGGED"), failures)
        self.assertIn(line, failures[0])
        for tag in ("[build]", "[landed]", "[live]", "[after <window>]"):
            self.assertIn(tag, failures[0])

    def test_control_tagged_create_admitted(self) -> None:
        self.assertEqual(self.lint("- [ ] [a] [build] widget builds `true` -> rc 0; planted negative: bad input refused", self.AFTER), [])
        self.assertEqual(self.lint("- [ ] AC-KITLIB-2 ratchet holds [a]; planted negative RED", self.AFTER), [])
        # A scope letter before AC-KITLIB hides it (locked grammar): untagged.
        self.assertIn("AC_PHASE_UNTAGGED", "".join(self.lint("- [ ] [a] AC-KITLIB-2 ratchet `true` -> rc 0; planted negative RED", self.AFTER)))

    def test_planted_multi_create_refused(self) -> None:
        failures = self.lint("- [ ] [a] [build] [live] widget `true` -> rc 0; planted negative RED", self.AFTER)
        # Two phases are AC_PHASE_MULTI here and a tag run verify cannot replay.
        self.assertEqual(len(failures), 2, failures)
        self.assertIn("AC_PHASE_MULTI", failures[0])
        self.assertTrue(failures[1].startswith("r-verify-replayable:ACCEPTANCE_NOT_REPLAYABLE box 1"), failures)

    def test_pre_cutover_untagged_create_admitted(self) -> None:
        self.assertEqual(self.lint("- [ ] [a] widget builds `true` -> rc 0; planted negative: bad input refused", self.BEFORE), [])


class CheckL(unittest.TestCase):
    def test_enforced_offender_legacy_warning_and_controls(self) -> None:
        untagged = "- [ ] [a] x; planted negative RED"
        beads = [
            base_bead(id="l-enf", acceptance_criteria=untagged),
            base_bead(id="l-multi", acceptance_criteria="- [ ] [build] [landed] x; planted RED"),
            base_bead(id="l-old", acceptance_criteria=untagged, created_at=LEGACY_AT),
            base_bead(id="l-ok", acceptance_criteria="- [ ] [a] [live] x; planted negative RED"),
            base_bead(id="l-kit", acceptance_criteria="- [ ] AC-KITLIB-1 x; planted negative RED"),
        ]
        self.assertEqual(bead_lint.check_l(beads), ["l-enf", "l-multi"])
        self.assertEqual(bead_lint.check_l_legacy(beads), ["l-old"])
        byid = {b["id"] for b in beads}
        failures = {b["id"]: bead_lint.lint_bead_failures(b, byid) for b in beads}
        self.assertTrue(any(f.startswith("l-ac-phase:AC_PHASE_UNTAGGED") for f in failures["l-enf"]))
        self.assertTrue(any("AC_PHASE_MULTI" in f for f in failures["l-multi"]))
        for control in ("l-old", "l-ok", "l-kit"):
            self.assertFalse(any(f.startswith("l-ac-phase") for f in failures[control]), (control, failures[control]))
        report = bead_lint.run_lettered(beads, utc_now())
        self.assertEqual(report["l-ac-phase"], ["l-enf", "l-multi"])
        self.assertEqual(report["l-ac-phase-legacy"], ["l-old"])

    def test_selftest_bites_when_check_l_is_muted(self) -> None:
        ok, report = bead_lint.run_selftest()
        self.assertTrue(ok, report.get("failures"))
        mutants = {
            "check_l": lambda beads: [],
            "check_l_legacy": lambda beads: [],
            "ac_phase_failure": lambda bead: [],
        }
        for name, mutant in mutants.items():
            with self.subTest(mutant=name):
                real = getattr(bead_lint, name)
                setattr(bead_lint, name, mutant)
                try:
                    ok, report = bead_lint.run_selftest()
                finally:
                    setattr(bead_lint, name, real)
                self.assertFalse(ok, name)
                self.assertTrue(any("l-ac-phase" in f for f in report["failures"]), report["failures"])


if __name__ == "__main__":
    unittest.main()
