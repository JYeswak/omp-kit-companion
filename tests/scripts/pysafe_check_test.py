#!/usr/bin/env python3
"""Rule contract for scripts/pysafe_check.py (ompkit-xa5s.34): every rule has planted fire and quiet fixtures."""
from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
import tempfile
import textwrap
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("pysafe_check", ROOT / "scripts" / "pysafe_check.py")
if _spec is None or _spec.loader is None:
    raise ImportError("cannot load scripts/pysafe_check.py")
checker = importlib.util.module_from_spec(_spec)
sys.modules["pysafe_check"] = checker
_spec.loader.exec_module(checker)
pysafe = sys.modules["pysafe"]


def rules(source: str) -> list:
    report = checker.check_source(textwrap.dedent(source).encode(), "fixture.py")
    return sorted(f.rule for f in report.active())


def suppressed(source: str) -> list:
    report = checker.check_source(textwrap.dedent(source).encode(), "fixture.py")
    return sorted(f.rule for f in report.findings if f.suppressed is not None)


# (rule, fire fixtures, quiet fixtures). A fire fixture yields exactly [rule];
# a quiet fixture yields no finding at all (the near miss the rule must not flag).
CASES = {
    "subprocess-no-timeout": (
        ["import subprocess\nsubprocess.run(['x'], stdin=subprocess.DEVNULL)\n",
         "import subprocess as sp\nsp.check_output(['x'], stdin=sp.DEVNULL)\n",
         "from subprocess import call\ncall(['x'], stdin=None)\n",
         "import os\nos.system('x')\n",
         "import subprocess\nsubprocess.getoutput('x')\n",
         "def f(p):\n    return p.communicate()\n",
         "def f(p):\n    return p.communicate(b'in')\n"],
        ["def f(p):\n    return p.communicate(timeout=5)\n",
         "def f(p):\n    return p.communicate(b'in', 5)\n",
         "import pysafe\npysafe.run_bounded(['x'], 5)\n"],
    ),
    "subprocess-orphan": (
        ["import subprocess\nsubprocess.run(['x'], stdin=subprocess.DEVNULL, timeout=5)\n",
         "import subprocess\nsubprocess.check_output(['x'], input=b'', timeout=5)\n",
         "from subprocess import check_call as cc\ncc(['x'], stdin=None, timeout=1)\n"],
        ["import subprocess\nsubprocess.run(['x'], **{'timeout': 5})\n",
         "import pysafe\npysafe.run_bounded(['x'], 5, input=b'')\n"],
    ),
    "subprocess-stdin-inherit": (
        ["import subprocess\nsubprocess.Popen(['x'])\n",
         "from subprocess import Popen\nPopen(['x'], stdout=-1)\n"],
        ["import subprocess\nsubprocess.Popen(['x'], stdin=subprocess.DEVNULL)\n",
         "import subprocess\nsubprocess.Popen(['x'], stdin=subprocess.PIPE)\n",
         "def Popen(a):\n    return a\nPopen(['x'])\n"],
    ),
    "net-no-timeout": (
        ["import urllib.request\nurllib.request.urlopen('http://h')\n",
         "from urllib.request import urlopen as get\nget('http://h', None)\n",
         "import http.client\nhttp.client.HTTPSConnection('h')\n",
         "import http.client\nhttp.client.HTTPConnection('h', 80)\n",
         "import socket\nsocket.create_connection(('h', 1))\n",
         "import requests\nrequests.get('http://h')\n",
         "import smtplib\nsmtplib.SMTP('h')\n",
         "import socket\ndef f():\n    s = socket.socket()\n    s.connect(('h', 1))\n"],
        ["import urllib.request\nurllib.request.urlopen('http://h', timeout=5)\n",
         "from urllib.request import urlopen\nurlopen('http://h', None, 5)\n",
         "import http.client\nhttp.client.HTTPConnection('h', 80, 5)\n",
         "import socket\nsocket.create_connection(('h', 1), 5)\n",
         "import requests\nrequests.post('http://h', timeout=3)\n",
         "import socket\ndef f():\n    s = socket.socket()\n    s.settimeout(3)\n",
         "import socket\nsocket.setdefaulttimeout(3)\ndef f():\n    return socket.socket()\n"],
    ),
    "wait-no-timeout": (
        ["def f(t):\n    t.join()\n",
         "def f(q):\n    return q.get()\n",
         "def f(q):\n    return q.get(True)\n",
         "def f(q):\n    return q.get(block=True)\n",
         "def f(lock):\n    lock.acquire()\n",
         "def f(lock):\n    lock.acquire(True)\n",
         "def f(ev):\n    ev.wait()\n",
         "def f(fut):\n    return fut.result()\n",
         "def f(sel):\n    return sel.select()\n",
         "import select\nselect.select([1], [], [])\n",
         "import os\nos.wait()\n",
         "import os\nos.waitpid(1, 0)\n",
         "import concurrent.futures\nconcurrent.futures.wait([])\n",
         "import signal\nsignal.pause()\n"],
        ["', '.join(['a'])\n",
         "def f(d):\n    return d.get('k')\n",
         "def f(t):\n    t.join(5)\n",
         "def f(q):\n    return q.get(timeout=1)\n",
         "def f(q):\n    return q.get(False)\n",
         "def f(lock):\n    lock.acquire(False)\n",
         "def f(lock):\n    lock.acquire(timeout=2)\n",
         "def f(ev):\n    ev.wait(1)\n",
         "def f(fut):\n    return fut.result(timeout=3)\n",
         "import select\nselect.select([1], [], [], 1)\n",
         "import os\nos.waitpid(1, os.WNOHANG)\n",
         "import os\nos.path.join('a', 'b')\n"],
    ),
    "stdin-no-tty-guard": (
        ["x = input('name? ')\n",
         "import sys\ndata = sys.stdin.read()\n",
         "import sys\nline = sys.stdin.readline()\n",
         "from sys import stdin\ndata = stdin.read()\n",
         "import sys\nfor line in sys.stdin:\n    pass\n",
         "import json, sys\njson.load(sys.stdin)\n",
         "import os\nos.read(0, 10)\n"],
        ["import sys\ndef f():\n    if sys.stdin.isatty():\n        return ''\n    return sys.stdin.read()\n",
         "import os, sys\ndef f():\n    if os.isatty(0):\n        return None\n    return input()\n",
         "import pysafe\ndef f():\n    return pysafe.read_stdin(5)\n",
         "def input():\n    return 'x'\ninput()\n",
         "import os\nos.read(5, 10)\n"],
    ),
    "unbounded-read": (
        ["def f(proc):\n    return proc.stdout.read()\n",
         "def f(proc):\n    return proc.stderr.readlines()\n",
         "from urllib.request import urlopen\ndef f():\n    r = urlopen('http://h', timeout=5)\n    return r.read()\n",
         "from urllib.request import urlopen\ndef f():\n    with urlopen('http://h', timeout=5) as r:\n        return r.read()\n",
         "def f(conn):\n    return conn.getresponse().read()\n",
         "def f(s):\n    return s.makefile('rb').read(-1)\n"],
        ["def f(proc):\n    return proc.stdout.read(4096)\n",
         "def f(p):\n    return open(p).read()\n",
         "from urllib.request import urlopen\ndef f():\n    r = urlopen('http://h', timeout=5)\n    return r.read(1024)\n",
         "import sys\ndef f():\n    return sys.stdout.read()\n"],
    ),
    "unbounded-loop": (
        ["def f():\n    while True:\n        work()\n",
         "def f(fh):\n    while True:\n        x = fh.read(10)\n        if not x:\n            break\n",
         "def f(items):\n    while True:\n        for x in items:\n            break\n",
         "def f():\n    while 1:\n        def g():\n            return 1\n"],
        ["import time\ndef f(deadline):\n    while True:\n        if time.monotonic() > deadline:\n            break\n",
         "def f():\n    attempts = 0\n    while True:\n        attempts += 1\n        if attempts > 3:\n            raise RuntimeError\n",
         "def f(done):\n    while not done():\n        pass\n",
         "import time, sys\ndef f(end):\n    while True:\n        if time.time() >= end:\n            sys.exit(0)\n"],
    ),
}


