#!/usr/bin/env python3
"""Contract tests for the BRINITPIN1 br-init ratchet."""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("br_init_check", ROOT / "scripts" / "br_init_check.py")
if _spec is None or _spec.loader is None:
    raise ImportError("cannot load scripts/br_init_check.py")
checker = importlib.util.module_from_spec(_spec)
sys.modules["br_init_check"] = checker
_spec.loader.exec_module(checker)

EXT = {"ts": "fixture.ts", "py": "fixture.py", "sh": "fixture.sh"}


def active(lang: str, source: str, path: str | None = None) -> list[tuple[int, str]]:
    report = checker.check_source(source.encode("utf-8"), path or EXT[lang], lang)
    return [(finding.line, finding.rule) for finding in report.active()]


class JavaScriptCalls(unittest.TestCase):
    def test_unpinned_direct_and_wrapper_calls_fire(self) -> None:
        self.assertEqual(active("ts", 'run(["br", "init"]);'), [(1, "unpinned-br-init")])
        self.assertEqual(active("ts", 'brun(["init"]);'), [(1, "unpinned-br-init")])
        self.assertEqual(active("ts", 'run(["br", "init"], { env: process.env });'), [(1, "unpinned-br-init")])

    def test_own_database_flag_or_inline_environment_passes(self) -> None:
        self.assertEqual(active("ts", 'run(["br", "init", "--db", join(dir, ".beads", "beads.db")]);'), [])
        self.assertEqual(active("ts", 'run(["br", "init"], { env: { ...process.env, BEADS_DB: join(dir, ".beads", "beads.db") } });'), [])
        self.assertEqual(active("ts", 'runBr(["init", "--prefix", prefix], database.database, database.directory);'), [])

    def test_fixture_br_calls_cannot_inherit_the_callers_tracker(self) -> None:
        self.assertEqual(active("ts", 'brun(["create", "probe"], dir);'), [(1, "inherited-br-call")])
        self.assertEqual(active("ts", 'brun(["create", "probe"], dir, { BEADS_DB: join(dir, ".beads", "beads.db") });'), [])
        self.assertEqual(active("ts", 'run(["br", "create"], { env: process.env });'), [(1, "inherited-br-call")])
        self.assertEqual(active("ts", 'run(["br", "create"], { env: { BEADS_DB: join(dir, ".beads", "beads.db") } });'), [])

    def test_non_init_br_wrappers_are_not_init_sites(self) -> None:
        self.assertEqual(active("ts", 'spawnSync("br", [...args, "--db", database], { cwd });'), [])

    def test_database_options_are_not_mistaken_for_the_environment(self) -> None:
        source = 'run(["br", "init"], { BEADS_DB: join(dir, ".beads", "beads.db") });'
        self.assertEqual(active("ts", source), [(1, "unpinned-br-init")])


    def test_strings_comments_and_unrelated_calls_are_not_commands(self) -> None:
        source = '''// run(["br", "init"]);
const note = 'run(["br", "init"])';
log(["br", "init"]);
'''
        self.assertEqual(active("ts", source), [])

    def test_comment_pragma_cannot_suppress_a_callsite(self) -> None:
        self.assertEqual(active("ts", '// brinit: test-only reason\nrun(["br", "init"]);'), [(2, "unpinned-br-init")])


