#!/usr/bin/env python3
"""KITGATE1: judge a repository's declared affected Python selftests on an exact export."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import runpy
import sys
import time

from kitlib_run import run
from kitlib_tmp import owned_tmp
import pysafe

MAP = ".omp-kit/affected-tests.json"
HERE = Path(__file__).resolve().parent
# cc_selftest normally takes 4–7 minutes under load; allow a full hour, never defer it.
SELFTEST_DEADLINE_S = 3600
CODE_SUFFIXES = {".py", ".sh", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".rs"}


def checked(argv: list[str], *, cwd: Path, deadline: int = 30) -> bytes:
    result = run(argv, cwd=str(cwd), deadline_s=deadline, max_output_bytes=16 << 20)
    if result.rc != 0 or result.timed_out or result.killed or result.truncated:
        raise ValueError("command failed or incomplete: " + repr(argv) + " " + result.stderr.decode(errors="replace"))
    return result.stdout


def git(repo: Path, *args: str) -> bytes:
    return checked(["git", "-C", str(repo), *args], cwd=repo)


def relative(value: object) -> str:
    if (not isinstance(value, str) or not value or any(c.isspace() for c in value)
            or "\\" in value or value.startswith("-") or PurePosixPath(value).is_absolute()
            or any(part in (".", "..") for part in value.split("/"))):
        raise ValueError("affected map requires safe repository-relative paths")
    return value


def deleted_code(archive: Path, changed: list[str]) -> list[str]:
    """Product-code paths the pushed range deleted: code-suffixed, outside
    tests/, and absent at the tip. Mirrors the fresh-gate.sh changed_code set
    minus the existence check, inverted."""
    gone = []
    for path in changed:
        if path.startswith("tests/"):
            continue
        if PurePosixPath(path).suffix in CODE_SUFFIXES and not (archive / path).exists():
            gone.append(path)
    return sorted(set(gone))


TS_CODE_SUFFIXES = {".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"}

FAIL_CLOSED_SUFFIXES = {".sh", ".rs"}

# Anchored, linear-time statement matchers (regex-engineering: every repeat is
# fenced by a required literal or an exclusive class, so no nested quantifiers).
# The shell command matcher finds only the command position; its operand is read
# by the native shlex tokenizer, which understands quotes and nesting a flat
# pattern cannot (notably `"$(dirname "$0")/..."`). Heredoc bodies and other
# inert text are read as code: a conservative over-selection that can only add
# suites, never silently drop a real importer.
_TS_FROM_RE = re.compile(r"^[ \t]*(?:import|export)\b[^'\"\n;]*\bfrom[ \t]*[\"'](\.[^\"']+)[\"']")
_TS_SIDE_RE = re.compile(r"^[ \t]*import[ \t]*[\"'](\.[^\"']+)[\"']")
_TS_CALL_RE = re.compile(r"(?:require|import)\([ \t]*[\"'](\.[^\"']+)[\"'][ \t]*\)")
_SH_CMD_RE = re.compile(r"(?:^|[;|&]|\bthen\b|\bdo\b)[ \t]*(?:source|\.)(?=[ \t])")
_PY_IMPORT_RE = re.compile(r"^[ \t]*import[ \t]+([A-Za-z_][A-Za-z0-9_]*(?:[ \t]+as[ \t]+[A-Za-z_][A-Za-z0-9_]*)?(?:[ \t]*,[ \t]*[A-Za-z_][A-Za-z0-9_]*(?:[ \t]+as[ \t]+[A-Za-z_][A-Za-z0-9_]*)?)*)")
_PY_FROM_RE = re.compile(r"^[ \t]*from[ \t]+(\.*[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)[ \t]+import[ \t]")
_PY_DOT_IMPORT_RE = re.compile(r"^[ \t]*from[ \t]+\.[ \t]+import[ \t]+([A-Za-z_][A-Za-z0-9_]*(?:[ \t]+as[ \t]+[A-Za-z_][A-Za-z0-9_]*)?(?:[ \t]*,[ \t]*[A-Za-z_][A-Za-z0-9_]*(?:[ \t]+as[ \t]+[A-Za-z_][A-Za-z0-9_]*)?)*)")

def _strip_code_ext(path: str) -> str:
    stem, dot, ext = path.rpartition(".")
    if dot and ("." + ext.lower()) in TS_CODE_SUFFIXES:
        return stem
    return path

def _strip_sh_ext(path: str) -> str:
    return path[:-len(".sh")] if path.endswith(".sh") else path


def _tip_py_imports_deleted(text: str) -> set[str]:
    """Module stems the source imports: first dotted components of plain imports
    (plus the stem of `scripts.S` forms and the names of `from . import`). The
    caller maps each stem to same-dir and scripts/ candidates, mirroring the
    TS fallback where any importer of scripts/<stem> counts."""
    found = set()
    for line in text.splitlines():
        match = _PY_IMPORT_RE.match(line)
        if match is not None:
            for token in match.group(1).split(","):
                if not token.strip():
                    continue
                parts = token.strip().split()[0].split(".")
                found.add(parts[0])
                if len(parts) > 1 and parts[0] == "scripts":
                    found.add(parts[1])
            continue
        match = _PY_FROM_RE.match(line)
        if match is not None:
            dots, parts = _split_from_module(match.group(1))
            if dots == 0 and parts:
                found.add(parts[0])
                if parts[0] == "scripts" and len(parts) > 1:
                    found.add(parts[1])
            elif dots == 1 and len(parts) == 1:
                found.add(parts[0])
            continue
        match = _PY_DOT_IMPORT_RE.match(line)
        if match is not None:
            for token in match.group(1).split(","):
                if token.strip():
                    found.add(token.strip())
    return found


def _tip_ts_imports_deleted(text: str, parent: str) -> set[str]:
    """Extension-stripped import targets the source names: the caller maps them to
    deleted paths, so one scan serves every deletion in the push."""
    found = set()
    for line in text.splitlines():
        specs: list[str] = []
        match = _TS_FROM_RE.match(line) or _TS_SIDE_RE.match(line)
        if match is not None:
            specs.append(match.group(1))
        else:
            specs.extend(m.group(1) for m in _TS_CALL_RE.finditer(line))
        for spec in specs:
            candidate = PurePosixPath(os.path.normpath(os.path.join(parent, spec))).as_posix()
            found.add(_strip_code_ext(candidate))
    return found


def _resolve_sh_operand(operand: str, parent: str) -> str | None:
    """A shell `source`/`. ` operand resolved against its file: relative,
    repo-relative, or `$(dirname "$0")`-anchored. Env-absolute, bare PATH names,
    and `..` escapes do not resolve."""
    bare = operand.strip()
    if len(bare) >= 2 and ((bare[0] == '"' and bare[-1] == '"') or (bare[0] == "'" and bare[-1] == "'")):
        bare = bare[1:-1].strip()
    anchored = None
    for prefix in ('$(dirname "$0")/', "$(dirname $0)/", "${0%/*}/"):
        if bare.startswith(prefix):
            anchored = prefix
            break
    if anchored is not None:
        candidate = PurePosixPath(os.path.normpath(os.path.join(parent, bare[len(anchored):]))).as_posix()
    elif bare.startswith(("./", "../")):
        candidate = PurePosixPath(os.path.normpath(os.path.join(parent, bare))).as_posix()
    elif bare.startswith(("/", "$")) or "/" not in bare:
        return None
    else:
        candidate = bare
    if candidate.startswith(".."):
        return None
    return _strip_sh_ext(candidate)


def _first_shell_word(rest: str) -> str | None:
    """First shell word after a command, read by the native shlex tokenizer:
    quotes pair, backslash escapes outside single quotes, and `;`/`#`/blanks end
    the word only when unquoted. Unbalanced quotes fail visibly with None: the
    line contributes no importer. The caller resolves the raw word (quotes kept)."""
    lex = shlex.shlex(rest, posix=True)
    lex.whitespace_split = True
    lex.commenters = "#"
    try:
        token = lex.get_token()
    except ValueError:
        return None
    return token or None


def _tip_sh_imports_deleted(text: str, parent: str) -> set[str]:
    """Extension-stripped `source`/`. ` targets the shell source names."""
    found = set()
    for line in text.splitlines():
        for match in _SH_CMD_RE.finditer(line):
            word = _first_shell_word(line[match.end():])
            if word is None:
                continue
            candidate = _resolve_sh_operand(word, parent)
            if candidate is not None:
                found.add(candidate)
    return found


def _split_from_module(raw: str) -> tuple[int, list[str]]:
    dots = len(raw) - len(raw.lstrip("."))
    return dots, [part for part in raw.split(".") if part]


def _importers_by_deleted(archive: Path, changed: list[str]) -> dict[str, list[str]]:
    """Map each deleted code path to the tip files importing it: TS/JS relative
    specifiers (with or without an extension), same-package-dir Python stem
    imports plus `scripts/<stem>` users, and shell `source`/`. ` operands."""
    gone_ts = {path for path in changed
               if PurePosixPath(path).suffix in TS_CODE_SUFFIXES and not (archive / path).exists()}
    gone_py = {path for path in changed
               if PurePosixPath(path).suffix == ".py" and not (archive / path).exists()}
    gone_sh = {path for path in changed
               if PurePosixPath(path).suffix == ".sh" and not (archive / path).exists()}
    if not gone_ts and not gone_py and not gone_sh:
        return {}
    stripped_ts: dict[str, list[str]] = {}
    for path in gone_ts:
        stripped_ts.setdefault(_strip_code_ext(path), []).append(path)
    stripped_sh: dict[str, list[str]] = {}
    for path in gone_sh:
        stripped_sh.setdefault(_strip_sh_ext(path), []).append(path)
    found: dict[str, set[str]] = {}

    def note(deleted: str, rel: str) -> None:
        found.setdefault(deleted, set()).add(rel)

    for file in sorted(archive.rglob("*")):
        if not file.is_file() or file.is_symlink():
            continue
        try:
            rel = file.relative_to(archive).as_posix()
        except ValueError:
            continue
        suffix = PurePosixPath(rel).suffix
        if suffix not in TS_CODE_SUFFIXES and suffix not in (".py", ".sh"):
            continue
        if suffix in TS_CODE_SUFFIXES and not gone_ts:
            continue
        if suffix == ".py" and not gone_py:
            continue
        if suffix == ".sh" and not gone_sh:
            continue
        try:
            text = file.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            raise ValueError("importer scan cannot read tip file: " + rel)
        parent = PurePosixPath(rel).parent.as_posix()
        if suffix in TS_CODE_SUFFIXES:
            for target in _tip_ts_imports_deleted(text, parent):
                for path in stripped_ts.get(target, []):
                    note(path, rel)
        elif suffix == ".py":
            for stem in _tip_py_imports_deleted(text):
                for candidate in (parent + "/" + stem + ".py", "scripts/" + stem + ".py"):
                    if candidate in gone_py:
                        note(candidate, rel)
        elif suffix == ".sh":
            for target in _tip_sh_imports_deleted(text, parent):
                for path in stripped_sh.get(target, []):
                    note(path, rel)
    return {path: sorted(importers) for path, importers in found.items()}


def importers_of_deleted(archive: Path, changed: list[str]) -> list[str]:
    """Tip code files importing a deleted path. The matches join the changed set
    before selection, so the importers' suites run (or NO_AFFECTED_TESTS fires
    when none reaches them).

    Out of scope: dynamic/computed imports of a deleted path (variable
    specifiers, eval, generated `source` lines). Such an importer's own suite
    must be selected some other way: its own change entry, a rule, or a naming
    edge."""
    by_deleted = _importers_by_deleted(archive, changed)
    return sorted({importer for importers in by_deleted.values() for importer in importers})


def selection(archive: Path, changed: list[str]) -> list[str]:
    declaration = json.loads((archive / MAP).read_text())
    if (not isinstance(declaration, dict) or set(declaration) != {"version", "rules", "sibling_selftests"}
            or type(declaration["version"]) is not int or declaration["version"] != 1
            or declaration["sibling_selftests"] is not True
            or not isinstance(declaration["rules"], list) or not declaration["rules"]):
        raise ValueError("invalid affected-tests map version 1")
    rules = []
    for rule in declaration["rules"]:
        if not isinstance(rule, dict) or set(rule) != {"prefix", "tests"}:
            raise ValueError("invalid affected rule")
        prefix = relative(rule["prefix"].rstrip("/")) + "/"
        if not isinstance(rule["tests"], list) or not rule["tests"]:
            raise ValueError("affected rule has no tests")
        tests = [relative(path) for path in rule["tests"]]
        if any(not path.endswith("_selftest.py") for path in tests):
            raise ValueError("declared suites must be Python *_selftest.py files")
        rules.append((prefix, tests))
    selected: set[str] = set()
    uncovered = []
    changed = list(changed)
    by_deleted = _importers_by_deleted(archive, changed)
    for extra in sorted({importer for importers in by_deleted.values() for importer in importers}):
        if extra not in changed:
            changed.append(extra)
    covered_deleted = {path for path, importers in by_deleted.items() if importers}
    for path in changed:
        if PurePosixPath(path).suffix.lower() in {".md", ".rst", ".txt"}:
            continue
        if not (archive / path).exists():
            if PurePosixPath(path).suffix in FAIL_CLOSED_SUFFIXES:
                # A deleted shell entry point or Rust module fails closed: a
                # covering rule still selects its suites, but with no importer
                # and no rule the removal itself is uncovered.
                matched = False
                for prefix, tests in rules:
                    if path.startswith(prefix):
                        selected.update(tests)
                        matched = True
                if not matched and path not in covered_deleted:
                    uncovered.append(path)
            # Otherwise there is nothing at the tip to cover. Tip files importing
            # it joined the changed set above, so their suites still run.
            continue
        matched = False
        for prefix, tests in rules:
            if path.startswith(prefix):
                selected.update(tests)
                matched = True
        candidate = PurePosixPath(path)
        sibling = str(candidate.with_name(candidate.stem + "_selftest.py"))
        if path.endswith("_selftest.py") and (archive / path).is_file():
            selected.add(path)
            matched = True
        elif (archive / sibling).is_file():
            selected.add(sibling)
            matched = True
        if path == MAP:
            selected.update(test for _, tests in rules for test in tests)
        if not matched and candidate.suffix in CODE_SUFFIXES:
            uncovered.append(path)
    if uncovered:
        raise ValueError("NO_AFFECTED_TESTS: " + ", ".join(uncovered))
    changed_set = set(changed)
    kept = []
    for path in selected:
        suite = archive / path
        if not suite.is_file() or suite.is_symlink() or not suite.resolve().is_relative_to(archive):
            if path in changed_set and not suite.exists():
                # A range that deletes a suite has nothing to run for it; a kept
                # suite selected by another change still runs below.
                continue
            raise ValueError("declared selftest missing or outside export: " + path)
        kept.append(path)
    return sorted(kept)


def judge(repo: Path, tip: str, base: str | None) -> None:
    commit = git(repo, "rev-parse", "--verify", tip + "^{commit}").decode().strip()
    base = git(repo, "rev-parse", "--verify", base + "^{commit}").decode().strip() if base else ""
    declared = git(repo, "ls-tree", "--name-only", commit, "--", MAP).decode().strip()
    if not declared:
        if base and git(repo, "ls-tree", "--name-only", base, "--", MAP).strip():
            raise ValueError("affected-tests declaration removed")
        return
    diff = (["diff", "--name-only", "-z", base, commit] if base else
            ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit])
    changed = [relative(path) for path in git(repo, *diff).decode().split("\0") if path]
    gitdir = Path(git(repo, "rev-parse", "--absolute-git-dir").decode().strip())
    scratch_root = repo / "var" / "agent-tmp"
    scratch_root.mkdir(parents=True, exist_ok=True)
    with owned_tmp("declared-gate", root=str(scratch_root)) as directory:
        work = Path(directory)
        archive = work / "archive"
        archive.mkdir()
        checked(["git", "-C", str(repo), "archive", "--format=tar", "--output=" + str(work / "source.tar"), commit], cwd=repo)
        checked(["tar", "-xf", str(work / "source.tar"), "-C", str(archive)], cwd=repo)
        tests = selection(archive, changed)
        if not tests:
            gone = deleted_code(archive, changed)
            if gone:
                print(f"deleted-only: {len(gone)} paths", flush=True)
            print("FRESH-GATE: DOCS_ONLY: no affected selftests; no observation recorded", flush=True)
            return
        # A fixture must never discover the source checkout's Git/tracker authority.
        checked(["git", "init", "-q", str(archive)], cwd=archive)
        tmp = archive / "var" / "agent-tmp"
        tmp.mkdir(parents=True, exist_ok=True)
        metrics = runpy.run_path(str(HERE / "suite-metrics.py"))
        rows = []
        started = time.time_ns() // 1_000_000
        load = list(os.getloadavg())
        tree = git(repo, "rev-parse", commit + "^{tree}").decode().strip()
        previous_tmp = os.environ.get("TMPDIR")
        os.environ["TMPDIR"] = str(tmp)
        try:
            for index, path in enumerate(tests):
                record = work / (str(index) + ".json")
                print("affected selftest: " + path + " commit=" + commit, flush=True)
                rc = metrics["execute"](argparse.Namespace(
                    command=["nice", "-n", "10", "python3", "-B", path], record=str(record),
                    path=path, runner="python3", tree=tree, cwd=str(archive),
                    deadline=SELFTEST_DEADLINE_S, workers=1, wait_ms=0, loopback_port=None))
                if rc != 0:
                    raise ValueError("RED selftest: " + path + " producer_rc=" + str(rc))
                rows.append(json.loads(record.read_text()))
        finally:
            if previous_tmp is None:
                os.environ.pop("TMPDIR", None)
            else:
                os.environ["TMPDIR"] = previous_tmp
        if not metrics["complete_records"](rows, tests):
            raise ValueError("incomplete selftest evidence")
        (work / "files.json").write_text(json.dumps(rows))
        (work / "declared").write_text("\n".join(tests) + "\n")
        digest = hashlib.sha256()
        for name in ("declared-affected-gate.py", "fresh-gate-ledger.py", "suite-metrics.py",
                     "suite-hermetic-env.sh", "fixed-env.sh", "kitlib_run.py", "kitlib_tmp.py", "pysafe.py"):
            digest.update(name.encode() + b"\0" + (HERE / name).read_bytes())
        environment = dict(os.environ, METRICS=str(work / "files.json"), DECLARED=str(work / "declared"),
                           START_MS=str(started), LOAD_START=json.dumps(load), WORKER_COUNT="0",
                           LEDGER=str(gitdir / "omp-kit" / "fresh-gate-runs.jsonl"), RUN_COMMIT=commit,
                           RUN_BASE=base, RUN_CHANGED="\n".join(changed), RUN_TESTS=str(len(tests)),
                           RUN_FILES=str(len(tests)), RUN_RC="0", JUDGE=str(HERE / "declared-affected-gate.py"),
                           JUDGE_ID=digest.hexdigest(), GATE_PHASES=str(work / "phases.jsonl"), WORKDIR=str(work))
        result = run([sys.executable, "-B", str(HERE / "fresh-gate-ledger.py")], env=environment,
                     cwd=str(repo), deadline_s=30)
        sys.stdout.buffer.write(result.stdout)
        sys.stderr.buffer.write(result.stderr)
        if result.rc != 0 or result.timed_out or result.killed or result.truncated:
            raise ValueError("cannot record complete gate observation")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--commit")
    parser.add_argument("--base")
    args = parser.parse_args()
    try:
        # GIT_DIR/GIT_WORK_TREE would redirect the `git -C` reads below, so a
        # caller setting them is refused. BEADS_DB is deliberately unchecked:
        # this judge never consults a tracker (git objects and the committed
        # map only), and the repo's own harness exports BEADS_DB for its stub
        # br; refusing on it would refuse every harnessed real push (KITGATE1).
        for name in ("GIT_DIR", "GIT_WORK_TREE"):
            if name in os.environ:
                raise ValueError("caller authority is set: " + name)
        repo = Path(args.repo).resolve(strict=True)
        if args.commit:
            judge(repo, args.commit, args.base)
        else:
            outcome, protocol, truncated = pysafe.read_stdin(timeout=30, cap_bytes=1 << 20)
            if outcome != "OK" or truncated:
                raise ValueError("incomplete pre-push input")
            for line in protocol.decode().splitlines():
                fields = line.split()
                if len(fields) != 4:
                    raise ValueError("invalid pre-push input")
                _, tip, _, base = fields
                if set(tip) == {"0"}:
                    continue
                judge(repo, tip, None if set(base) == {"0"} else base)
        return 0
    except (OSError, ValueError, TypeError, KeyError) as error:
        print("FRESH-GATE: RED: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
