#!/usr/bin/env python3
"""RELLINT1: release-goal admission follows the real release dry-run, not bead closure.
BEADPITFALL1: a post-cutover build bead states its Pitfalls or the repo brief digest."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import bead_lint
import br_create_guard_core
import kitlib_run


DRY_RUN = (
    "- [ ] [a] [landed] A missing full-suite record is refused; "
    "`bash scripts/release-local.sh --dry-run --version 1.2.3` -> rc 0"
)


def release_goal(acceptance: str, labels=None) -> dict:
    return {
        "id": "fixture-release",
        "status": "open",
        "issue_type": "task",
        "created_at": "2026-10-31T00:00:00Z",
        "labels": ["kind:goal", "pillar:release"] if labels is None else labels,
        "description": "WHAT: qualify the release. WHY: the actual release path decides readiness.",
        "acceptance_criteria": acceptance,
        "dependencies": [],
    }


class NativeToolsRetirementTests(unittest.TestCase):
    def test_native_checks_do_not_return(self):
        retired = {"e-typed-edges", "br-lint-template", "pagerank-cert"}
        report = bead_lint.run_lettered([], datetime.now(timezone.utc))
        self.assertFalse(retired.intersection(bead_lint.LETTERED_IDS))
        self.assertFalse(retired.intersection(report))
        self.assertFalse(retired.intersection(bead_lint.lint_bead_failures(release_goal(DRY_RUN))))
        source = Path(bead_lint.__file__).read_text(encoding="utf-8")
        for name in retired:
            self.assertNotIn(name, source)

    def test_native_rules_are_not_shipped_or_referenced(self):
        root = Path(__file__).resolve().parents[2]
        manifest = kitlib_run.run(["sh", str(root / "scripts/build-manifest.sh"), "--stdout"],
                                  cwd=str(root), deadline_s=60)
        self.assertEqual(manifest.rc, 0, manifest.stderr.decode())
        for name in ("kit-br-readonly-unsupported", "kit-todo-append-phase"):
            self.assertFalse((root / "rules" / (name + ".md")).exists())
            self.assertNotIn(name, manifest.stdout.decode())
            for path in ("cases/cases.tsv", "tests/live/scenarios.json",
                         "scripts/fixtures/rx-reference-conditions.json"):
                self.assertNotIn(name, (root / path).read_text(encoding="utf-8"), path)


class ReleaseGoalLintTests(unittest.TestCase):
    def failures(self, acceptance: str, labels=None) -> list[str]:
        return bead_lint.lint_bead_failures(release_goal(acceptance, labels))

    def test_closure_only_goal_names_missing_dry_run(self):
        failures = self.failures("- [ ] [a] [landed] All pinned beads are closed; missing closure is refused.")
        self.assertIn("RELEASE_DRYRUN_BOX_MISSING", failures)

    def test_real_origin_dry_run_is_admitted(self):
        self.assertEqual(self.failures(DRY_RUN), [])

    def test_quoted_echo_is_not_a_release_dry_run(self):
        failures = self.failures(
            "- [ ] [a] [landed] Missing record is refused; "
            "`printf '%s' 'release-local.sh --dry-run --source origin/main'` -> rc 0"
        )
        self.assertIn("RELEASE_DRYRUN_BOX_MISSING", failures)

    def test_non_origin_dry_run_does_not_qualify_origin_head(self):
        failures = self.failures(DRY_RUN.replace(" --dry-run", " --dry-run --source " + "a" * 40))
        self.assertIn("RELEASE_DRYRUN_BOX_MISSING", failures)

    def test_no_dry_run_flag_is_refused(self):
        self.assertIn("RELEASE_DRYRUN_BOX_MISSING", self.failures(DRY_RUN.replace(" --dry-run", "")))

    def test_flag_in_argument_value_or_unsupported_shell_is_not_proof(self):
        for command in (
            "bash scripts/release-local.sh --version '--dry-run'",
            "bash scripts/release-local.sh --help --dry-run",
            "bash scripts/release-local.sh --dry-run unexpected",
            "bash -c 'scripts/release-local.sh --dry-run'",
            "cat <<EOF release-local.sh --dry-run EOF",
            "bash scripts/release-local.sh --dry-run 'unterminated",
        ):
            with self.subTest(command=command):
                acceptance = "- [ ] [a] [landed] Missing record is refused; `" + command + "` -> rc 0"
                self.assertIn("RELEASE_DRYRUN_BOX_MISSING", self.failures(acceptance))

    def test_shell_escapes_preserve_the_executed_command(self):
        self.assertEqual(self.failures(DRY_RUN.replace("release-local.sh", r"release\-local.sh")), [])

    def test_a_valid_dry_run_does_not_legalize_closure_as_tag_prerequisite(self):
        for closure in (
            "All pinned beads are closed before the release is tagged.",
            "Tag the release only after all child beads are closed.",
            "No release tag until all child beads are closed.",
        ):
            with self.subTest(closure=closure):
                failures = self.failures(DRY_RUN + "\n- [ ] [b] [landed] " + closure)
                self.assertIn("RELEASE_BEAD_CLOSURE_PREREQUISITE", failures)

    def test_a_negative_closure_specimen_is_not_a_prerequisite(self):
        self.assertEqual(self.failures(
            DRY_RUN + "\n- [ ] [b] [build] A planted goal requiring all beads closed before tagging is refused."
        ), [])

    def test_non_release_goals_and_release_work_are_unchanged(self):
        acceptance = "- [ ] [a] [build] Missing fixture is refused; `true` -> rc 0"
        for labels in (["kind:goal", "pillar:proven"], ["kind:fix", "pillar:release"]):
            with self.subTest(labels=labels):
                self.assertEqual(self.failures(acceptance, labels), [])


PITFALL_DESC = "WHAT: (a) refuse a widget. WHY: the widget leaks.\n"
BRIEF = "omp-kit-brief: /Users/x/repo " + "0123456789abcdef" * 4
PITFALL_ACC = "- [ ] [a] [build] planted bad widget is refused `true` -> rc 0"


def build_bead(desc: str, created_at: str, labels=None) -> dict:
    return {
        "id": "fixture-build",
        "status": "open",
        "issue_type": "task",
        "created_at": created_at,
        "labels": ["kind:fix"] if labels is None else labels,
        "description": desc,
        "acceptance_criteria": PITFALL_ACC,
        "dependencies": [],
    }


class PitfallLintTests(unittest.TestCase):
    AFTER = bead_lint.PITFALLS_CUTOVER
    CUT = bead_lint.parse_iso(bead_lint.PITFALLS_CUTOVER)
    BEFORE = (CUT - timedelta(microseconds=1)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")

    def pitfall_failures(self, desc: str, created_at=None, labels=None) -> list[str]:
        bead = build_bead(desc, created_at or self.AFTER, labels)
        return [f for f in bead_lint.lint_bead_failures(bead) if f.startswith("p-pitfalls")]

    def test_pitfall_missing_section_refused_naming_section_and_fix(self):
        failures = self.pitfall_failures(PITFALL_DESC)
        self.assertEqual(len(failures), 1, failures)
        self.assertIn("PITFALLS_MISSING", failures[0])
        self.assertIn("has no Pitfalls section", failures[0])
        self.assertIn("## Pitfalls", failures[0])
        self.assertIn("omp-kit-brief:", failures[0])

    def test_pitfall_feature_beads_are_judged_too(self):
        self.assertEqual(len(self.pitfall_failures(PITFALL_DESC, labels=["kind:feature"])), 1)

    def test_pitfall_placeholder_or_empty_section_refused(self):
        for section in ("## Pitfalls\n", "## Pitfalls\n- none\n", "Pitfalls: n/a\n",
                        "## Pitfalls\n- TBD later\n", "## Pitfalls\n- careful\n\nWHERE: x\n",
                        "## Pitfalls\n\n## Steps\n- refuse the widget in all paths\n"):
            with self.subTest(section=section):
                failures = self.pitfall_failures(PITFALL_DESC + section)
                self.assertEqual(len(failures), 1, failures)
                self.assertIn("no concrete item", failures[0])

    def test_pitfall_concrete_section_admitted(self):
        for section in (
            "## Pitfalls\n- Never write /tmp; use omp-kit scratch new.\n",
            "Pitfalls:\n1. src/cli.ts is held by another seat\n",
            "Pitfalls: never raise the 15s box-lint timeout to pass\n",
            "**Pitfalls**\n* commit-preflight must print 0 refused\n",
        ):
            with self.subTest(section=section):
                self.assertEqual(self.pitfall_failures(PITFALL_DESC + section), [])

    def test_pitfall_brief_digest_line_admitted(self):
        self.assertEqual(self.pitfall_failures(PITFALL_DESC + BRIEF + "\n"), [])
        # A malformed digest is no substitute.
        self.assertEqual(len(self.pitfall_failures(PITFALL_DESC + BRIEF[:-1] + "\n")), 1)

    def test_pitfall_legacy_bead_reported_never_refused(self):
        self.assertEqual(self.pitfall_failures(PITFALL_DESC, created_at=self.BEFORE), [])
        legacy = bead_lint.pitfalls_legacy(build_bead(PITFALL_DESC, self.BEFORE))
        self.assertEqual(len(legacy), 1, legacy)
        self.assertTrue(legacy[0].startswith("PITFALLS_LEGACY fixture-build"), legacy)
        self.assertEqual(bead_lint.pitfalls_legacy(build_bead(PITFALL_DESC, self.AFTER)), [])

    def test_pitfall_non_build_and_closed_beads_unchanged(self):
        self.assertEqual(self.pitfall_failures(PITFALL_DESC, labels=["kind:goal"]), [])
        bead = build_bead(PITFALL_DESC, self.AFTER)
        bead["status"] = "closed"
        self.assertEqual(bead_lint.pitfalls_failure(bead), [])

    def test_pitfall_create_gate_refuses_after_cutover_only(self):
        def create(desc: str, now) -> list[str]:
            parsed = br_create_guard_core.parse_create_args([
                "create", "Pitfall gate create", "-t", "task", "-l", "kind:fix,kind:intake",
                "--description", desc, "--acceptance", PITFALL_ACC,
            ])
            root = str(Path(__file__).resolve().parents[2])
            return [f for f in br_create_guard_core.lint_prospective(parsed, [], root, now=now)
                    if f.startswith("p-pitfalls")]
        refused = create(PITFALL_DESC, self.CUT)
        self.assertEqual(len(refused), 1, refused)
        self.assertIn("<new> is a build bead (kind:fix)", refused[0])
        self.assertEqual(create(PITFALL_DESC + "## Pitfalls\n- never weaken a gate to land\n", self.CUT), [])
        self.assertEqual(create(PITFALL_DESC, self.CUT - timedelta(seconds=1)), [])


LP_DESC = "WHAT: refuse a widget. WHY: the widget leaks.\n## Pitfalls\n- never weaken the gate\n"
LP_PEER = "ompkit-fp72.9.9"
LP_MENTION_DESC = LP_DESC.replace("leaks.", f"leaks, as {LP_PEER} showed.")
LP_CLEAN_ACC = "- [ ] [a] [build] planted bad widget is refused `true` -> rc 0"
LP_PROSE_ACC = "- [ ] [a] [build] planted `widget.ts` record is refused `true` -> rc 0"


class CreateInReviewParityTests(unittest.TestCase):
    """LINTPARITY1 (ompkit-fp72.120.16.238): br create refuses what the in_review handoff refuses."""

    ROWS = [{"id": LP_PEER, "status": "open", "labels": [], "dependencies": []}]

    def create(self, desc=LP_DESC, acc=LP_CLEAN_ACC, extra=()) -> list[str]:
        parsed = br_create_guard_core.parse_create_args([
            "create", "Parity create", "-t", "task", "-l", "kind:fix,kind:intake",
            "--description", desc, "--acceptance", acc, *extra,
        ])
        root = str(Path(__file__).resolve().parents[2])
        return br_create_guard_core.lint_prospective(parsed, self.ROWS, root)

    def in_review(self, desc=LP_DESC, acc=LP_CLEAN_ACC) -> list[str]:
        # The handoff's own checks (br-update-lint.py --status in_review).
        bead = {"id": "fixture-handoff", "status": "open", "issue_type": "task",
                "labels": ["kind:fix", "kind:intake"], "description": desc,
                "acceptance_criteria": acc, "created_at": bead_lint.PITFALLS_CUTOVER,
                "dependencies": []}
        return (bead_lint.lint_bead_failures(bead, {LP_PEER, bead["id"]})
                + bead_lint.replayable_claim_refusal(bead))

    def test_planted_prose_first_backtick_refused_with_in_review_text(self):
        handoff = bead_lint.replayable_claim_refusal({"acceptance_criteria": LP_PROSE_ACC})
        self.assertTrue(handoff and "first backticked span" in handoff[0], handoff)
        refused = [f for f in self.create(acc=LP_PROSE_ACC) if f.startswith("r-verify-replayable")]
        self.assertEqual(len(refused), 1, refused)
        for line in handoff:
            self.assertIn(line, refused[0])

    def test_control_clean_create_admitted(self):
        self.assertEqual(self.in_review(), [])
        self.assertEqual(self.create(), [])

    def test_control_mention_with_create_flag_edge_admitted(self):
        for extra in (("--deps", f"related:{LP_PEER}"), ("--parent", LP_PEER)):
            with self.subTest(extra=extra):
                self.assertEqual(self.create(desc=LP_MENTION_DESC, extra=extra), [])

    def test_mutant_without_replay_checks_admits_planted(self):
        real = bead_lint.replayable_findings
        try:
            bead_lint.replayable_findings = lambda *a, **k: ([], [])
            self.assertEqual(self.create(acc=LP_PROSE_ACC), [])
        finally:
            bead_lint.replayable_findings = real
        self.assertTrue(any(f.startswith("r-verify-replayable") for f in self.create(acc=LP_PROSE_ACC)))


class RetiredControlTests(unittest.TestCase):
    """Authorized work is judged by behavior, not tracker presentation."""

    def test_scoped_task_needs_no_label(self):
        bead = build_bead(LP_DESC, bead_lint.PITFALLS_CUTOVER, labels=[])
        self.assertEqual(bead_lint.lint_bead_failures(bead), [])
        self.assertFalse(any(bead_lint.run_lettered([bead], datetime.now(timezone.utc)).values()))

    def test_original_scope_needs_no_matching_prose_letters(self):
        bead = build_bead(
            "WHAT: (a) parse input; (b) reject invalid input. WHY: preserve both behaviors.",
            bead_lint.PITFALLS_CUTOVER, labels=["fixture"])
        self.assertEqual(bead_lint.lint_bead_failures(bead), [])
        self.assertFalse(any(bead_lint.run_lettered([bead], datetime.now(timezone.utc)).values()))

    def test_large_acyclic_dependency_graph_has_no_blanket_cap(self):
        rows = [build_bead(LP_DESC, bead_lint.PITFALLS_CUTOVER, labels=["fixture"])]
        rows[0]["id"] = "retire-root"
        for index in range(25):
            row = dict(rows[0], id=f"retire-child-{index}",
                       dependencies=[bead_lint.dep_to(f"retire-child-{index}", "retire-root")])
            rows.append(row)
        for index in range(6):
            source = f"retire-chain-{index}"
            target = "retire-root" if index == 0 else f"retire-chain-{index - 1}"
            rows.append(dict(rows[0], id=source, dependencies=[bead_lint.dep_to(source, target)]))
        self.assertFalse(any(bead_lint.run_lettered(rows, datetime.now(timezone.utc)).values()))

    def test_authorized_task_needs_no_legacy_plan_citation(self):
        bead = build_bead(LP_DESC, bead_lint.PITFALLS_CUTOVER, labels=["eco"])
        self.assertEqual(bead_lint.lint_bead_failures(bead), [])
        self.assertFalse(any(bead_lint.run_lettered([bead], datetime.now(timezone.utc)).values()))

    def test_historical_reference_does_not_invent_a_dependency(self):
        bead = build_bead(LP_MENTION_DESC, bead_lint.PITFALLS_CUTOVER, labels=["fixture"])
        self.assertEqual(bead_lint.lint_bead_failures(bead, {bead["id"], LP_PEER}), [])
        rows = [bead, dict(bead, id=LP_PEER, description=LP_DESC)]
        self.assertFalse(any(bead_lint.run_lettered(rows, datetime.now(timezone.utc)).values()))

    def test_native_ready_work_needs_no_goal_edge(self):
        bead = build_bead(LP_DESC, bead_lint.PITFALLS_CUTOVER, labels=["fixture"])
        goal = dict(bead, id="retire-goal", labels=["kind:goal"])
        self.assertEqual(bead_lint.lint_bead_failures(bead, graph=[bead, goal]), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
