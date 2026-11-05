#!/usr/bin/env python3
"""RELRUBRIC3: mechanism evidence cannot earn a field-effect release verdict."""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from kitlib_tmp import owned_tmp  # noqa: E402  (owned temporary repos, removed on every exit)
from pysafe import run_bounded  # noqa: E402  (bounded capture, deadline and whole-group cancellation)

CHECKER = ROOT / "scripts" / "release-card-check.py"
CURRENT = "0.2.95"


def card(decision: str, *, producer: str = "measure-seat-outcomes --paired", sigma: str = "0",
         differences: tuple[int, ...] = (2,), result_verdict: str = "") -> str:
    rows = "\n".join(f"| {index} | {60 + difference} | 60 | 3 | 3 |"
                     for index, difference in enumerate(differences, 1))
    return f"""# Release card

## 1. Gap lane

| Bead | Defect | State |
|---|---|---|
| fix-1 | the director could not be reached | closed |

## 2. Optimization lane

| # | Idea | Hypothesis and measure | Evidence | Decision |
|---|---|---|---|---|
| 1 | **REACH1** | fewer failed reach paths | recorded paired readings | {decision} |

### Prereg REACH1

endpoint: failed reach paths
 direction: lower
producer: {producer}
unit: paths
mde: 1
mde_source: one failed reach path
sigma_d: {sigma}
sigma_source: registered paired differences
alpha: 0.05
power: 0.8
n_pairs: {len(differences)}
stopping: fixed-n; no peeking
control: unchanged target and paired load

### Result REACH1

ncpu: 32

| pair | before | after | load1_before | load1_after |
|---|---|---|---|---|
{rows}

{result_verdict}

## 3. Measures

| Measure | Before | After |
|---|---|---|
| Change lead time | 4 min | read after install |

## 4. Error budget

Within budget at the before checkpoint.
"""


class ReleaseCardCheckTest(unittest.TestCase):
    def setUp(self) -> None:
        scratch = owned_tmp("release-card-check-test")
        self.addCleanup(scratch.cleanup)
        self.repo = Path(scratch.path) / "repo"
        (self.repo / "docs" / "releases").mkdir(parents=True)
        self.env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull,
                        GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_COUNT="0", GIT_TERMINAL_PROMPT="0",
                        HOME=scratch.path, TMPDIR=scratch.path, PYTHONDONTWRITEBYTECODE="1")
        for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
                     "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR"):
            self.env.pop(name, None)
        self.git("init", "-q")

    def run_command(self, *argv: str) -> tuple[int, str]:
        result = run_bounded(list(argv), cwd=self.repo, env=self.env, timeout=30, cap_bytes=1 << 20)
        output = result.text("stdout") + result.text("stderr")
        self.assertEqual(result.outcome, "OK", output)
        self.assertFalse(result.stdout_truncated or result.stderr_truncated, output)
        return result.returncode, output

    def git(self, *args: str) -> str:
        rc, output = self.run_command("git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
                                      "-c", "user.name=RELRUBRIC3 test", "-c", "user.email=relrubric3@example.invalid",
                                      *args)
        self.assertEqual(rc, 0, output)
        return output.strip()

    def commit_card(self, text: str, version: str = CURRENT) -> str:
        name = f"docs/releases/v{version}.md"
        (self.repo / name).write_text(text, encoding="utf-8")
        self.git("add", "--", name)
        self.git("commit", "-qm", "[test] release card")
        return self.git("rev-parse", "HEAD")

    def check(self, version: str = CURRENT) -> tuple[int, str]:
        return self.run_command(sys.executable, "-B", str(CHECKER), "--repo", str(self.repo),
                                "--rev", "HEAD", "--version", version)

    def test_planted_single_deterministic_pair_cannot_claim_shipped(self) -> None:
        self.commit_card(card("applied, effect: SHIPPED"))
        rc, output = self.check()
        self.assertEqual(rc, 1, output)
        self.assertIn("RELEASE_EVIDENCE_CLASS", output)
        self.assertIn("MECHANISM", output)
        self.assertIn("MECHANISM VERIFIED", output)

    def test_bare_applied_is_also_an_effect_claim(self) -> None:
        self.commit_card(card("applied"))
        rc, output = self.check()
        self.assertEqual(rc, 1, output)
        self.assertIn("MECHANISM", output)

    def test_control_same_pair_as_mechanism_verified_passes(self) -> None:
        self.commit_card(card("MECHANISM VERIFIED"))
        rc, output = self.check()
        self.assertEqual(rc, 0, output)
        self.assertIn("REACH1 MECHANISM VERIFIED (n=1, mean d 2 paths", output)
        self.assertNotIn("SHIPPED", output)
        self.assertNotIn("applied:", output)

    def test_explicit_fixture_or_mutant_arm_is_not_a_field_effect(self) -> None:
        # Replication and nonzero SD cannot turn a synthetic arm into field evidence.
        for producer in ("measure --arm fixture", "measure --arm mutant"):
            with self.subTest(producer=producer):
                self.commit_card(card("applied, effect", producer=producer, sigma="1",
                                      differences=(2, 3, 2, 3, 2, 3, 2, 3, 2, 3)))
                rc, output = self.check()
                self.assertEqual(rc, 1, output)
                self.assertIn("MECHANISM", output)

    def test_mechanism_decision_cannot_hide_a_shipped_result(self) -> None:
        self.commit_card(card("MECHANISM VERIFIED", result_verdict="verdict: SHIPPED"))
        rc, output = self.check()
        self.assertEqual(rc, 1, output)
        self.assertIn("MECHANISM", output)

    def test_control_real_seat_pair_series_keeps_effect_verdict(self) -> None:
        self.commit_card(card("applied, effect", sigma="1", differences=(2, 3, 2, 3, 2, 3, 2, 3, 2, 3)))
        rc, output = self.check()
        self.assertEqual(rc, 0, output)
        self.assertIn("REACH1 SHIPPED (n=10", output)
        self.assertIn("FIELD EFFECT", output)

    def test_control_historical_deterministic_card_is_unchanged(self) -> None:
        sha = self.commit_card(card("applied"), "0.2.94")
        rc, output = self.check("0.2.94")
        self.assertEqual(rc, 0, output)
        self.assertEqual(output, f"RELEASE_CARD_OK docs/releases/v0.2.94.md at {sha}: 1 gap row(s) closed or landed; "
                         "1 idea(s), applied: REACH1; REACH1 SHIPPED "
                         "(n=1, mean d 2 paths, 95% CI 2..2 paths, mde 1 paths)\n")

    def test_pending_v0295_card_reports_mechanism_verified(self) -> None:
        # The pending card uses the new grammar, without changing its preregistration or result.
        text = (ROOT / "docs" / "releases" / "v0.2.95.md").read_text(encoding="utf-8")
        self.commit_card(text)
        rc, output = self.check()
        self.assertEqual(rc, 0, output)
        self.assertIn("DIRECTORREACH1 MECHANISM VERIFIED (n=1, mean d 2 paths, s_d 0 paths", output)
        self.assertNotIn("SHIPPED", output)

    def test_checker_reads_committed_card_not_working_bytes(self) -> None:
        self.commit_card(card("applied"))
        (self.repo / f"docs/releases/v{CURRENT}.md").write_text(card("MECHANISM VERIFIED"), encoding="utf-8")
        rc, output = self.check()
        self.assertEqual(rc, 1, output)
        self.assertIn("MECHANISM", output)


if __name__ == "__main__":
    unittest.main()
