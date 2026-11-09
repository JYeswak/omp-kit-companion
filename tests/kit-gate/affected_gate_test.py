#!/usr/bin/env python3
"""Real local pushes through the installed KITGATE1 hook; no mocked test executor.

Exercises scripts/declared-affected-gate.py, scripts/pre-push-affected-gate.sh,
scripts/install-commit-msg-bead.sh, scripts/fresh-gate-ledger.py,
scripts/suite-metrics.py and scripts/br-update-lint.py.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import runpy
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from kitlib_run import run
from kitlib_tmp import owned_tmp

# Same fixture bound as the existing installer integration suite; no timing assertion.
FIXTURE_DEADLINE_S = 180
CONFIG = {"version": 1, "rules": [{"prefix": "scripts/cc/", "tests": ["scripts/cc/cc_selftest.py"]}],
          "sibling_selftests": True}
SELFTEST = '''import os
from pathlib import Path
assert Path("scripts/cc/value.py").read_text() == "answer = 42\\n"
assert os.environ["TMPDIR"].startswith(str(Path.cwd() / "var" / "agent-tmp"))
assert (Path(os.environ["TMPDIR"]) / ".owner").is_file()
assert Path(".git").is_dir()
assert os.getpriority(os.PRIO_PROCESS, 0) >= 10
print("cc selftest: 5 pass")
'''


def command(argv: list[str], cwd: Path, *, good: bool = True) -> str:
    result = run(argv, cwd=str(cwd), env=dict(os.environ, GIT_CEILING_DIRECTORIES=str(cwd.parent)),
                 deadline_s=FIXTURE_DEADLINE_S, max_output_bytes=8 << 20)
    output = (result.stdout + result.stderr).decode(errors="replace")
    assert not result.timed_out and not result.killed and not result.truncated, output
    assert (result.rc == 0) == good, output
    return output


def put(repo: Path, name: str, value: str) -> None:
    path = repo / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value)


def commit(repo: Path, message: str) -> str:
    command(["git", "add", "."], repo)
    command(["git", "commit", "-qm", "[test] " + message], repo)
    return command(["git", "rev-parse", "HEAD"], repo).strip()


def main() -> None:
    with owned_tmp("affected-gate-test") as directory:
        work = Path(directory)
        repo, remote = work / "repo", work / "remote.git"
        repo.mkdir()
        command(["git", "init", "-q", "-b", "main"], repo)
        command(["git", "config", "user.name", "Gate Fixture"], repo)
        command(["git", "config", "user.email", "gate@example.invalid"], repo)
        command(["git", "config", "core.hooksPath", ".git/hooks"], repo)
        command(["git", "init", "-q", "--bare", str(remote)], repo)
        command(["git", "remote", "add", "origin", str(remote)], repo)
        put(repo, "README.md", "Fixture repository\n")
        baseline = commit(repo, "baseline")
        command(["git", "push", "-q", "origin", "main"], repo)
        put(repo, ".omp-kit/affected-tests.json", json.dumps(CONFIG))
        put(repo, "scripts/cc/value.py", "answer = 42\n")
        put(repo, "scripts/cc/cc_selftest.py", SELFTEST)
        green = commit(repo, "cc positive")
        put(repo, "scripts/cc/cc_selftest.py", SELFTEST.replace('== "answer = 42', '!= "answer = 42'))
        red = commit(repo, "cc inverted assertion")
        put(repo, "scripts/cc/README.md", "Documentation only\n")
        docs = commit(repo, "documentation only")
        put(repo, "scripts/sibling.py", "answer = 42\n")
        put(repo, "scripts/sibling_selftest.py", 'from sibling import answer\nassert answer == 42\n')
        sibling = commit(repo, "sibling selftest")
        put(repo, "scripts/uncovered.py", "answer = 0\n")
        uncovered = commit(repo, "uncovered code")
        command(["sh", str(ROOT / "scripts/install-commit-msg-bead.sh"), "--no-pushed-beads", str(repo)], repo)
        command(["sh", str(ROOT / "scripts/install-commit-msg-bead.sh"), "--check", "--no-pushed-beads", str(repo)], repo)
        hook = repo / ".git/hooks/hooks.d/pre-push/42-omp-kit-affected-gate"
        assert hook.is_file() and os.access(hook, os.X_OK), "gate member was not installed"
        helpers = ("declared-affected-gate.py", "fresh-gate-ledger.py", "suite-metrics.py",
                   "suite-hermetic-env.sh", "fixed-env.sh", "kitlib_run.py", "kitlib_tmp.py", "pysafe.py")
        assert all(not os.access(hook.parent / name, os.X_OK) for name in helpers)
        print("PASS installer/check own the non-executable dependency closure")
        # The working tree deliberately disagrees with the good candidate.
        put(repo, "scripts/cc/cc_selftest.py", "raise AssertionError('dirty checkout must not run')\n")
        positive = command(["git", "push", "origin", green + ":main"], repo)
        assert "cc selftest: 5 pass" in positive and "measured-verdict" in positive
        ledger = repo / ".git/omp-kit/fresh-gate-runs.jsonl"
        rows = [json.loads(line) for line in ledger.read_text().splitlines()]
        assert len(rows) == 1 and rows[0]["commit"] == green and rows[0]["base"] == baseline
        assert rows[0]["version"] == 2 and rows[0]["rc"] == 0 and rows[0]["evidence"]["complete"] is True
        assert rows[0]["evidence"]["declared_files"] == ["scripts/cc/cc_selftest.py"]
        assert rows[0]["tests_ran"] == rows[0]["selected_files"] == 1
        print("PASS exact-commit cc selftest, owned TMPDIR, nice priority, complete GREEN")
        shim = runpy.run_path(str(ROOT / "scripts/br-update-lint.py"))
        assert shim["_fresh_green"](str(repo), green)
        assert not shim["_fresh_green"](str(repo), red)
        print("PASS unchanged handoff reader admits only the observed commit")
        # Dirty checkout passes, but the pushed selftest has its assertion inverted.
        put(repo, "scripts/cc/cc_selftest.py", SELFTEST)
        negative = command(["git", "push", "origin", red + ":main"], repo, good=False)
        assert "AssertionError" in negative and "RED" in negative
        assert command(["git", "--git-dir", str(remote), "rev-parse", "main"], repo).strip() == green
        assert len(ledger.read_text().splitlines()) == 1 and not shim["_fresh_green"](str(repo), red)
        print("PASS planted negative: inverted cc assertion refuses push and writes no GREEN")
        # Seed the remote's already-published state to isolate a docs-only range.
        command(["git", "--git-dir", str(remote), "fetch", "-q", str(repo), red], repo)
        command(["git", "--git-dir", str(remote), "update-ref", "refs/heads/main", red], repo)
        docs_output = command(["git", "push", "origin", docs + ":main"], repo)
        assert "DOCS_ONLY" in docs_output and "affected selftest:" not in docs_output
        assert len(ledger.read_text().splitlines()) == 1 and not shim["_fresh_green"](str(repo), docs)
        print("PASS docs under scripts/cc run nothing and record nothing")
        command(["git", "push", "origin", sibling + ":main"], repo)
        rows = [json.loads(line) for line in ledger.read_text().splitlines()]
        assert len(rows) == 2 and rows[-1]["evidence"]["declared_files"] == ["scripts/sibling_selftest.py"]
        print("PASS sibling selftest selected independently of cc")
        refusal = command(["git", "push", "origin", uncovered + ":main"], repo, good=False)
        assert "NO_AFFECTED_TESTS" in refusal and len(ledger.read_text().splitlines()) == 2
        print("PASS uncovered code is refused without GREEN")
        print("affected gate: 7 pass, 0 fail")


if __name__ == "__main__":
    main()
