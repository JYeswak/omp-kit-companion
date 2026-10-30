#!/usr/bin/env python3
"""bead-lint-cli (ompkit-fp72.135.3.32): `bead_lint.py --bead ID --repo DIR`.

Runs the real CLI with a fake `br` first on PATH. The fake serves `br show`
in the br-show record shape (dependencies carry `id`, not `depends_on_id`) and
`br list` as the tracker id inventory, so the dependency-shape normalization
is exercised exactly as the live tracker presents it. Every refusal has a
planted negative whose control differs only in the planted fault.

Run: python3 tests/scripts/bead_lint_bead_test.py
"""
from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
import bead_lint  # noqa: E402  (the matcher under test, for the in-process planted revert)
import kitlib_tmp  # noqa: E402  (owned temp dirs: removed on exit and HUP/INT/TERM)
from pysafe import run_bounded  # noqa: E402  (cancel-safe spawn: own process group, stdin DEVNULL, hard deadline)

# The literal repo path lets scripts/affected-tests.ts select this suite when bead_lint.py
# changes; a pathlib join hides it from the focused gate (ompkit-fp72.135.3.52).
BEAD_LINT = str(ROOT / "scripts/bead_lint.py")
FAKE_BR = """#!/usr/bin/env python3
import json, os, sys
if os.environ.get("FAKE_BR_FAIL"):
    sys.stderr.write("fake br: tracker unreadable\\n")
    sys.exit(1)
state = json.load(open(os.environ["FAKE_BR_STATE"], encoding="utf-8"))
args = sys.argv[1:]
if args and args[0] == "show":
    print(json.dumps([state["bead"]]))
    sys.exit(0)
if args and args[0] == "list":
    print(json.dumps({"issues": [{"id": i} for i in state["ids"]]}))
    sys.exit(0)
sys.exit(2)
"""
OTHER = "lintcli-other-target-bead"


def clean_bead(**overrides) -> dict:
    bead = {
        "id": "lintcli-bead-one",
        "title": "lint cli fixture",
        "status": "open",
        "priority": 1,
        "issue_type": "task",
        "labels": ["kit"],
        "description": "WHAT: (a) the fixture does one thing. WHY: the cli needs a clean case.",
        "acceptance_criteria": (
            "- [ ] [a] [build] the fixture passes\n"
            "- [ ] [a] [build] planted negative: the broken fixture is refused"
        ),
        "created_at": "2026-10-26T05:00:00Z",
        "dependencies": [],
    }
    bead.update(overrides)
    return bead