class Rules(unittest.TestCase):
    def test_every_rule_has_cases(self) -> None:
        judged = set(CASES) | {"suppression-no-reason", "suppression-unused", "parse-error", "too-large"}
        self.assertEqual(judged, set(checker.RULES))

    def test_fire_fixtures(self) -> None:
        for rule, (fire, _quiet) in CASES.items():
            for source in fire:
                with self.subTest(rule=rule, source=source):
                    self.assertEqual(rules(source), [rule])

    def test_quiet_fixtures(self) -> None:
        for rule, (_fire, quiet) in CASES.items():
            for source in quiet:
                with self.subTest(rule=rule, source=source):
                    self.assertEqual(rules(source), [])

    def test_location_and_scope(self) -> None:
        report = checker.check_source(b"import subprocess\nclass C:\n    def m(self):\n        subprocess.Popen(['x'])\n", "f.py")
        (finding,) = report.active()
        self.assertEqual((finding.line, finding.col, finding.scope), (4, 9, "C.m"))

    def test_parse_error_and_too_large(self) -> None:
        self.assertEqual(rules("def (:\n"), ["parse-error"])
        big = b"x = 1\n" * (checker.MAX_FILE_BYTES // 6 + 1)
        self.assertEqual([f.rule for f in checker.check_source(big, "big.py").active()], ["too-large"])


class Suppressions(unittest.TestCase):
    CALL = "import subprocess\nsubprocess.run(['x'], stdin=subprocess.DEVNULL)"

    def test_reasoned_suppression_silences(self) -> None:
        source = self.CALL + "  # pysafe: wrapper whose caller bounds the run\n"
        self.assertEqual((rules(source), suppressed(source)), ([], ["subprocess-no-timeout"]))

    def test_rule_scoped_suppression(self) -> None:
        source = self.CALL + "  # pysafe(subprocess-no-timeout): wrapper whose caller bounds it\n"
        self.assertEqual(rules(source), [])

    def test_wrong_rule_named_leaves_finding_and_is_unused(self) -> None:
        source = self.CALL + "  # pysafe(net-no-timeout): names the wrong rule here\n"
        self.assertEqual(rules(source), ["subprocess-no-timeout", "suppression-unused"])

    def test_missing_short_or_unknown_reason_is_refused(self) -> None:
        for comment in ("# pysafe:", "# pysafe: ok", "# pysafe", "# pysafe(bogus-rule): a long enough reason", "# pysafe(): a long enough reason"):
            with self.subTest(comment=comment):
                self.assertEqual(rules(self.CALL + "  " + comment + "\n"), ["subprocess-no-timeout", "suppression-no-reason"])

    def test_unused_suppression(self) -> None:
        self.assertEqual(rules("x = 1  # pysafe: nothing here to suppress\n"), ["suppression-unused"])

    def test_string_and_prose_are_not_pragmas(self) -> None:
        self.assertEqual(rules("s = '# pysafe: not a comment at all'\n# pysafe_check.py judges this file\n"), [])

    def test_any_line_of_a_multiline_call(self) -> None:
        source = "import subprocess\nsubprocess.run(\n    ['x'],  # pysafe: wrapper whose caller bounds the run\n    stdin=subprocess.DEVNULL,\n)\n"
        self.assertEqual(rules(source), [])

    def test_loop_suppression_on_header_only(self) -> None:
        header = "def f():\n    while True:  # pysafe: daemon loop ended by SIGTERM\n        work()\n"
        body = "def f():\n    while True:\n        work()  # pysafe: daemon loop ended by SIGTERM\n"
        self.assertEqual(rules(header), [])
        self.assertEqual(rules(body), ["suppression-unused", "unbounded-loop"])


def git(repo: Path, *args: str) -> str:
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@invalid", GIT_COMMITTER_NAME="t",
               GIT_COMMITTER_EMAIL="t@invalid", GIT_CONFIG_NOSYSTEM="1", HOME=str(repo))
    result = pysafe.run_bounded(["git", "-C", str(repo), "-c", "core.hooksPath=/dev/null", *args], 30.0, env=env)
    if not result.ok:
        raise AssertionError(f"git {args}: {result.outcome} {result.returncode} {result.text('stderr')}")
    return result.text().strip()


