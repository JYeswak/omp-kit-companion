#!/usr/bin/env python3
"""Rule contract for scripts/tempsafe_check.py (ompkit-dhmzg, TEMPGATE1).

Every construct has a planted positive that must fire (so an empty result on a
quiet fixture is never trusted unverified) and near-miss negatives that must
stay quiet; suppression, exemption, shebang detection and the git ratchet are
judged on real inputs.
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
import textwrap
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("tempsafe_check", ROOT / "scripts" / "tempsafe_check.py")
if _spec is None or _spec.loader is None:
    raise ImportError("cannot load scripts/tempsafe_check.py")
checker = importlib.util.module_from_spec(_spec)
sys.modules["tempsafe_check"] = checker
_spec.loader.exec_module(checker)
pysafe = sys.modules["pysafe"]
kitlib_tmp = importlib.import_module("kitlib_tmp")  # scripts/ is on sys.path once the checker loads

EXT = {"ts": "fixture.ts", "py": "fixture.py", "sh": "fixture.sh"}


def judge(lang: str, source: str):
    return checker.check_source(textwrap.dedent(source).encode(), EXT[lang], lang)


def active(lang: str, source: str) -> list:
    return [(f.line, f.rule) for f in judge(lang, source).active()]


# (lang, source, line that must fire, construct named in the detail)
FIRE = [
    ("ts", 'const d = mkdtempSync(join(base, "x"));\n', 1, "mkdtemp"),
    ("ts", "await fs.promises.mkdtemp(prefix);\n", 1, "mkdtemp"),
    ("ts", "const make = fs.mkdtempSync;\n", 1, "mkdtemp"),
    ("ts", "const t = os.tmpdir();\n", 1, "tmpdir()"),
    ("ts", 'const root = join(tmpdir(), `omp-kit-migrate-omp-${process.pid}`);\n', 1, "tmpdir()"),
    ("ts", 'const p = "/tmp/fake-home";\n', 1, '"/tmp" path literal'),
    ("ts", "const p = '/tmp/' + name;\n", 1, '"/tmp" path literal'),
    ("ts", 'const p = "/tmp"\n  + "/x";\n', 1, '"/tmp" path literal'),
    ("ts", 'const p = join("/tmp", name);\n', 1, '"/tmp" path literal'),
    ("ts", "const p = path.join( '/tmp/', name);\n", 1, '"/tmp" path literal'),
    ("ts", 'const p = resolve("/tmp", name);\n', 1, '"/tmp" path literal'),
    ("ts", 'const p = path.resolve("/tmp");\n', 1, '"/tmp" path literal'),
    ("ts", "const p = `/tmp/run-${pid}`;\n", 1, '"/tmp" path literal'),
    ("ts", "const p = `/tmp/${pid}`;\n", 1, '"/tmp" path literal'),
    ("ts", 'const s = `a ${`b ${"/tmp/x"}`}`;\n', 1, '"/tmp" path literal'),
    ("ts", "const r = /'/;\nconst d = mkdtempSync(p);\n", 2, "mkdtemp"),
    ("ts", "x = total / count; y = mkdtempSync(p); z = k / 2;\n", 1, "mkdtemp"),
    ("ts", "/* a\n block */ const d = mkdtempSync(p);\n", 2, "mkdtemp"),
    ("py", "import tempfile\nd = tempfile.mkdtemp()\n", 2, "tempfile.mkdtemp"),
    ("py", "from tempfile import mkdtemp as md\nmd()\n", 2, "tempfile.mkdtemp"),
    ("py", "import tempfile as tf\nwith tf.TemporaryDirectory() as d:\n    pass\n", 2, "tempfile.TemporaryDirectory"),
    ("py", "import tempfile\nfd, p = tempfile.mkstemp()\n", 2, "tempfile.mkstemp"),
    ("py", "import tempfile\np = tempfile.mktemp()\n", 2, "tempfile.mktemp"),
    ("py", "import tempfile\nroot = tempfile.gettempdir()\n", 2, "tempfile.gettempdir"),
    ("py", "import tempfile\nf = tempfile.NamedTemporaryFile(delete=False)\n", 2, "delete=False"),
    ("py", "import tempfile\nf = tempfile.NamedTemporaryFile(delete=keep)\n", 2, "delete=False"),
    ("py", 'p = "/tmp/x"\n', 1, '"/tmp" path literal'),
    ("py", 'import os\np = os.path.join("/tmp", name)\n', 2, '"/tmp" path literal'),
    ("py", 'from os.path import join\np = join("/tmp/", name)\n', 2, '"/tmp" path literal'),
    ("py", 'p = "/tmp" + "/x"\n', 1, '"/tmp" path literal'),
    ("py", "p = '/tmp/' + name\n", 1, '"/tmp" path literal'),
    ("py", 'from pathlib import Path\np = Path("/tmp") / name\n', 2, '"/tmp" path literal'),
    ("py", 'from pathlib import Path\np = Path("/tmp").joinpath(name)\n', 2, '"/tmp" path literal'),
    ("py", 'p = f"/tmp/{name}"\n', 1, '"/tmp" path literal'),
    ("py", 'p = f"/tmp{name}"\n', 1, '"/tmp" path literal'),
    ("sh", "d=$(mktemp -d)\n", 1, "mktemp"),
    ("sh", "mktemp -d x.XXXXXX\n", 1, "mktemp"),
    ("sh", "d=`mktemp`\n", 1, "mktemp"),
    ("sh", "if ! d=$(mktemp -d); then exit 1; fi\n", 1, "mktemp"),
    ("sh", "true && command mktemp -d\n", 1, "mktemp"),
    ("sh", 'work=$(/usr/bin/mktemp -d "$base/omp-kit-work.XXXXXXXX")\n', 1, "mktemp"),
    ("sh", "/bin/mktemp -d x.XXXXXX\n", 1, "mktemp"),
    ("sh", "cat <<EOF\nx=`/usr/bin/mktemp`\nEOF\n", 2, "mktemp"),
    ("sh", "true; /opt/" + "a" * 300 + "/mktemp -d\n", 1, "mktemp"),
    ("sh", "/x-mktemp/mktemp -d\n", 1, "mktemp"),
    ("sh", 'x="${TMPDIR:-/tmp}/a"\n', 1, "$TMPDIR"),
    ("sh", 'x="/tmp/$name"\n', 1, "/tmp path"),
    ("sh", "cd $TMPDIR\n", 1, "$TMPDIR"),
    ("sh", "out=/tmp/out.log\n", 1, "/tmp path"),
    ("sh", 'cp a "/tmp/b"\n', 1, "/tmp path"),
    ("sh", "trap 'rm -rf \"$TMPDIR/x\"' EXIT\n", 1, "$TMPDIR"),
    ("sh", "cat <<EOF\nx=$(mktemp)\nEOF\n", 2, "mktemp"),
    ("sh", "cat <<-EOF\n\ty=${TMPDIR}/a\n\tEOF\nd=$(mktemp)\n", 2, "$TMPDIR"),
    ("sh", "cat <<-EOF\n\tbody\n\tEOF\nd=$(mktemp)\n", 4, "mktemp"),
    ("sh", "awk '\n# not a comment\n' f\nd=$(mktemp)\n", 4, "mktemp"),
    ("sh", "cat <<'A' <<'B'\nmktemp\nA\nmktemp\nB\nd=$(mktemp)\n", 6, "mktemp"),
]

QUIET = [
    ("ts", "// const d = mkdtempSync(tmpdir());\n"),
    ("ts", "/* os.tmpdir() */\n"),
    ("ts", 'const s = "call mkdtempSync( here and tmpdir()";\n'),
    ("ts", "const r = /mkdtemp\\(/;\n"),
    ("ts", 'const p = "/tmpfoo"; const q = "a/tmp/b"; const v = "/var/tmp/x";\n'),
    ("ts", "const t = `${base}/tmp/x`;\n"),
    ("ts", "const s = `x ${ {a: 1}.a } mkdtemp(`;\n"),
    ("ts", "const mytmpdir = 1; getTmpdir(); ownedTmp(\"label\");\n"),
    ("ts", "const msg = '/tmp is never used';\n"),
    ("ts", 'run({ cwd: "/tmp", env });\n'),
    ("ts", "const p = '/tmp';\nconst q = `/tmp`;\nconst r = '/tmp/';\n"),
    ("ts", 'expect(cwd).toBe("/tmp");\nconst roots = ["/tmp", "/var"];\n'),
    ("ts", 'const p = base + "/tmp";\nconst q = join(base, "/tmp");\nconst r = spawn("/tmp", args);\n'),
    ("ts", 'if (dir === "/tmp") count += 1;\n'),
    ("py", "import tempfile\nf = tempfile.NamedTemporaryFile()\ng = tempfile.NamedTemporaryFile(delete=True)\nh = tempfile.TemporaryFile()\n"),
    ("py", "# tempfile.mkdtemp()\ns = 'tempfile.mkdtemp()'\n"),
    ("py", "def mkdtemp():\n    return 1\nmkdtemp()\n"),
    ("py", 'p = f"{base}/tmp/x"\nq = "/tmpx"\nr = "/var/tmp"\n'),
    ("py", 'run(cmd, cwd="/tmp")\np = "/tmp"\nq = base + "/tmp"\nr = f"/tmp"\n'),
    ("py", 'import os\np = os.path.join(base, "/tmp")\nok = path == "/tmp/"\nroots = ["/tmp"]\n'),
    ("py", 'from pathlib import Path\np = Path("/tmp")\nq = Path("/tmp").exists()\n'),
    ("py", "import kitlib_tmp\nwith kitlib_tmp.owned_tmp('x') as d:\n    pass\n"),
    ("sh", "# d=$(mktemp -d)\n"),
    ("sh", 'echo "mktemp failed"\nprintf \'use mktemp\\n\'\n'),
    ("sh", 'echo $# "${x#/tmp}"\n'),
    ("sh", "cat <<'EOF'\nd=$(mktemp)\n/tmp/x $TMPDIR\nEOF\n"),
    ("sh", "cat <<EOF\nwrite to /tmp/x here\nEOF\n"),
    ("sh", 'p="$dir"/tmp/x; q=var/tmp; r=$HOME/tmp\n'),
    ("sh", "cd /tmp\nTMPDIR=/tmp cmd\n[ \"$d\" = /tmp ] && echo root\n"),
    ("sh", "mktemp_helper; my-mktemp; x.mktemp\n"),
    ("sh", 'ls -l /usr/bin/mktemp; echo "/bin/mktemp missing"; x=/usr/bin/mktemp-wrapper\n'),
    ("sh", './mktemp; bin/mktemp; "$BIN"/mktemp; x-mktemp/mktemp\n'),
    ("sh", 'export TMPDIR="$scratch"\n'),
    ("sh", "cat <<< \"$(echo hi)\"\n"),
]


class Fire(unittest.TestCase):
    def test_each_construct_fires_on_its_planted_positive(self) -> None:
        for lang, source, line, construct in FIRE:
            with self.subTest(lang=lang, source=source):
                report = judge(lang, source)
                hits = [f for f in report.active() if f.rule == "raw-temp" and f.line == line]
                self.assertEqual(len(hits), 1, [f.as_json() for f in report.findings])
                self.assertIn(construct, hits[0].detail)
                self.assertIn(checker.HINT[lang], hits[0].detail)
                self.assertEqual([f.rule for f in report.active()], ["raw-temp"] * len(report.active()))

    def test_near_misses_stay_quiet(self) -> None:
        for lang, source in QUIET:
            with self.subTest(lang=lang, source=source):
                self.assertEqual(active(lang, source), [])

    def test_one_finding_per_line_naming_every_construct(self) -> None:
        report = judge("ts", 'base = mkdtempSync(join(tmpdir(), "omp-kit-context-"));\n')
        self.assertEqual(len(report.active()), 1)
        self.assertIn("mkdtemp, tmpdir()", report.active()[0].detail)
        report = judge("sh", 'tmp=$(mktemp -d "${TMPDIR:-/tmp}/x.XXXXXX"); log=/tmp/run.log\n')
        self.assertIn("mktemp, $TMPDIR, /tmp path", report.active()[0].detail)

    def test_python_parse_error_is_a_finding(self) -> None:
        self.assertEqual(active("py", "def (:\n"), [(1, "parse-error")])

    def test_too_large(self) -> None:
        source = b"x = 1\n" * (checker.MAX_FILE_BYTES // 6 + 1)
        self.assertEqual([f.rule for f in checker.check_source(source, "big.py", "py").active()], ["too-large"])


class Suppressions(unittest.TestCase):
    def test_reasoned_suppression_hides_the_finding(self) -> None:
        for lang, source in (
            ("ts", "const d = mkdtempSync(p); // tempsafe: owned by the harness cleanup hook\n"),
            ("ts", "const d = mkdtempSync(p); /* tempsafe: owned by the harness cleanup hook */\n"),
            ("py", "import tempfile\nd = tempfile.mkdtemp()  # tempsafe: removed by the caller finally block\n"),
            ("sh", "d=$(mktemp -d)  # tempsafe: removed by the EXIT trap below\n"),
        ):
            with self.subTest(source=source):
                report = judge(lang, source)
                self.assertEqual(report.active(), [])
                self.assertEqual([f.rule for f in report.findings if f.suppressed], ["raw-temp"])

    def test_reasonless_suppression_is_refused_and_does_not_suppress(self) -> None:
        for lang, source in (
            ("ts", "const d = mkdtempSync(p); // tempsafe:\n"),
            ("py", "import tempfile\nd = tempfile.mkdtemp()  # tempsafe: short\n"),
            ("sh", "d=$(mktemp -d)  # tempsafe: oneword-reason\n"),
        ):
            with self.subTest(source=source):
                self.assertEqual(sorted(rule for _, rule in active(lang, source)),
                                 ["raw-temp", "suppression-no-reason"])

    def test_unused_suppression_is_reported(self) -> None:
        self.assertEqual(active("sh", "x=1  # tempsafe: nothing to excuse on this line\n"),
                         [(1, "suppression-unused")])

    def test_prose_mentions_are_not_pragmas(self) -> None:
        self.assertEqual(active("sh", "# tempsafe_check.py judges this file\n# tempsafe gate notes\n"), [])

    def test_pragma_inside_a_string_is_not_a_suppression(self) -> None:
        self.assertEqual(active("ts", 'const d = mkdtempSync("// tempsafe: not a comment at all");\n'),
                         [(1, "raw-temp")])


class Selection(unittest.TestCase):
    def test_exempt_set(self) -> None:
        for path in checker.EXEMPT:
            self.assertTrue(checker.is_exempt(path.rstrip("/") + ("/x.sh" if path.endswith("/") else "")), path)
        self.assertTrue(checker.is_exempt("/abs/repo/src/kitlib/tmp.ts"))
        self.assertFalse(checker.is_exempt("scripts/kitlib_tmp_extra.py"))
        self.assertFalse(checker.is_exempt("src/kitlib/run.ts"))
        self.assertFalse(checker.is_exempt("tests/fixtures/tempsafe-other/x.sh"))

    def test_language_by_extension_and_shebang(self) -> None:
        self.assertEqual(checker.language("a.tsx", b""), "ts")
        self.assertEqual(checker.language("a.cjs", b""), "ts")
        self.assertEqual(checker.language("a.bash", b""), "sh")
        self.assertEqual(checker.language("a.txt", b"#!/bin/sh\n"), None)
        self.assertEqual(checker.language("bin/tool", b"#!/usr/bin/env bash\n"), "sh")
        self.assertEqual(checker.language("bin/tool", b"#!/bin/sh -eu\n"), "sh")
        self.assertEqual(checker.language("bin/tool", b"#!/usr/bin/env -S python3 -B\n"), "py")
        self.assertEqual(checker.language("bin/tool", b"#!/usr/bin/python3.11\n"), "py")
        self.assertEqual(checker.language("bin/tool", b"#!/usr/bin/env node\n"), None)
        self.assertEqual(checker.language("Makefile", b"all:\n"), None)

    def test_pysafe_check_is_not_imported(self) -> None:
        # The staged-pysafe contract plants a hung pysafe_check.py beside this member.
        self.assertNotIn("pysafe_check", sys.modules)


def _git(repo: str, *args: str) -> str:
    result = pysafe.run_bounded(["git", "-C", repo, "-c", "user.email=t@invalid.example", "-c", "user.name=T", *args],
                                30.0)
    if result.outcome != pysafe.OK or result.returncode != 0:
        raise AssertionError(f"git {args}: {result.outcome} {result.returncode} {result.text('stderr')}")
    return result.text().strip()


class Ratchet(unittest.TestCase):
    def setUp(self) -> None:
        owned = kitlib_tmp.owned_tmp("tempsafe-ratchet")
        self.addCleanup(owned.cleanup)
        self.repo = owned.path
        _git(self.repo, "init", "-q")
        self.write("old.sh", "d=$(mktemp -d)\n")
        self.write("notes.txt", "mktemp\n")
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
        self.write("old.sh", "d=$(mktemp -d)\necho unrelated\n")
        _git(self.repo, "add", "old.sh")
        self.assertEqual(self.staged(), [])

    def test_comment_edit_on_an_old_site_does_not_block(self) -> None:
        self.write("old.sh", "d=$(mktemp -d)  # legacy, migrating soon\n")
        _git(self.repo, "add", "old.sh")
        self.assertEqual(self.staged(), [])

    def test_new_identical_site_blocks_once(self) -> None:
        self.write("old.sh", "d=$(mktemp -d)\nd=$(mktemp -d)\n")
        _git(self.repo, "add", "old.sh")
        found = self.staged()
        self.assertEqual(len(found), 1)
        self.assertIn("(1 new of 2 identical)", found[0][3])

    def test_new_file_and_extensionless_script_block(self) -> None:
        self.write("src/a.ts", "const d = mkdtempSync(p);\n")
        self.write("bin/tool", "#!/bin/sh\nd=$(mktemp)\n")
        self.write("bin/data", "mktemp\n")
        self.write("README.md", "mktemp\n")
        _git(self.repo, "add", ".")
        self.assertEqual(sorted((p, line) for p, line, _, _ in self.staged()), [("bin/tool", 2), ("src/a.ts", 1)])

    def test_exempt_paths_are_not_judged(self) -> None:
        self.write("scripts/kitlib-tmp.sh", "d=$(mktemp -d)\n")
        self.write("tests/fixtures/tempsafe/bad.ts", "mkdtempSync(p)\n")
        _git(self.repo, "add", ".")
        self.assertEqual(self.staged(), [])

    def test_rename_keeps_the_old_baseline(self) -> None:
        _git(self.repo, "mv", "old.sh", "moved.sh")
        self.assertEqual(self.staged(), [])

    def test_range_mode_and_cli_exit_codes(self) -> None:
        base = _git(self.repo, "rev-parse", "HEAD")
        self.write("new.py", "import tempfile\nd = tempfile.mkdtemp()\n")
        _git(self.repo, "add", "new.py")
        _git(self.repo, "commit", "-q", "-m", "[test] plant")
        head = _git(self.repo, "rev-parse", "HEAD")
        out = io.StringIO()
        with redirect_stdout(out):
            rc = checker.main(["--repo", self.repo, "--base", base, "--head", head])
        self.assertEqual(rc, 1)
        self.assertIn("new.py:2:5: raw-temp:", out.getvalue())
        self.assertIn("owned_tmp", out.getvalue())
        err = io.StringIO()
        with redirect_stdout(io.StringIO()), redirect_stderr(err):
            self.assertEqual(checker.main(["--repo", self.repo, "--base", head, "--head", head]), 0)
            self.assertEqual(checker.main(["--repo", self.repo, "--head", head]), 1)
            self.assertEqual(checker.main(["--repo", self.repo, "--head", "no-such-rev"]), 2)
        self.assertIn("tempsafe_check: git diff-tree", err.getvalue())

    def test_tree_json_summary(self) -> None:
        out = io.StringIO()
        with redirect_stdout(out):
            rc = checker.main(["--tree", "fixture", self.repo, "--format", "json"])
        self.assertEqual(rc, 1)
        group = json.loads(out.getvalue())["groups"][0]
        self.assertEqual(group["summary"], {"files": 1, "files_with_findings": 1, "findings": 1, "suppressed": 0})
        err = io.StringIO()
        with redirect_stdout(io.StringIO()), redirect_stderr(err):
            self.assertEqual(checker.main([os.path.join(self.repo, "missing")]), 2)
        self.assertIn("no such path", err.getvalue())


if __name__ == "__main__":
    unittest.main()