class BeadCli(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.work = kitlib_tmp.owned_tmp("bead-lint-cli-test")
        cls.root = Path(cls.work.path)
        cls.bin = cls.root / "bin"
        cls.bin.mkdir()
        (cls.bin / "br").write_text(FAKE_BR, encoding="utf-8")
        (cls.bin / "br").chmod(0o700)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.work.cleanup()

    def invoke(self, bead: dict, *, ids: list[str] | None, fail_br: bool, extra: list[str]) -> tuple[int, str]:
        state = self.root / f"state-{self.id().rsplit('.', 1)[-1]}.json"
        state.write_text(json.dumps({"bead": bead, "ids": ids or [bead["id"]]}), encoding="utf-8")
        env = {
            "PATH": f"{self.bin}:{os.environ.get('PATH', '/usr/bin:/bin')}",
            "HOME": str(self.root),
            "FAKE_BR_STATE": str(state),
        }
        if fail_br:
            env["FAKE_BR_FAIL"] = "1"
        result = run_bounded([sys.executable, BEAD_LINT, "--bead", bead["id"], "--repo", str(self.root), *extra],
                             60, env=env, cwd=str(self.root))
        self.assertEqual(result.outcome, "OK")
        return result.returncode, result.stdout.decode("utf-8", "replace")

    def run_cli(self, bead: dict, *, ids: list[str] | None = None, fail_br: bool = False) -> tuple[int, dict]:
        code, out = self.invoke(bead, ids=ids, fail_br=fail_br, extra=["--json"])
        return code, json.loads(out)

    def test_plain_output_names_verdict_and_failing_checks(self) -> None:
        code, out = self.invoke(clean_bead(labels=[]), ids=None, fail_br=False, extra=[])
        self.assertEqual(code, 1, out)
        self.assertTrue(out.startswith("FAIL "), out)
        self.assertIn("a-label", out)
        code, out = self.invoke(clean_bead(), ids=None, fail_br=False, extra=[])
        self.assertEqual((code, out.split()[0]), (0, "PASS"), out)
        code, out = self.invoke(clean_bead(), ids=None, fail_br=True, extra=[])
        self.assertEqual((code, out.split()[0]), (3, "UNVERIFIED"), out)

    def test_clean_bead_passes(self) -> None:
        code, verdict = self.run_cli(clean_bead())
        self.assertEqual((code, verdict["verdict"], verdict["failures"]), (0, "PASS", []), verdict)

    def test_missing_labels_fails_naming_check(self) -> None:
        code, verdict = self.run_cli(clean_bead(labels=[]))
        self.assertEqual((code, verdict["verdict"]), (1, "FAIL"), verdict)
        self.assertIn("a-label", verdict["failures"])

    def test_mention_with_br_show_shaped_edge_passes(self) -> None:
        bead = clean_bead(
            description=f"WHAT: (a) builds on {OTHER}. WHY: the cli needs a mention case.",
            dependencies=[{"id": OTHER, "dependency_type": "related", "status": "open", "title": "other"}],
        )
        code, verdict = self.run_cli(bead, ids=[bead["id"], OTHER])
        self.assertEqual((code, verdict["verdict"]), (0, "PASS"), verdict)

    def test_mention_without_edge_fails(self) -> None:
        bead = clean_bead(description=f"WHAT: (a) builds on {OTHER}. WHY: the cli needs a mention case.")
        code, verdict = self.run_cli(bead, ids=[bead["id"], OTHER])
        self.assertEqual((code, verdict["verdict"]), (1, "FAIL"), verdict)
        self.assertIn("i-mention-edges", verdict["failures"])

    def test_unreadable_tracker_is_unverified_never_pass(self) -> None:
        code, verdict = self.run_cli(clean_bead(), fail_br=True)
        self.assertEqual((code, verdict["verdict"]), (3, "UNVERIFIED"), verdict)

    # LINTIDBOUND1 (ompkit-fp72.135.3.83): a parent id is never read inside a child id.
    PARENT = "lintcli-par"
    CHILD = "lintcli-par.1"
    SIBLING = "lintcli-par.19"
    CHILD_TEXT = "WHAT: (a) the fixture does one thing. WHY: parent: lintcli-par\ndiscovered-from: lintcli-par.19"
    CHILD_EDGES = [
        {"id": PARENT, "dependency_type": "parent-child", "status": "open", "title": "parent"},
        {"id": SIBLING, "dependency_type": "discovered-from", "status": "open", "title": "sibling"},
    ]
    CHILD_ONLY_TEXT = "WHAT: (a) the fixture does one thing. WHY: discovered-from: lintcli-par.19"

    def test_child_only_text_does_not_infer_parent(self) -> None:
        bead = clean_bead(id=self.CHILD, description=self.CHILD_ONLY_TEXT, dependencies=self.CHILD_EDGES)
        code, verdict = self.run_cli(bead, ids=[self.CHILD, self.PARENT, self.SIBLING])
        self.assertEqual((code, verdict["verdict"], verdict["failures"]), (0, "PASS", []), verdict)

    def test_child_id_never_mentions_its_parent(self) -> None:
        # The ompkit-t7cn7.21 shape: parent metadata is structural; discovered-from names its child.
        # With the old \b matcher that relation also appears to apply to the parent prefix.
        bead = clean_bead(id=self.CHILD, description=self.CHILD_TEXT, dependencies=self.CHILD_EDGES)
        code, verdict = self.run_cli(bead, ids=[self.CHILD, self.PARENT, self.SIBLING])
        self.assertEqual((code, verdict["verdict"], verdict["failures"]), (0, "PASS", []), verdict)

    def test_sentence_final_id_still_needs_its_edge(self) -> None:
        bead = clean_bead(description=f"WHAT: (a) the fixture does one thing. WHY: it builds on {self.PARENT}.")
        code, verdict = self.run_cli(bead, ids=[bead["id"], self.PARENT])
        self.assertEqual((code, verdict["verdict"]), (1, "FAIL"), verdict)
        self.assertIn("i-mention-edges", verdict["failures"])

    def test_scan_reads_whole_ids_only(self) -> None:
        text = "see lintcli-par. then lintcli-par.19.2, lintcli-par.19; not lintcli-par.19a or v1.lintcli-par"
        self.assertEqual([m.group(1) for m in bead_lint.BEAD_MENTION_RE.finditer(text)],
                         ["lintcli-par", "lintcli-par.19.2", "lintcli-par.19"])
        # Bounded adversarial input: one long near-id that fails only at its end, then a real id.
        pump = "a" + "-a" * 20000 + ".1" * 20000 + "x"
        self.assertEqual([m.group(1) for m in bead_lint.BEAD_MENTION_RE.finditer(pump + " lintcli-par")],
                         ["lintcli-par"])

    def test_planted_old_word_boundary_reads_the_parent_inside_the_child(self) -> None:
        bead = {"id": self.CHILD, "description": self.CHILD_TEXT.lower(),
                "dependencies": [{"depends_on_id": e["id"], "type": e["dependency_type"]} for e in self.CHILD_EDGES]}
        byid = {self.CHILD, self.PARENT, self.SIBLING}
        self.assertEqual(bead_lint.check_i([bead], byid), [])
        real = (bead_lint._ID_START, bead_lint._ID_END, bead_lint.BEAD_MENTION_RE)
        bead_lint._ID_START, bead_lint._ID_END = r"\b", r"\b"
        bead_lint.BEAD_MENTION_RE = bead_lint.re.compile(r"\b([a-z][a-z0-9]*(?:-[a-z0-9]+)+(?:\.[0-9]+(?:\.[0-9]+)*)?)\b")
        try:
            self.assertEqual(bead_lint.check_i([bead], byid), [self.CHILD])
        finally:
            bead_lint._ID_START, bead_lint._ID_END, bead_lint.BEAD_MENTION_RE = real


if __name__ == "__main__":
    unittest.main()