def run_cli(*args: str) -> tuple:
    out = io.StringIO()
    with redirect_stdout(out):
        code = checker.main(list(args))
    return code, out.getvalue()


BAD = "import subprocess\nsubprocess.run(['x'], stdin=subprocess.DEVNULL)\n"


class Ratchet(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory(prefix="pysafe-ratchet.")
        self.repo = Path(self._dir.name)
        git(self.repo, "init", "-q", "-b", "main")
        (self.repo / "old.py").write_text(BAD)
        git(self.repo, "add", "old.py")
        git(self.repo, "commit", "-q", "-m", "base")

    def tearDown(self) -> None:
        self._dir.cleanup()

    def staged(self) -> tuple:
        return run_cli("--staged", "--repo", str(self.repo))

    def test_untouched_existing_finding_does_not_block(self) -> None:
        (self.repo / "old.py").write_text(BAD + "x = 1\n")
        git(self.repo, "add", "old.py")
        self.assertEqual(self.staged(), (0, ""))

    def test_new_finding_in_existing_file_blocks(self) -> None:
        (self.repo / "old.py").write_text(BAD + "def f(t):\n    t.join()\n")
        git(self.repo, "add", "old.py")
        code, out = self.staged()
        self.assertEqual(code, 1)
        self.assertIn("old.py:4:5: wait-no-timeout", out)
        self.assertNotIn("subprocess-no-timeout", out)

    def test_duplicate_of_existing_finding_blocks(self) -> None:
        (self.repo / "old.py").write_text(BAD + "subprocess.run(['x'], stdin=subprocess.DEVNULL)\n")
        git(self.repo, "add", "old.py")
        code, out = self.staged()
        self.assertEqual(code, 1)
        self.assertIn("(1 new of 2 identical)", out)

    def test_new_file_and_rename(self) -> None:
        git(self.repo, "mv", "old.py", "moved.py")
        self.assertEqual(self.staged(), (0, ""))
        (self.repo / "new.py").write_text(BAD)
        git(self.repo, "add", "new.py")
        code, out = self.staged()
        self.assertEqual(code, 1)
        self.assertIn("new.py:2:1: subprocess-no-timeout", out)

    def test_fix_and_unstaged_files_pass(self) -> None:
        (self.repo / "old.py").write_text("x = 1\n")
        git(self.repo, "add", "old.py")
        (self.repo / "dirty.py").write_text(BAD)  # not staged: never judged
        self.assertEqual(self.staged(), (0, ""))

    def test_index_file_override_is_judged(self) -> None:
        # git commit --only judges a temporary index named by GIT_INDEX_FILE.
        (self.repo / "only.py").write_text(BAD)
        index = self.repo / ".git" / "alt-index"
        env_index = os.environ.get("GIT_INDEX_FILE")
        os.environ["GIT_INDEX_FILE"] = str(index)
        try:
            git(self.repo, "read-tree", "HEAD")
            git(self.repo, "add", "only.py")
            code, out = self.staged()
        finally:
            if env_index is None:
                os.environ.pop("GIT_INDEX_FILE", None)
            else:
                os.environ["GIT_INDEX_FILE"] = env_index
        self.assertEqual(code, 1)
        self.assertIn("only.py:2:1", out)
        self.assertEqual(self.staged(), (0, ""))  # the real index holds nothing new

    def test_commit_range_mode(self) -> None:
        base = git(self.repo, "rev-parse", "HEAD")
        (self.repo / "old.py").write_text(BAD + "import os\nos.system('y')\n")
        git(self.repo, "add", "old.py")
        git(self.repo, "commit", "-q", "-m", "bad")
        code, out = run_cli("--repo", str(self.repo), "--base", base, "--head", "HEAD")
        self.assertEqual(code, 1)
        self.assertIn("old.py:4:1: subprocess-no-timeout", out)
        self.assertEqual(run_cli("--repo", str(self.repo), "--head", base)[0], 1)  # root commit judged whole


class Output(unittest.TestCase):
    def test_md_and_json(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pysafe-out.") as tmp:
            bad = Path(tmp) / "bad.py"
            bad.write_text(BAD + "x = 1  # pysafe: nothing here to suppress\n")
            (Path(tmp) / "good.py").write_text("x = 1\n")
            code, md = run_cli("--tree", "demo", tmp, "--format", "md")
            self.assertEqual(code, 1)
            self.assertIn("| subprocess-no-timeout | 1 | 1 |", md)
            self.assertIn("| files judged | 2 | 2 |", md)
            self.assertIn("2 files judged, 1 with no findings.", md)
            code, raw = run_cli(str(bad), "--format", "json")
            payload = json.loads(raw)
            got = sorted(f["rule"] for f in payload["groups"][0]["files"][0]["findings"])
            self.assertEqual(got, ["subprocess-no-timeout", "suppression-unused"])


if __name__ == "__main__":
    unittest.main()
