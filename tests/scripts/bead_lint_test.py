#!/usr/bin/env python3
"""RELLINT1: release-goal admission follows the real release dry-run, not bead closure."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import bead_lint


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


if __name__ == "__main__":
    unittest.main(verbosity=2)
