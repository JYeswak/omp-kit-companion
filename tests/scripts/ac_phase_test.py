#!/usr/bin/env python3
"""ACPHASE1 (ompkit-9e9w6) + PREGRADE1 (ompkit-3s6d2) gate tests.

Golden parse cases come from tests/fixtures/ac-phase-cases.json, the corpus
the grade_wave mirror also reads, so the two parsers cannot drift. The
in_review gate runs through the real scripts/br-update-lint.py CLI with a fake
`br` (BR_UPDATE_REAL, the helper's injectable reader) serving bead JSON and
XDG_STATE_HOME pointed at an owned temp dir holding the pregrade record. Every
refusal code has a planted negative whose control differs only in the planted
fault. Create admission runs through br_create_guard_core.lint_prospective
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
from datetime import datetime, timedelta, timezone
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
GRADER = "GraderAgent"
GOOD_ACC = (
    "- [x] [a] [build] parser handles tags; planted negative: an untagged line is refused\n"
    "- [x] [a] [landed] on origin/main\n"
    "- [ ] [a] [live] release installed and the gate fires live"
)
# run_gate config sentinels: the repo opted in, or the opt-in path is a directory.
REQUIRED = {"required": True}
DIRECTORY = object()
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


def iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


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


def pregrade_record(of: dict, **overrides) -> dict:
    record = {
        "schema": "omp-kit.pregrade.v1",
        "bead": of["id"],
        "repo": "omp-kit",
        "ac_sha256": ac_phase.ac_sha256(of["acceptance_criteria"]),
        "landing_ref": "origin/main",
        "landing_sha": "0" * 40,
        "candidate_commit": "1" * 40,
        "verdict": "WAITING",
        "items": [{"ac": 1, "phase": "build", "status": "PASS"},
                  {"ac": 2, "phase": "landed", "status": "PASS"},
                  {"ac": 3, "phase": "live", "status": "WAITING"}],
        "grader": GRADER,
        "grader_model": "fixture-model",
        "author": AUTHOR,
        "wave": "w-test",
        "at": iso(utc_now()),
    }
    record.update(overrides)
    return record


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

    def run_gate(self, bead: dict, record: dict | None, *, argv: list[str] | None = None,
                 fail_br: bool = False, config: object = REQUIRED,
                 project_sub: str = "", project_beads: bool = False,
                 db: str | None = None) -> tuple[int, str]:
        """Run the real CLI. `state` is the tracker repo (it holds `.beads`, so
        the walk-up stops there, never at this checkout); `config` is written
        to state/.omp/pregrade.json (dict as JSON, str verbatim, None absent,
        DIRECTORY as a directory)."""
        state = self.root / f"state-{self.id().rsplit('.', 1)[-1]}-{time.monotonic_ns()}"
        pregrade = state / "omp-kit" / "pregrade"
        pregrade.mkdir(parents=True)
        (state / ".beads").mkdir()
        if config is DIRECTORY:
            (state / ".omp" / "pregrade.json").mkdir(parents=True)
        elif config is not None:
            (state / ".omp").mkdir()
            text = config if isinstance(config, str) else json.dumps(config)
            (state / ".omp" / "pregrade.json").write_text(text, encoding="utf-8")
        if record is not None:
            (pregrade / f"{bead['id']}.json").write_text(json.dumps(record), encoding="utf-8")
        bead_file = state / "bead.json"
        bead_file.write_text(json.dumps(bead), encoding="utf-8")
        project = state / project_sub
        project.mkdir(parents=True, exist_ok=True)
        if project_beads:
            (project / ".beads").mkdir()
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(state),
            "XDG_STATE_HOME": str(state),
            "BR_UPDATE_REAL": str(self.fake_br),
            "BR_UPDATE_PROJECT": str(project),
            "FAKE_BR_BEAD": str(bead_file),
        }
        if db is not None:
            env["BR_UPDATE_DB"] = db.replace("{state}", str(state))
        if fail_br:
            env["FAKE_BR_FAIL"] = "1"
        result = run_bounded([sys.executable, UPDATE_LINT, *(argv or ["update", bead["id"], "--status", "in_review"])],
                             60, env=env, cwd=str(project))
        self.assertEqual(result.outcome, "OK")
        return result.returncode, result.stderr.decode("utf-8", "replace")

    def assert_refused(self, code: str, bead: dict, record: dict | None, **kwargs) -> str:
        rc, err = self.run_gate(bead, record, **kwargs)
        self.assertEqual(rc, 4, err)
        refused = [line for line in err.splitlines() if "LINT_REFUSED " in line]
        self.assertEqual(len(refused), 1, err)
        self.assertIn(code, refused[0].split("LINT_REFUSED ", 1)[1].split(": this ", 1)[0], err)
        return err

    def test_pregrade_is_opt_in_per_tracker_repo(self) -> None:
        bead = base_bead()
        # Control: no opt-in file -> ticked post-cutover bead, NO record, admitted.
        self.assertEqual(self.run_gate(bead, None, config=None), (0, ""))
        self.assertEqual(self.run_gate(bead, None, config={"required": False}), (0, ""))
        # Planted: the same bead in an opted-in repo is refused.
        self.assert_refused("PREGRADE_MISSING", bead, None, config={"required": True})
        self.assert_refused("PREGRADE_MISSING", bead, None, config={"required": True, "note": "x"})
        # Portable rules stay on without any opt-in.
        unticked = base_bead(acceptance_criteria=GOOD_ACC.replace("- [x] [a] [build]", "- [ ] [a] [build]"))
        err = self.assert_refused("AC_UNTICKED_BUILD_LANDED", unticked, None, config=None)
        self.assertNotIn("PREGRADE", err)
        untagged = base_bead(acceptance_criteria=GOOD_ACC + "\n- [x] [a] docs written; planted negative RED")
        self.assert_refused("AC_PHASE_UNTAGGED", untagged, None, config=None)

    def test_repo_hint_follows_pregrade_refusals_only(self) -> None:
        bead = base_bead()
        hint = "run: omp-kit grade wave --pregrade <bead>\x1b[31m\x07 then retry\n" + "y" * 600
        config = {"required": True, "hint": hint}
        err = self.assert_refused("PREGRADE_MISSING", bead, None, config=config)
        lines = [line for line in err.splitlines() if line.startswith("br-shim: PREGRADE_HINT ")]
        self.assertEqual(len(lines), 1, err)
        printed = lines[0][len("br-shim: PREGRADE_HINT "):]
        self.assertTrue(printed.startswith("run: omp-kit grade wave --pregrade <bead>[31m then retry"), printed)
        self.assertEqual(len(printed), 500)
        self.assertFalse(any(ord(ch) < 32 or ord(ch) == 127 for ch in printed), printed)
        self.assertEqual(err.strip().splitlines()[-1], lines[0])
        # Control: no hint in the file -> the same refusal, nothing extra.
        err = self.assert_refused("PREGRADE_MISSING", bead, None, config={"required": True})
        self.assertNotIn("PREGRADE_HINT", err)
        # A hint never rides a non-pregrade refusal, and a passing pregrade prints nothing.
        unticked = base_bead(acceptance_criteria=GOOD_ACC.replace("- [x] [a] [build]", "- [ ] [a] [build]"))
        err = self.assert_refused("AC_UNTICKED_BUILD_LANDED", unticked, pregrade_record(unticked), config=config)
        self.assertNotIn("PREGRADE_HINT", err)
        self.assertEqual(self.run_gate(bead, pregrade_record(bead), config=config), (0, ""))
        # A non-string hint makes the file invalid (fail closed).
        self.assert_refused("PREGRADE_CONFIG_INVALID", bead, pregrade_record(bead),
                            config={"required": True, "hint": 7})

    def test_planted_invalid_config_fails_closed(self) -> None:
        bead = base_bead()
        for config in ("not json", "[]", '{"required": "yes"}', "{}", DIRECTORY):
            with self.subTest(config=config):
                # Even a valid record cannot pass a broken opt-in file.
                err = self.assert_refused("PREGRADE_CONFIG_INVALID", bead, pregrade_record(bead), config=config)
                self.assertIn("pregrade.json", err)
        # Invalid also means required: no record adds PREGRADE_MISSING.
        err = self.assert_refused("PREGRADE_CONFIG_INVALID", bead, None, config="not json")
        self.assertIn("PREGRADE_MISSING", err)

    def test_tracker_repo_resolution(self) -> None:
        bead = base_bead()
        # Walk-up: a subdirectory of the opted-in repo is still that repo.
        self.assert_refused("PREGRADE_MISSING", bead, None, project_sub="sub/dir")
        # A nested repo with its own (unopted) .beads stops the walk: admitted.
        self.assertEqual(self.run_gate(bead, None, project_sub="nested", project_beads=True), (0, ""))
        # --db wins over the walk: same nested project, db in the opted-in repo.
        self.assert_refused("PREGRADE_MISSING", bead, None, project_sub="nested", project_beads=True,
                            db="{state}/.beads/beads.db")

    def test_db_outside_opted_repo_is_not_required(self) -> None:
        # Control for the --db case: the db lives in a repo with no opt-in file.
        bead = base_bead()
        bare = self.root / f"bare-{time.monotonic_ns()}"
        (bare / ".beads").mkdir(parents=True)
        self.assertEqual(self.run_gate(bead, None, db=str(bare / ".beads" / "beads.db")), (0, ""))

    def test_pregrade_dir_reads_only_xdg_state_home_then_home(self) -> None:
        self.assertEqual(ac_phase.pregrade_dir({"XDG_STATE_HOME": "/x", "HOME": "/h"}),
                         Path("/x/omp-kit/pregrade"))
        self.assertEqual(ac_phase.pregrade_dir({"HOME": "/h"}), Path("/h/.local/state/omp-kit/pregrade"))
        with self.assertRaises(ValueError):
            ac_phase.pregrade_dir({})
        refusals = ac_phase.in_review_admission(base_bead(), env={}, repo=None)["refusals"]
        self.assertEqual(refusals, [])

    def test_control_matching_pregrade_is_admitted(self) -> None:
        bead = base_bead()
        rc, err = self.run_gate(bead, pregrade_record(bead))
        self.assertEqual((rc, err), (0, ""))
        rc, err = self.run_gate(bead, pregrade_record(bead, verdict="PASS"))
        self.assertEqual((rc, err), (0, ""))
        # Ticking the [live] item after the pregrade keeps the digest.
        ticked = base_bead(acceptance_criteria=GOOD_ACC.replace("- [ ] [a] [live]", "- [x] [a] [live]"))
        rc, err = self.run_gate(ticked, pregrade_record(bead))
        self.assertEqual((rc, err), (0, ""))
        rc, err = self.run_gate(bead, pregrade_record(bead), argv=["update", "acp-1", "--status=in_review"])
        self.assertEqual((rc, err), (0, ""))

    def test_planted_pregrade_missing(self) -> None:
        bead = base_bead()
        err = self.assert_refused("PREGRADE_MISSING", bead, None)
        self.assertIn("no pregrade record", err)
        self.assert_refused("PREGRADE_MISSING", bead, pregrade_record(bead, bead="acp-2"))
        self.assert_refused("PREGRADE_MISSING", bead, pregrade_record(bead, schema="omp-kit.pregrade.v0"))

    def test_planted_pregrade_stale(self) -> None:
        bead = base_bead()
        old = iso(utc_now() - timedelta(hours=24, minutes=1))
        self.assert_refused("PREGRADE_STALE", bead, pregrade_record(bead, at=old))
        future = iso(utc_now() + timedelta(hours=1))
        self.assert_refused("PREGRADE_STALE", bead, pregrade_record(bead, at=future))
        fresh = iso(utc_now() - timedelta(hours=23, minutes=50))
        self.assertEqual(self.run_gate(bead, pregrade_record(bead, at=fresh)), (0, ""))

    def test_planted_pregrade_ac_changed(self) -> None:
        bead = base_bead()
        record = pregrade_record(bead)
        edited = base_bead(acceptance_criteria=GOOD_ACC + "\n- [ ] [a] [after 7d] reworks drop vs baseline")
        err = self.assert_refused("PREGRADE_AC_CHANGED", edited, record)
        self.assertNotIn("AC_UNTICKED_BUILD_LANDED", err)
        # The same AC edit carried in the update itself is also caught.
        rc, err = self.run_gate(bead, record, argv=["update", "acp-1", "--status", "in_review",
                                                    "--add-acceptance", "[a] [after 7d] reworks drop vs baseline"])
        self.assertEqual(rc, 4, err)
        self.assertIn("PREGRADE_AC_CHANGED", err)

    def test_planted_pregrade_not_passing(self) -> None:
        bead = base_bead()
        for verdict in ("FAIL", "UNVERIFIED", None):
            with self.subTest(verdict=verdict):
                self.assert_refused("PREGRADE_NOT_PASSING", bead, pregrade_record(bead, verdict=verdict))

    def test_planted_pregrade_self(self) -> None:
        bead = base_bead()
        self.assert_refused("PREGRADE_SELF", bead, pregrade_record(bead, grader=AUTHOR))
        # The record's author field lying does not help: the live assignee counts.
        self.assert_refused("PREGRADE_SELF", bead, pregrade_record(bead, grader=AUTHOR, author="Someone"))
        self.assert_refused("PREGRADE_SELF", bead, pregrade_record(bead, grader=""))
        # GateReview findings 1-2: a whitespace grader, and an unassigned bead whose record names no author, are
        # refused; the same unassigned bead with an author on the record and a different grader is admitted.
        self.assert_refused("PREGRADE_SELF", bead, pregrade_record(bead, grader="   "))
        self.assert_refused("PREGRADE_SELF", bead, pregrade_record(bead, grader=f" {AUTHOR} "))
        unassigned = base_bead(assignee=None)
        no_author = pregrade_record(unassigned)
        no_author.pop("author")
        self.assert_refused("PREGRADE_SELF", unassigned, no_author)
        self.assertEqual(self.run_gate(unassigned, pregrade_record(unassigned)), (0, ""))

    def test_planted_unticked_build_landed(self) -> None:
        for marker in ("- [x] [a] [build]", "- [x] [a] [landed]"):
            with self.subTest(marker=marker):
                bead = base_bead(acceptance_criteria=GOOD_ACC.replace(marker, marker.replace("[x]", "[ ]")))
                err = self.assert_refused("AC_UNTICKED_BUILD_LANDED", bead, pregrade_record(bead))
                self.assertIn("item ", err)
                self.assertNotIn("[live] release installed", err.split("AC_UNTICKED_BUILD_LANDED", 2)[-1])

    def test_planted_untagged_and_multi(self) -> None:
        untagged = base_bead(acceptance_criteria=GOOD_ACC + "\n- [x] [a] docs written; planted negative RED")
        err = self.assert_refused("AC_PHASE_UNTAGGED", untagged, pregrade_record(untagged))
        self.assertIn("docs written", err)
        multi = base_bead(acceptance_criteria=GOOD_ACC + "\n- [x] [a] [build] [live] docs live; planted negative RED")
        err = self.assert_refused("AC_PHASE_MULTI", multi, pregrade_record(multi))
        self.assertIn("docs live", err)

    def test_legacy_bead_is_admitted_with_notice(self) -> None:
        bead = base_bead(created_at=LEGACY_AT,
                         acceptance_criteria="- [ ] [a] untagged legacy item; planted negative RED")
        rc, err = self.run_gate(bead, None)
        self.assertEqual(rc, 0, err)
        self.assertEqual(len(err.strip().splitlines()), 1, err)
        self.assertIn("AC_PHASE_LEGACY", err)
        # Control: the same bead one microsecond later is refused.
        self.assert_refused("PREGRADE_MISSING", dict(bead, created_at="2026-10-24T00:00:00Z"), None)
        # Legacy is admitted whatever the opt-in file says, broken or absent.
        for config in (None, {"required": False}, "not json", DIRECTORY):
            with self.subTest(config=config):
                rc, err = self.run_gate(bead, None, config=config)
                self.assertEqual(rc, 0, err)
                self.assertIn("AC_PHASE_LEGACY", err)
                self.assertNotIn("PREGRADE", err)

    def test_probe_failure_is_unverified(self) -> None:
        rc, err = self.run_gate(base_bead(), None, fail_br=True)
        self.assertEqual(rc, 3, err)
        self.assertIn("LINT_GATE_UNVERIFIED", err)

    def test_workflow_moves_stay_ungated(self) -> None:
        # A non-claim workflow move never meets the review gate. A move to in_progress is a
        # claim and needs a lint PASS (CLAIMLINT ompkit-fp72.135.3.50 [b], br_update_lint_repair_test).
        bead = base_bead(acceptance_criteria="- [ ] untagged")
        for flags in (["--status", "blocked"], ["--priority", "1"]):
            with self.subTest(flags=flags):
                rc, err = self.run_gate(bead, None, argv=["update", "acp-1", *flags])
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

    def test_planted_untagged_create_refused_naming_the_line(self) -> None:
        line = "- [ ] [a] widget builds; planted negative: bad input refused"
        failures = self.lint(line, self.AFTER)
        self.assertEqual(len(failures), 1, failures)
        self.assertTrue(failures[0].startswith("l-ac-phase:AC_PHASE_UNTAGGED"), failures)
        self.assertIn(line, failures[0])
        for tag in ("[build]", "[landed]", "[live]", "[after <window>]"):
            self.assertIn(tag, failures[0])

    def test_control_tagged_create_admitted(self) -> None:
        self.assertEqual(self.lint("- [ ] [a] [build] widget builds; planted negative: bad input refused", self.AFTER), [])
        self.assertEqual(self.lint("- [ ] AC-KITLIB-2 ratchet holds [a]; planted negative RED", self.AFTER), [])
        # A scope letter before AC-KITLIB hides it (locked grammar): untagged.
        self.assertIn("AC_PHASE_UNTAGGED", "".join(self.lint("- [ ] [a] AC-KITLIB-2 ratchet; planted negative RED", self.AFTER)))

    def test_planted_multi_create_refused(self) -> None:
        failures = self.lint("- [ ] [a] [build] [live] widget; planted negative RED", self.AFTER)
        self.assertEqual(len(failures), 1, failures)
        self.assertIn("AC_PHASE_MULTI", failures[0])

    def test_pre_cutover_untagged_create_admitted(self) -> None:
        self.assertEqual(self.lint("- [ ] [a] widget builds; planted negative: bad input refused", self.BEFORE), [])


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
        ok, report = bead_lint.run_selftest(bead_lint.PROBE_DEFAULT)
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
                    ok, report = bead_lint.run_selftest(bead_lint.PROBE_DEFAULT)
                finally:
                    setattr(bead_lint, name, real)
                self.assertFalse(ok, name)
                self.assertTrue(any("l-ac-phase" in f for f in report["failures"]), report["failures"])


if __name__ == "__main__":
    unittest.main()
