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
DEPENDENT_SELFTEST = '''import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dep
assert dep.answer == 42
print("dep selftest: 1 pass")
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
        # ompkit-1ra0d.66: deleting code and its suite needs no covering test.
        # The cc restoration above left the tree dirty against HEAD, so drop it;
        # uncovered.py never reached the remote, so drop it too: the pushed
        # range is deletions only.
        command(["git", "checkout", "--", "scripts/cc/cc_selftest.py"], repo)
        command(["git", "rm", "-q", "scripts/sibling.py", "scripts/sibling_selftest.py", "scripts/uncovered.py"], repo)
        deleted = commit(repo, "delete sibling and its selftest")
        deletion_output = command(["git", "push", "origin", deleted + ":main"], repo)
        assert "deleted-only: 2 paths" in deletion_output and "DOCS_ONLY" in deletion_output
        assert len(ledger.read_text().splitlines()) == 2
        print("PASS deletion-only push passes with a deleted-only note and records nothing")
        # Deleting one file does not excuse an uncovered file the same push changes.
        command(["git", "rm", "-q", "scripts/cc/value.py"], repo)
        put(repo, "scripts/uncovered.py", "answer = 1\n")
        mixed = commit(repo, "delete value, change uncovered")
        mixed_refusal = command(["git", "push", "origin", mixed + ":main"], repo, good=False)
        assert "NO_AFFECTED_TESTS" in mixed_refusal and "scripts/uncovered.py" in mixed_refusal
        assert "scripts/cc/value.py" not in mixed_refusal
        assert len(ledger.read_text().splitlines()) == 2
        print("PASS delete-plus-uncovered still refuses naming only the kept file")
        # ompkit-1ra0d.66 follow-up: a deleted module's tip importers join the
        # changed set, so the importing suite runs even though it is unchanged.
        # Outside the scripts/cc/ rule prefix, so the sibling link alone selects it.
        put(repo, "scripts/dep/dep.py", "answer = 42\n")
        put(repo, "scripts/dep/dep_selftest.py", DEPENDENT_SELFTEST)
        # uncovered.py never reached the remote; drop it so the tip does not add it.
        # value.py left with the refused mixed commit rides along silently: nothing
        # in the tree imports it, and the sibling link alone selects the new suite.
        command(["git", "rm", "-q", "scripts/uncovered.py"], repo)
        dep_green = commit(repo, "add dep and its importing suite")
        command(["git", "push", "origin", dep_green + ":main"], repo)
        rows = [json.loads(line) for line in ledger.read_text().splitlines()]
        assert len(rows) == 3
        assert rows[-1]["evidence"]["declared_files"] == ["scripts/dep/dep_selftest.py"]
        print("PASS importing suite selected for its module")
        command(["git", "rm", "-q", "scripts/dep/dep.py"], repo)
        dep_gone = commit(repo, "delete dep, suite still imports it")
        dep_refusal = command(["git", "push", "origin", dep_gone + ":main"], repo, good=False)
        assert "RED" in dep_refusal and "affected selftest: scripts/dep/dep_selftest.py" in dep_refusal
        assert "ModuleNotFoundError" in dep_refusal
        assert len(ledger.read_text().splitlines()) == 3
        print("PASS deleting a still-imported module runs its suite and refuses RED")
        # Planted negative: the pre-fix selection demanded a covering test for
        # every code-suffixed changed path, deleted or not, so it refused the
        # deletion-only push the fixed gate passes above.
        gate_source = (ROOT / "scripts/declared-affected-gate.py").read_text()
        anchor = ("        if not (archive / path).exists():\n"
                  "            if PurePosixPath(path).suffix in FAIL_CLOSED_SUFFIXES:\n"
                  "                # A deleted shell entry point or Rust module fails closed: a\n"
                  "                # covering rule still selects its suites, but with no importer\n"
                  "                # and no rule the removal itself is uncovered.\n"
                  "                matched = False\n"
                  "                for prefix, tests in rules:\n"
                  "                    if path.startswith(prefix):\n"
                  "                        selected.update(tests)\n"
                  "                        matched = True\n"
                  "                if not matched and path not in covered_deleted:\n"
                  "                    uncovered.append(path)\n"
                  "            # Otherwise there is nothing at the tip to cover. Tip files importing\n"
                  "            # it joined the changed set above, so their suites still run.\n"
                  "            continue\n")
        assert anchor in gate_source
        expansion_anchor = ("    by_deleted = _importers_by_deleted(archive, changed)\n"
                            "    for extra in sorted({importer for importers in by_deleted.values() for importer in importers}):\n"
                            "        if extra not in changed:\n"
                            "            changed.append(extra)\n"
                            "    covered_deleted = {path for path, importers in by_deleted.items() if importers}\n")
        assert expansion_anchor in gate_source
        with owned_tmp("affected-gate-mutant") as mdir:
            # main() resolves the repo before judging, so the archive under test
            # is resolve()-clean too; otherwise suite validation trips on the
            # host's symlinked temp root (/var, /tmp on macOS).
            base = Path(mdir).resolve()
            fake = base / "archive"
            (fake / ".omp-kit").mkdir(parents=True)
            (fake / ".omp-kit/affected-tests.json").write_text(json.dumps(CONFIG))
            gate_ns = runpy.run_path(str(ROOT / "scripts/declared-affected-gate.py"))
            assert gate_ns["selection"](fake, ["scripts/gone.py", "scripts/cc/gone.py"]) == []
            assert gate_ns["deleted_code"](fake, ["scripts/gone.py", "scripts/cc/gone.py"]) == ["scripts/cc/gone.py", "scripts/gone.py"]
            (Path(mdir) / "mutant-gate.py").write_text(gate_source.replace(anchor, ""))
            mutant_ns = runpy.run_path(str(Path(mdir) / "mutant-gate.py"))
            try:
                mutant_ns["selection"](fake, ["scripts/gone.py", "scripts/cc/gone.py"])
            except ValueError as error:
                assert "NO_AFFECTED_TESTS" in str(error) and "scripts/gone.py" in str(error)
            else:
                raise AssertionError("planted negative: pre-fix selection passed a deletion-only push")
            # Planted negative for importer expansion: without it, deleting a
            # still-imported module selects nothing and would pass untested.
            fake2 = base / "archive2"
            (fake2 / ".omp-kit").mkdir(parents=True)
            (fake2 / ".omp-kit/affected-tests.json").write_text(json.dumps(CONFIG))
            (fake2 / "scripts" / "dep").mkdir(parents=True)
            (fake2 / "scripts" / "dep" / "dep_selftest.py").write_text(DEPENDENT_SELFTEST)
            assert gate_ns["importers_of_deleted"](fake2, ["scripts/dep/dep.py"]) == ["scripts/dep/dep_selftest.py"]
            assert gate_ns["selection"](fake2, ["scripts/dep/dep.py"]) == ["scripts/dep/dep_selftest.py"]
            (Path(mdir) / "mutant-gate2.py").write_text(gate_source.replace(expansion_anchor, "    covered_deleted = set()\n"))
            mutant2_ns = runpy.run_path(str(Path(mdir) / "mutant-gate2.py"))
            assert mutant2_ns["selection"](fake2, ["scripts/dep/dep.py"]) == []
            # scripts/ fallback: any tip importer of a directly-under-scripts
            # module counts, and with no covering suite the importer itself is
            # uncovered and refuses.
            fake3 = base / "archive3"
            (fake3 / ".omp-kit").mkdir(parents=True)
            (fake3 / ".omp-kit/affected-tests.json").write_text(json.dumps(CONFIG))
            (fake3 / "scripts" / "sub").mkdir(parents=True)
            (fake3 / "scripts" / "sub" / "user.py").write_text("import shared\nprint(shared.answer)\n")
            assert gate_ns["importers_of_deleted"](fake3, ["scripts/shared.py"]) == ["scripts/sub/user.py"]
            try:
                gate_ns["selection"](fake3, ["scripts/shared.py"])
            except ValueError as error:
                assert "NO_AFFECTED_TESTS" in str(error) and "scripts/sub/user.py" in str(error)
                assert "scripts/shared.py" not in str(error)
            else:
                raise AssertionError("expected NO_AFFECTED_TESTS naming the uncovered importer")
            # Fail closed: a deleted .rs or .sh with no importer and no covering
            # rule is itself uncovered and refuses.
            fake4 = base / "archive4"
            (fake4 / ".omp-kit").mkdir(parents=True)
            (fake4 / ".omp-kit/affected-tests.json").write_text(json.dumps(CONFIG))
            for gone in ("lib/x.rs", "scripts/tool.sh"):
                try:
                    gate_ns["selection"](fake4, [gone])
                except ValueError as error:
                    assert "NO_AFFECTED_TESTS" in str(error) and gone in str(error)
                else:
                    raise AssertionError("expected NO_AFFECTED_TESTS for bare deleted " + gone)
            # A covering rule still selects its suites for a deleted .sh.
            (fake4 / "scripts" / "cc").mkdir(parents=True)
            (fake4 / "scripts" / "cc" / "cc_selftest.py").write_text("print('cc selftest: 1 pass')\n")
            assert gate_ns["selection"](fake4, ["scripts/cc/tool.sh"]) == ["scripts/cc/cc_selftest.py"]
            # Unreadable tip files fail the importer scan closed, never skipped.
            fake5 = base / "archive5"
            (fake5 / ".omp-kit").mkdir(parents=True)
            (fake5 / ".omp-kit/affected-tests.json").write_text(json.dumps(CONFIG))
            (fake5 / "scripts" / "cc").mkdir(parents=True)
            (fake5 / "scripts" / "cc" / "cc_selftest.py").write_text("print('cc selftest: 1 pass')\n")
            # victim.py is absent (deleted); broken.py is present but unreadable.
            (fake5 / "scripts" / "cc" / "broken.py").write_bytes(b"\xff\xfe not utf-8\n")
            # Any importer scan over this tree refuses on the unreadable file.
            try:
                gate_ns["selection"](fake5, ["scripts/cc/victim.py", "scripts/cc/broken.py"])
            except ValueError as error:
                assert "importer scan cannot read tip file" in str(error) and "broken.py" in str(error)
            else:
                raise AssertionError("expected the unreadable tip file to refuse")
            (Path(mdir) / "mutant-gate3.py").write_text(gate_source.replace(
                "        except (OSError, UnicodeError):\n"
                "            raise ValueError(\"importer scan cannot read tip file: \" + rel)\n",
                "        except (OSError, UnicodeError):\n"
                "            continue\n"))
            mutant3_ns = runpy.run_path(str(Path(mdir) / "mutant-gate3.py"))
            assert mutant3_ns["selection"](fake5, ["scripts/cc/victim.py", "scripts/cc/broken.py"]) == ["scripts/cc/cc_selftest.py"]
        print("PASS planted negative: the old rule refuses the deletion-only push")
        print("PASS planted negative: no expansion selects nothing for a deleted import")
        print("PASS scripts/ fallback names the uncovered importer; bare .sh/.rs fail closed")
        print("PASS unreadable tip files refuse the importer scan")
        print("affected gate: 14 pass, 0 fail")


if __name__ == "__main__":
    main()
