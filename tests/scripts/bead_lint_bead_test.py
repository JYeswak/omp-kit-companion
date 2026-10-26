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
import kitlib_tmp  # noqa: E402  (owned temp dirs: removed on exit and HUP/INT/TERM)
from pysafe import run_bounded  # noqa: E402  (cancel-safe spawn: own process group, stdin DEVNULL, hard deadline)

BEAD_LINT = str(SCRIPTS / "bead_lint.py")
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


if __name__ == "__main__":
    unittest.main()