class PythonCalls(unittest.TestCase):
    def test_unpinned_argv_and_shell_calls_fire(self) -> None:
        self.assertEqual(active("py", 'subprocess.run(["br", "init"])'), [(1, "unpinned-br-init")])
        self.assertEqual(active("py", 'subprocess.run("br init", shell=True)'), [(1, "unpinned-br-init")])
        self.assertEqual(active("py", 'brun(["init"])'), [(1, "unpinned-br-init")])

    def test_own_database_flag_or_inline_environment_passes(self) -> None:
        self.assertEqual(active("py", 'subprocess.run(["br", "init", "--db", str(root / ".beads" / "beads.db")])'), [])
        self.assertEqual(active("py", 'subprocess.run(["br", "init"], env={**os.environ, "BEADS_DB": str(root / ".beads" / "beads.db")})'), [])
        self.assertEqual(active("py", 'subprocess.run(["br", "init"], env=os.environ.copy())'), [(1, "unpinned-br-init")])

    def test_fixture_br_calls_cannot_inherit_the_callers_tracker(self) -> None:
        self.assertEqual(active("py", 'brun(["create"], root)'), [(1, "inherited-br-call")])
        self.assertEqual(active("py", 'subprocess.run(["br", "create"], cwd=root)'), [(1, "inherited-br-call")])
        self.assertEqual(active("py", 'subprocess.run(["br", "create"], env=os.environ.copy())'), [(1, "inherited-br-call")])
        self.assertEqual(active("py", 'subprocess.run(["br", "create"], env={**os.environ, "BEADS_DB": str(root / ".beads" / "beads.db")})'), [])
        self.assertEqual(active("py", 'brun(["create"], root, env=fixture_env)'), [])
        self.assertEqual(active("py", 'brun(["create"], root, env=fixture.env)'), [])

    def test_database_options_are_not_mistaken_for_the_environment(self) -> None:
        source = 'subprocess.run(["br", "init"], {"BEADS_DB": str(root / ".beads" / "beads.db")})'
        self.assertEqual(active("py", source), [(1, "unpinned-br-init")])


class ShellCalls(unittest.TestCase):
    def test_unpinned_and_inherited_calls_fire(self) -> None:
        self.assertEqual(active("sh", "br " + "\\" + "\ninit\n"), [(1, "unpinned-br-init")])
        self.assertEqual(active("sh", 'br init ' + "\\" + '\n  --db "$child/.beads/beads.db"\n'), [])
        self.assertEqual(active("sh", "echo 'br " + "\\" + "\ninit'\n"), [])
        self.assertEqual(active("sh", "br init -vv\n"), [(1, "unpinned-br-init")])
        self.assertEqual(active("sh", "exec br init -vv\n"), [(1, "unpinned-br-init")])
        self.assertEqual(active("sh", 'echo "br init"\n'), [])
        self.assertEqual(active("sh", 'value="$(br init)"\n'), [(1, "unpinned-br-init")])
        self.assertEqual(active("sh", "br init; echo --db /else/.beads/beads.db\n"), [(1, "unpinned-br-init")])
        self.assertEqual(active("sh", "printf 'br init\\n'\n"), [])
        self.assertEqual(active("sh", "cat <<EOF\n$(br init)\nEOF\n"), [(2, "unpinned-br-init")])
        self.assertEqual(active("sh", 'value="$(echo "$(br init)")"\n'), [(1, "unpinned-br-init")])
        self.assertEqual(active("sh", "value=`br init`\n"), [(1, "unpinned-br-init")])
        self.assertEqual(active("sh", "value='$(br init)'\n"), [])
        self.assertEqual(active("sh", r"value=\$(br init)\n"), [])
        self.assertEqual(active("sh", r'value="\$(br init)"' + "\n"), [])
        self.assertEqual(active("sh", 'value="$(br init --db "$child/.beads/beads.db")"\n'), [])


    def test_continued_finding_keeps_original_start_line(self) -> None:
        report = checker.check_source(("br " + "\\" + "\ninit\n").encode("utf-8"), "continued.sh", "sh")
        self.assertEqual([(finding.line, finding.snippet) for finding in report.active()], [(1, "br \\")])


    def test_own_database_flag_or_inline_environment_passes(self) -> None:
        self.assertEqual(active("sh", 'br init --db "$child/.beads/beads.db"\n'), [])
        self.assertEqual(active("sh", 'BEADS_DB="$child/.beads/beads.db" br init\n'), [])
        self.assertEqual(active("sh", 'br init --db "$db"\n'), [(1, "unpinned-br-init")])

    def test_fixture_br_calls_cannot_inherit_the_callers_tracker(self) -> None:
        self.assertEqual(active("sh", "br create probe\n"), [(1, "inherited-br-call")])
        self.assertEqual(active("sh", 'BEADS_DB="$child/.beads/beads.db" br create probe\n'), [])
        self.assertEqual(active("sh", 'br create probe --db "$child/.beads/beads.db"\n'), [])

    def test_only_the_planted_fixture_is_exempt(self) -> None:
        self.assertTrue(checker.RULESET.is_exempt("tests/fixtures/br-init/unpinned.sh"))
        self.assertFalse(checker.RULESET.is_exempt("tests/fixtures/br-init/other.sh"))


if __name__ == "__main__":
    unittest.main()
