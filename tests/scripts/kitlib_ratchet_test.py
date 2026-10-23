#!/usr/bin/env python3
"""Rule contract for scripts/kitlib_ratchet.py (ompkit-qwqh1, KITLIB-RATCHET).

Every raw-spawn construct has a planted positive that must fire (so an empty
result on a quiet fixture is never trusted unverified) and near-miss
negatives that must stay quiet; the kitlib replacement passes; suppression,
exemption, the git ratchet and the CLI follow the shared engine
(scripts/kitlib_ratchet_core.py), which tempsafe_check.py is also built on.
Every fixture repo lives in a kitlib-owned temp dir.
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
import textwrap
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("kitlib_ratchet", ROOT / "scripts" / "kitlib_ratchet.py")
if _spec is None or _spec.loader is None:
    raise ImportError("cannot load scripts/kitlib_ratchet.py")
checker = importlib.util.module_from_spec(_spec)
sys.modules["kitlib_ratchet"] = checker
_spec.loader.exec_module(checker)
core = sys.modules["kitlib_ratchet_core"]
pysafe = sys.modules["pysafe"]
kitlib_tmp = importlib.import_module("kitlib_tmp")  # scripts/ is on sys.path once the checker loads
tempsafe = importlib.import_module("tempsafe_check")

EXT = {"ts": "fixture.ts", "py": "fixture.py", "sh": "fixture.sh"}


def judge(lang: str, source: str):
    return checker.check_source(textwrap.dedent(source).encode(), EXT[lang], lang)


def active(lang: str, source: str) -> list:
    return [(f.line, f.rule) for f in judge(lang, source).active()]


# (lang, source, line that must fire, construct named in the detail)
FIRE = [
    ("py", 'import subprocess\nsubprocess.run(["x"])\n', 2, "subprocess.run"),
    ("py", 'import subprocess as sp\nsp.Popen(["x"])\n', 2, "subprocess.Popen"),
    ("py", 'from subprocess import check_output as co\nco(["x"])\n', 2, "subprocess.check_output"),
    ("py", 'import subprocess\nsubprocess.call(["x"])\n', 2, "subprocess.call"),
    ("py", 'import subprocess\nsubprocess.check_call(["x"])\n', 2, "subprocess.check_call"),
    ("py", 'import subprocess\nsubprocess.getoutput("x")\n', 2, "subprocess.getoutput"),
    ("py", 'from subprocess import getstatusoutput\ngetstatusoutput("x")\n', 2, "subprocess.getstatusoutput"),
    ("py", 'import os\nos.system("x")\n', 2, "os.system"),
    ("py", 'import os\nos.popen("x")\n', 2, "os.popen"),
    ("py", 'import os\nos.spawnvp(os.P_WAIT, "x", ["x"])\n', 2, "os.spawnvp"),
    ("py", 'from os import execvp\nexecvp("x", ["x"])\n', 2, "os.execvp"),
    ("py", 'import os\nos.posix_spawn("x", ["x"], {})\n', 2, "os.posix_spawn"),
    ("py", 'import asyncio\nasyncio.create_subprocess_exec("x")\n', 2, "asyncio.create_subprocess_exec"),
    ("py", 'import asyncio\nasyncio.subprocess.create_subprocess_shell("x")\n', 2,
     "asyncio.subprocess.create_subprocess_shell"),
    ("ts", 'const p = Bun.spawn(["x"]);\n', 1, "Bun.spawn"),
    ("ts", 'const p = Bun.spawnSync(["x"]);\n', 1, "Bun.spawnSync"),
    ("ts", "const original = Bun . spawnSync;\n", 1, "Bun.spawnSync"),
    ("ts", 'import { spawn } from "node:child_process";\nspawn("x");\n', 2, "child_process.spawn"),
    ("ts", "import { execSync as es } from 'child_process';\nes(\"x\");\n", 2, "child_process.execSync"),
    ("ts", 'import { type ChildProcess, fork } from "node:child_process";\nfork("m");\n', 2, "child_process.fork"),
    ("ts", 'import * as cp from "node:child_process";\ncp.execFile("x");\n', 2, "child_process.execFile"),
    ("ts", 'import cp from "child_process";\ncp.spawnSync("x");\n', 2, "child_process.spawnSync"),
    ("ts", 'import cp, { exec } from "child_process";\nexec("x");\n', 2, "child_process.exec"),
    ("ts", 'const cp = require("child_process");\ncp.execFileSync("x");\n', 2, "child_process.execFileSync"),
    ("ts", 'const { spawn: sp } = require("node:child_process");\nsp("x");\n', 2, "child_process.spawn"),
    ("ts", 'const cp = await import("node:child_process");\ncp.spawn("x");\n', 2, "child_process.spawn"),
    ("ts", 'require("child_process").execSync("x");\n', 1, "child_process.execSync"),
    ("sh", "timeout 5 git fetch\n", 1, "timeout N"),
    ("sh", "if timeout -k 2 30s cmd; then :; fi\n", 1, "timeout N"),
    ("sh", "/usr/bin/timeout --signal=KILL 1.5m cmd\n", 1, "timeout N"),
    ("sh", 'x=$(gtimeout "$T" cmd)\n', 1, "timeout N"),
    ("sh", "a && timeout -s TERM 9 cmd &\n", 1, "timeout N"),
    ("sh", "cat <<EOF\n$(timeout 5 cmd)\nEOF\n", 2, "timeout N"),
]

# Near misses and the kitlib replacement: quiet.
QUIET = [
    ("py", 'import kitlib_run\nkitlib_run.run(["x"], deadline_s=5)\n'),
    ("py", 'import pysafe\npysafe.run_bounded(["x"], 5.0)\n'),
    ("py", "import subprocess\nkind = subprocess.Popen\nx = subprocess.DEVNULL\n"),
    ("py", 'import os\nos.path.join("a", "b")\nos.execute = None\n'),
    ("py", 'def run(x):\n    return x\nrun(["x"])\n'),
    ("py", 's = "subprocess.run([\'x\'])"  # subprocess.run in a comment\n'),
    ("ts", 'import { run } from "../src/kitlib/run";\nawait run(["git"], { deadline_s: 30 });\n'),
    ("ts", 'import type { ChildProcess } from "node:child_process";\nconst m = re.exec(s);\n'),
    ("ts", 'const m = /x/.exec(s);\nconst n = matcher.exec(s);\nexec("x");\n'),
    ("ts", "// Bun.spawn([\"x\"])\nconst s = \"Bun.spawn(\";\nconst t = `Bun.spawnSync(${a})`;\n"),
    ("ts", 'import { spawn } from "node:child_process";\nfunction spawn2() {}\nobj.spawn("x");\n'),
    ("ts", 'export { spawn } from "node:child_process";\nspawn("x");\n'),
    ("ts", 'const BunX = 1;\nmyBun.spawn("x");\n'),
    ("sh", "timeout=5\nlocal timeout\necho timeout 5 cmd\n"),
    ("sh", "python3 -B scripts/pysafe.py run --timeout 60 -- cmd\n"),
    ("sh", "# timeout 5 cmd\nx='timeout 5 cmd'\n"),
    ("sh", "timeout 5\ntimeout --help\ntimeout abc cmd\n"),
    ("sh", "cat <<'EOF'\n$(timeout 5 cmd)\nEOF\ncat <<EOF\ntimeout 5 cmd\nEOF\n"),
    ("sh", "my-timeout 5 cmd; x.timeout 5 cmd; ./timeout 5 cmd\n"),
]


class Fire(unittest.TestCase):
    def test_each_construct_fires_on_its_planted_positive(self) -> None:
        for lang, source, line, construct in FIRE:
            with self.subTest(lang=lang, source=source):
                report = judge(lang, source)
                hits = [f for f in report.active() if f.rule == "raw-spawn" and f.line == line]
                self.assertEqual(len(hits), 1, [f.as_json() for f in report.findings])
                self.assertIn(construct, hits[0].detail)
                self.assertIn(checker.HINT[("raw-spawn", lang)], hits[0].detail)
                self.assertIn("outside kitlib", hits[0].detail)
                self.assertEqual([f.rule for f in report.active()], ["raw-spawn"] * len(report.active()))

    def test_near_misses_and_kitlib_stay_quiet(self) -> None:
        for lang, source in QUIET:
            with self.subTest(lang=lang, source=source):
                self.assertEqual(active(lang, source), [])

    def test_hints_name_the_kitlib_replacement(self) -> None:
        self.assertIn("kitlib_run.run", checker.HINT[("raw-spawn", "py")])
        self.assertIn("src/kitlib/run.ts", checker.HINT[("raw-spawn", "ts")])

    def test_one_finding_per_line_naming_every_construct(self) -> None:
        report = judge("ts", 'import { spawn } from "child_process";\nspawn("a"); Bun.spawn(["b"]);\n')
        self.assertEqual(len(report.active()), 1)
        self.assertIn("(child_process.spawn, Bun.spawn)", report.active()[0].detail)

    def test_python_parse_error_is_a_finding(self) -> None:
        self.assertEqual(active("py", "def (:\n"), [(1, "parse-error")])

    def test_too_large(self) -> None:
        source = b"x = 1\n" * (checker.MAX_FILE_BYTES // 6 + 1)
        self.assertEqual([f.rule for f in checker.check_source(source, "big.py", "py").active()], ["too-large"])

    def test_long_near_miss_lines_stay_linear(self) -> None:
        # Adversarial near misses for every regex and hand scanner: long runs
        # of almost-matching text must judge in well under a second.
        cases = [
            ("ts", "Bun." + " " * 200_000 + "spaw\n"),
            ("ts", 'import { spawn } from "child_process";\n' + "spawn " * 50_000 + "\n"),
            ("ts", 'import * as cp from "child_process";\n' + "cp . " * 50_000 + "\n"),
            ("sh", "timeout " + "-k " * 60_000 + "\n"),
            ("sh", "/" + "a/" * 100_000 + "timeoutx 5 cmd\n"),
            ("sh", "x" + "-timeout" * 50_000 + "\n"),
        ]
        for lang, source in cases:
            with self.subTest(lang=lang, head=source[:20]):
                started = time.monotonic()
                judge(lang, source)
                self.assertLess(time.monotonic() - started, 1.0)


class Suppressions(unittest.TestCase):
    def test_reasoned_suppression_hides_the_finding(self) -> None:
        for lang, source in (
            ("ts", 'const p = Bun.spawn(["x"]); // kitlib: harness probe, killed by the test\n'),
            ("ts", 'const p = Bun.spawn(["x"]); /* kitlib: harness probe, killed by the test */\n'),
            ("py", 'import subprocess\nsubprocess.run(["x"])  # kitlib: installer spawns git by design\n'),
            ("sh", "timeout 5 cmd  # kitlib: busybox image has no python3\n"),
        ):
            with self.subTest(source=source):
                report = judge(lang, source)
                self.assertEqual(report.active(), [])
                self.assertEqual([f.rule for f in report.findings if f.suppressed], ["raw-spawn"])

    def test_reasonless_suppression_is_refused_and_does_not_suppress(self) -> None:
        for lang, source in (
            ("ts", 'Bun.spawn(["x"]); // kitlib:\n'),
            ("py", 'import subprocess\nsubprocess.run(["x"])  # kitlib: short\n'),
            ("sh", "timeout 5 cmd  # kitlib: oneword-reason\n"),
        ):
            with self.subTest(source=source):
                self.assertEqual(sorted(rule for _, rule in active(lang, source)),
                                 ["raw-spawn", "suppression-no-reason"])

    def test_unused_suppression_is_reported(self) -> None:
        self.assertEqual(active("sh", "x=1  # kitlib: nothing to excuse on this line\n"),
                         [(1, "suppression-unused")])

    def test_other_ratchets_pragmas_do_not_suppress(self) -> None:
        self.assertEqual(active("py", 'import subprocess\nsubprocess.run(["x"])  # tempsafe: not this ratchet\n'),
                         [(2, "raw-spawn")])
        self.assertEqual(active("sh", "# kitlib_ratchet.py judges this file\n# kitlibs notes\n"), [])

    def test_pragma_inside_a_string_is_not_a_suppression(self) -> None:
        self.assertEqual(active("ts", 'const p = Bun.spawn(["// kitlib: not a comment at all"]);\n'),
                         [(1, "raw-spawn")])


class Selection(unittest.TestCase):
    def test_exempt_set(self) -> None:
        for path in checker.EXEMPT:
            probe = path.rstrip("/") + ("/x.sh" if path.endswith("/") else "")
            self.assertTrue(checker.is_exempt(probe.replace("*", "x")), path)
        for path in ("src/kitlib/run.ts", "/abs/repo/src/kitlib/tmp.ts", "scripts/kitlib_run.py",
                     "scripts/kitlib_ratchet.py", "scripts/kitlib_ratchet_core.py", "scripts/pysafe.py",
                     "/abs/repo/scripts/kitlib_lock.py"):
            self.assertTrue(checker.is_exempt(path), path)
        for path in ("src/kitlib-other/run.ts", "scripts/sub/kitlib_run.py", "scripts/kitlib_run.ts",
                     "scripts/pysafe_check.py", "tests/fixtures/kitlib-ratchet-other/x.py", "src/cli.ts"):
            self.assertFalse(checker.is_exempt(path), path)

    def test_language_by_extension_and_shebang(self) -> None:
        self.assertEqual(checker.language("a.mjs", b""), "ts")
        self.assertEqual(checker.language("bin/tool", b"#!/usr/bin/env -S python3 -B\n"), "py")
        self.assertEqual(checker.language("bin/tool", b"#!/bin/sh -eu\n"), "sh")
        self.assertEqual(checker.language("Makefile", b"all:\n"), None)

    def test_one_engine_two_rule_sets(self) -> None:
        self.assertIs(sys.modules["kitlib_ratchet_core"], core)
        self.assertIsInstance(checker.RULESET, core.RuleSet)
        self.assertIsInstance(tempsafe.RULESET, core.RuleSet)
        self.assertEqual((checker.RULESET.pragma, tempsafe.RULESET.pragma), ("kitlib", "tempsafe"))

    def test_pysafe_check_is_not_imported(self) -> None:
        self.assertNotIn("pysafe_check", sys.modules)


def _git(repo: str, *args: str) -> str:
    result = pysafe.run_bounded(["git", "-C", repo, "-c", "user.email=t@invalid.example", "-c", "user.name=T", *args],
                                30.0)
    if result.outcome != pysafe.OK or result.returncode != 0:
        raise AssertionError(f"git {args}: {result.outcome} {result.returncode} {result.text('stderr')}")
    return result.text().strip()


class Ratchet(unittest.TestCase):
    def setUp(self) -> None:
        owned = kitlib_tmp.owned_tmp("kitlib-ratchet")
        self.addCleanup(owned.cleanup)
        self.repo = owned.path
        _git(self.repo, "init", "-q")
        self.write("old.ts", 'const p = Bun.spawn(["x"]);\n')
        self.write("notes.txt", "Bun.spawn(\n")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-q", "-m", "[test] base")

    def write(self, name: str, text: str) -> None:
        path = Path(self.repo) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def staged(self) -> list:
        reports = checker.ratchet(self.repo, "HEAD", None)
        return [(r.path, f.line, f.rule, f.detail) for r in reports for f in r.active()]

    def test_untouched_site_does_not_block(self) -> None:
        self.write("old.ts", 'const p = Bun.spawn(["x"]);\nconst unrelated = 1;\n')
        _git(self.repo, "add", "old.ts")
        self.assertEqual(self.staged(), [])

    def test_comment_edit_on_an_old_site_does_not_block(self) -> None:
        self.write("old.ts", 'const p = Bun.spawn(["x"]); // legacy, migrating to run()\n')
        _git(self.repo, "add", "old.ts")
        self.assertEqual(self.staged(), [])

    def test_new_identical_site_blocks_once(self) -> None:
        self.write("old.ts", 'const p = Bun.spawn(["x"]);\nconst p = Bun.spawn(["x"]);\n')
        _git(self.repo, "add", "old.ts")
        found = self.staged()
        self.assertEqual(len(found), 1)
        self.assertIn("(1 new of 2 identical)", found[0][3])

    def test_new_file_and_extensionless_script_block(self) -> None:
        self.write("src/a.py", 'import subprocess\nsubprocess.run(["x"])\n')
        self.write("bin/tool", "#!/bin/sh\ntimeout 5 cmd\n")
        self.write("bin/data", "timeout 5 cmd\n")
        self.write("README.md", "timeout 5 cmd\n")
        _git(self.repo, "add", ".")
        self.assertEqual(sorted((p, line) for p, line, _, _ in self.staged()), [("bin/tool", 2), ("src/a.py", 2)])

    def test_exempt_paths_are_not_judged(self) -> None:
        self.write("src/kitlib/run.ts", 'Bun.spawn(["x"]);\n')
        self.write("scripts/pysafe.py", 'import subprocess\nsubprocess.Popen(["x"])\n')
        self.write("tests/fixtures/kitlib-ratchet/bad.ts", 'Bun.spawn(["x"]);\n')
        _git(self.repo, "add", ".")
        self.assertEqual(self.staged(), [])

    def test_rename_keeps_the_old_baseline(self) -> None:
        _git(self.repo, "mv", "old.ts", "moved.ts")
        self.assertEqual(self.staged(), [])

    def test_range_mode_and_cli_exit_codes(self) -> None:
        base = _git(self.repo, "rev-parse", "HEAD")
        self.write("new.py", 'import subprocess\nsubprocess.run(["x"])\n')
        _git(self.repo, "add", "new.py")
        _git(self.repo, "commit", "-q", "-m", "[test] plant")
        head = _git(self.repo, "rev-parse", "HEAD")
        out = io.StringIO()
        with redirect_stdout(out):
            rc = checker.main(["--repo", self.repo, "--base", base, "--head", head])
        self.assertEqual(rc, 1)
        self.assertIn("new.py:2:1: raw-spawn: process spawned outside kitlib (subprocess.run)", out.getvalue())
        self.assertIn("kitlib_run.run", out.getvalue())
        err = io.StringIO()
        with redirect_stdout(io.StringIO()), redirect_stderr(err):
            self.assertEqual(checker.main(["--repo", self.repo, "--base", head, "--head", head]), 0)
            self.assertEqual(checker.main(["--repo", self.repo, "--head", head]), 1)
            self.assertEqual(checker.main(["--repo", self.repo, "--head", "no-such-rev"]), 2)
        self.assertIn("kitlib_ratchet: git diff-tree", err.getvalue())

    def test_tree_json_summary(self) -> None:
        out = io.StringIO()
        with redirect_stdout(out):
            rc = checker.main(["--tree", "fixture", self.repo, "--format", "json"])
        self.assertEqual(rc, 1)
        payload = json.loads(out.getvalue())
        self.assertIn("raw-spawn", payload["rules"])
        group = payload["groups"][0]
        self.assertEqual(group["summary"], {"files": 1, "files_with_findings": 1, "findings": 1, "suppressed": 0})
        err = io.StringIO()
        with redirect_stdout(io.StringIO()), redirect_stderr(err):
            self.assertEqual(checker.main([os.path.join(self.repo, "missing")]), 2)
        self.assertIn("kitlib_ratchet: no such path", err.getvalue())


PY_SPAWN = 'import subprocess\nsubprocess.run(["x"])\n'
PY_KITLIB = 'import kitlib_run\nkitlib_run.run(["x"], deadline_s=5)\n'


class Allowlist(unittest.TestCase):
    """The committed per-repo allowlist (scripts/kitlib-ratchet-baseline.json)."""

    def setUp(self) -> None:
        owned = kitlib_tmp.owned_tmp("kitlib-allowlist")
        self.addCleanup(owned.cleanup)
        self.repo = owned.path
        _git(self.repo, "init", "-q")
        self.write("old.ts", 'const p = Bun.spawn(["x"]);\nconst q = Bun.spawn(["y"]);\n')
        _git(self.repo, "add", "old.ts")
        (Path(self.repo) / "scripts").mkdir()
        self.assertEqual(self.cli("--write-baseline", "--repo", self.repo)[0], 0)
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-q", "-m", "[test] base")

    def write(self, name: str, text: str) -> None:
        path = Path(self.repo) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def allow(self, counts: dict) -> None:
        self.write(checker.BASELINE, checker.render_allowlist({"raw-spawn": counts}))

    def cli(self, *argv: str) -> tuple:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            rc = checker.main(list(argv))
        return rc, out.getvalue(), err.getvalue()

    def staged(self) -> list:
        _git(self.repo, "add", "-A")
        return [(r.path, f.rule, f.detail, f.snippet) for r in checker.ratchet(self.repo, "HEAD", None)
                for f in r.active()]

    def test_baseline_counts_per_path(self) -> None:
        data = json.loads((Path(self.repo) / checker.BASELINE).read_text())
        self.assertEqual((data["counts"], data["totals"]), ({"raw-spawn": {"old.ts": 2}}, {"raw-spawn": 2}))

    def test_planted_new_spawn_refused_naming_kitlib_run_and_kitlib_control_passes(self) -> None:
        self.write("new.py", PY_SPAWN)
        found = self.staged()
        self.assertEqual([(p, rule) for p, rule, _, _ in found], [("new.py", "raw-spawn")])
        self.assertIn("kitlib_run.run", found[0][2])
        self.write("new.py", PY_KITLIB)
        self.assertEqual(self.staged(), [])

    def test_planted_allowlist_increase_refused(self) -> None:
        self.allow({"old.ts": 3})
        self.assertEqual([(p, rule, s) for p, rule, _, s in self.staged()],
                         [(checker.BASELINE, "allowlist-raised", "raw-spawn old.ts: 2 -> 3")])

    def test_planted_allowlist_addition_refused_even_with_its_site(self) -> None:
        self.write("new.py", PY_SPAWN)
        self.allow({"old.ts": 2, "new.py": 1})
        self.assertEqual([(p, rule) for p, rule, _, _ in self.staged()],
                         [("new.py", "raw-spawn"), (checker.BASELINE, "allowlist-raised")])

    def test_planted_entry_removal_passes(self) -> None:
        self.write("old.ts", "export const gone = 1;\n")
        self.allow({})
        self.assertEqual(self.staged(), [])

    def test_planted_count_lowering_passes_only_when_sites_fell(self) -> None:
        self.allow({"old.ts": 1})
        found = self.staged()
        self.assertEqual([(p, rule) for p, rule, _, _ in found], [("old.ts", "raw-spawn")])
        self.assertIn("(2 sites, 1 allowlisted in scripts/kitlib-ratchet-baseline.json)", found[0][2])
        self.write("old.ts", 'const p = Bun.spawn(["x"]);\n')
        self.assertEqual(self.staged(), [])

    def test_pragma_documents_an_allowlisted_site_but_admits_no_new_one(self) -> None:
        self.write("old.ts", 'const p = Bun.spawn(["x"]); // kitlib: legacy probe, migrating to run()\n'
                             'const q = Bun.spawn(["y"]);\n')
        self.assertEqual(self.staged(), [])
        self.write("new.ts", 'export const p = Bun.spawn(["x"]); // kitlib: fixture spawn, the point of it\n')
        found = self.staged()
        self.assertEqual([(p, rule) for p, rule, _, _ in found], [("new.ts", "raw-spawn")])
        self.assertIn("pragma documents an allowlisted site and admits no new one", found[0][2])

    def test_deleting_the_allowlist_with_sites_remaining_is_refused(self) -> None:
        (Path(self.repo) / checker.BASELINE).unlink()
        self.assertEqual([(p, rule) for p, rule, _, _ in self.staged()],
                         [("old.ts", "raw-spawn"), ("old.ts", "raw-spawn"), (checker.BASELINE, "allowlist-deleted")])

    def test_zero_sites_empty_allowlist_passes_and_deleting_it_is_refused(self) -> None:
        self.write("old.ts", "export const gone = 1;\n")
        self.assertEqual(self.cli("--write-baseline", "--repo", self.repo)[0], 0)
        data = json.loads((Path(self.repo) / checker.BASELINE).read_text())
        self.assertEqual((data["counts"], data["totals"]), ({"raw-spawn": {}}, {"raw-spawn": 0}))
        self.assertEqual(self.staged(), [])
        _git(self.repo, "commit", "-q", "-m", "[test] empty allowlist")
        (Path(self.repo) / checker.BASELINE).unlink()
        self.assertEqual([(p, rule) for p, rule, _, _ in self.staged()], [(checker.BASELINE, "allowlist-deleted")])

    def test_after_an_empty_allowlist_a_new_pragmad_site_is_refused(self) -> None:
        self.write("old.ts", "export const gone = 1;\n")
        self.assertEqual(self.cli("--write-baseline", "--repo", self.repo)[0], 0)
        self.staged()
        _git(self.repo, "commit", "-q", "-m", "[test] empty allowlist")
        self.write("new.py", PY_KITLIB)
        self.assertEqual(self.staged(), [])
        self.write("new.ts", 'export const p = Bun.spawn(["x"]); // kitlib: fixture spawn, the point of it\n')
        found = self.staged()
        self.assertEqual([(p, rule) for p, rule, _, _ in found], [("new.ts", "raw-spawn")])
        self.assertIn("(1 sites, 0 allowlisted", found[0][2])

    def test_rename_carries_its_count(self) -> None:
        _git(self.repo, "mv", "old.ts", "moved.ts")
        self.allow({"moved.ts": 2})
        self.assertEqual(self.staged(), [])

    def test_range_mode_refuses_a_raised_allowlist_and_passes_a_removal(self) -> None:
        base = _git(self.repo, "rev-parse", "HEAD")
        self.allow({"old.ts": 5})
        _git(self.repo, "commit", "-qam", "[test] raise")
        rc, out, _ = self.cli("--repo", self.repo, "--base", base, "--head", _git(self.repo, "rev-parse", "HEAD"))
        self.assertEqual(rc, 1)
        self.assertIn("allowlist-raised", out)
        self.write("old.ts", "export const gone = 1;\n")
        self.allow({})
        _git(self.repo, "commit", "-qam", "[test] remove")
        rc, out, _ = self.cli("--repo", self.repo, "--base", base, "--head", _git(self.repo, "rev-parse", "HEAD"))
        self.assertEqual((rc, out), (0, ""))

    def test_check_baseline_and_an_invalid_allowlist(self) -> None:
        self.assertEqual(self.cli("--check-baseline", "--repo", self.repo)[0], 0)
        self.write("new.py", PY_SPAWN)
        _git(self.repo, "add", "new.py")
        rc, out, _ = self.cli("--check-baseline", "--repo", self.repo)
        self.assertEqual(rc, 1)
        self.assertIn("new.py:2:1: raw-spawn:", out)
        self.write(checker.BASELINE, '{"schema": 1, "counts": {"raw-spawn": {"old.ts": 0}}}\n')
        self.assertEqual([(p, rule) for p, rule, _, _ in self.staged()][-1], (checker.BASELINE, "allowlist-invalid"))

    def test_companion_tree_is_within_its_committed_allowlist(self) -> None:
        """CI runs this file: the committed allowlist bounds the whole tracked tree."""
        rc, out, err = self.cli("--check-baseline", "--repo", str(ROOT))
        self.assertEqual(rc, 0, out + err)



if __name__ == "__main__":
    unittest.main()
