#!/usr/bin/env python3
"""Resolve and validate the shared, role-bound full-suite verdict store."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import threading
import time
from urllib.parse import unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kitlib_run import run
import pysafe

ROLES = ("base", "main")
# VERDICTSIZE1: a main-role record holds per-file evidence for ~380 suites and grew past 1 MiB on 2026-11-02 (1,065,616
# bytes for tree eab1fdfe66); at the old 1 MiB bound every PASS since then read back as MISS and no release could be cut.
# 8 MiB keeps a bound with headroom for several times the current suite.
MAX_RECORD_BYTES = 8 << 20
MAX_COMMAND_OUTPUT = 16 << 20
# CULPRIT1 (ompkit-6xxhu): the one optional key scripts/verdict-culprit.py adds to a FAIL record.
CULPRIT_KEYS = frozenset(("sha", "author", "bead", "failing_files", "method", "reason"))
CULPRIT_NONE_METHODS = ("flake-rerun", "unattributed")
BEAD_ID = re.compile(r"[a-z][a-z0-9]*-[a-z0-9]+(?:\.[a-z0-9]+)*")


def validate_culprit(value: object, verdict: object) -> None:
    """Raise ValueError unless value is a well-formed culprit attribution on a FAIL verdict.

    method "bisect" names a commit (sha, author without whitespace, bead or null, empty reason);
    "flake-rerun" and "unattributed" name none (sha, author and bead null) and say why."""
    if verdict != "FAIL":
        raise ValueError("culprit is recorded on a verdict that is not FAIL")
    if not isinstance(value, dict) or set(value) != CULPRIT_KEYS:
        raise ValueError("culprit keys are invalid")
    files = value["failing_files"]
    if (not isinstance(files, list) or not all(isinstance(item, str) and item for item in files)
            or len(set(files)) != len(files)):
        raise ValueError("culprit failing files are invalid")
    method = value["method"]
    reason = value["reason"]
    if method == "bisect":
        author = value["author"]
        bead = value["bead"]
        if not valid_hex(value["sha"], (40, 64)) or not files:
            raise ValueError("culprit commit is invalid")
        if not isinstance(author, str) or not author or any(char.isspace() for char in author):
            raise ValueError("culprit author is invalid")
        if bead is not None and (not isinstance(bead, str) or BEAD_ID.fullmatch(bead) is None):
            raise ValueError("culprit bead is invalid")
        if reason != "":
            raise ValueError("an attributed culprit carries no reason")
    elif method in CULPRIT_NONE_METHODS:
        if value["sha"] is not None or value["author"] is not None or value["bead"] is not None:
            raise ValueError("an unattributed culprit names a commit")
        if not isinstance(reason, str) or not reason or "\n" in reason:
            raise ValueError("an unattributed culprit has no reason")
    else:
        raise ValueError("culprit method is invalid")


def load_factor() -> tuple[float, float]:
    """(load1, factor) with fixtureLoad()'s formula from tests/cli/fixture-process.ts: factor = load1 / ncpu * 4
    clamped to [1, 4]. OMP_KIT_HEAVY_FAKE_LOAD1 is the same test-only load seam src/heavy.ts reads."""
    raw = os.environ.get("OMP_KIT_HEAVY_FAKE_LOAD1", "")
    try:
        load1 = float(raw) if raw else os.getloadavg()[0]
    except ValueError:
        load1 = os.getloadavg()[0]
    ncpu = os.cpu_count() or 1
    return load1, max(1.0, min(4.0, load1 / ncpu * 4))


def checked_run(argv: list[str], *, deadline_s: float = 15, cwd: Path | None = None,
                output_bytes: int = MAX_COMMAND_OUTPUT) -> bytes:
    # STOREDEADLINE1 (ompkit-fp72.120.16.184): the deadline is a quiet-machine floor scaled by load, as fixture
    # deadlines are, and the refusal names its kind so a timeout never reads as a failed command.
    load1, factor = load_factor()
    scaled = deadline_s * factor
    result = run(argv, deadline_s=scaled, cwd=cwd, max_output_bytes=output_bytes)
    if result.timed_out:
        raise ValueError(f"command did not complete: {argv[0]}: TIMEOUT after {scaled:g}s (load {load1:.2f})")
    if result.truncated:
        raise ValueError(f"command did not complete: {argv[0]}: OUTPUT_OVERFLOW")
    if result.rc != 0:
        raise ValueError(f"command did not complete: {argv[0]}: EXIT {result.rc}")
    return result.stdout


def text_output(data: bytes, label: str) -> str:
    try:
        return data.decode("utf-8", errors="strict").strip()
    except UnicodeDecodeError as error:
        raise ValueError(f"{label} is not UTF-8") from error


def repository_root(value: str) -> Path:
    requested = Path(value).expanduser().resolve()
    top = Path(text_output(checked_run(["git", "-C", str(requested), "rev-parse", "--show-toplevel"]),
                           "git repository root")).resolve()
    if requested != top:
        raise ValueError("--repo must name the Git repository root")
    if any(ord(char) < 32 for char in str(top)):
        raise ValueError("repository path contains a control character")
    return top


def strip_git_suffix(path: str) -> str:
    path = unquote(path).rstrip("/")
    return path[:-4] if path.endswith(".git") else path


def canonical_origin(raw: str, repo: Path) -> str:
    raw = raw.strip()
    if not raw or any(ord(char) < 32 for char in raw):
        raise ValueError("origin URL is empty or contains a control character")
    if raw.startswith("file://"):
        parsed = urlsplit(raw)
        if parsed.hostname not in (None, "", "localhost"):
            return f"file://{parsed.hostname.casefold()}/{strip_git_suffix(parsed.path).lstrip('/')}"
        local = Path(unquote(parsed.path)).expanduser()
        if not local.is_absolute():
            local = repo / local
        return "file:" + str(local.resolve())
    if "://" in raw:
        parsed = urlsplit(raw)
        host = parsed.hostname
        if not parsed.scheme or not host:
            raise ValueError("origin URL is not canonicalizable")
        port = f":{parsed.port}" if parsed.port is not None else ""
        return f"remote:{host.casefold()}{port}/{strip_git_suffix(parsed.path).lstrip('/')}"
    before, separator, after = raw.partition(":")
    if separator and "@" in before and "/" not in before:
        host = before.rsplit("@", 1)[1].casefold()
        return f"remote:{host}/{strip_git_suffix(after).lstrip('/')}"
    local = Path(raw).expanduser()
    if not local.is_absolute():
        local = repo / local
    return "file:" + str(local.resolve())


def repo_key(repo: Path) -> str:
    remote = run(["git", "-C", str(repo), "config", "--get", "remote.origin.url"], deadline_s=10)
    if remote.timed_out or remote.truncated:
        raise ValueError("origin lookup did not complete")
    if remote.rc == 0:
        canonical = canonical_origin(text_output(remote.stdout, "origin URL"), repo)
    elif remote.rc == 1:
        canonical = "path:" + str(repo)
    else:
        raise ValueError("origin lookup failed")
    return hashlib.sha256(b"OMP-KIT-VERDICT-REPOSITORY-v1\0" + canonical.encode("utf-8")).hexdigest()


def home_dir() -> Path:
    raw = os.environ.get("HOME")
    home = Path(raw).expanduser() if raw else Path.home()
    if not home.is_absolute():
        raise ValueError("HOME must be absolute")
    return home.resolve()


def xdg_dir(name: str, fallback: Path) -> Path:
    raw = os.environ.get(name)
    if raw:
        path = Path(raw).expanduser()
        if not path.is_absolute():
            raise ValueError(f"{name} must be absolute")
        return path.resolve()
    return fallback.resolve()


def configured_store_root() -> Path:
    home = home_dir()
    config_home = xdg_dir("XDG_CONFIG_HOME", home / ".config")
    config_file = config_home / "omp-kit" / "full-suite-verdict.json"
    state_home = xdg_dir("XDG_STATE_HOME", home / ".local" / "state")
    default = state_home / "omp-kit" / "full-suite-verdicts"
    if not config_file.exists():
        return default
    if config_file.is_symlink() or not config_file.is_file() or config_file.stat().st_size > 65536:
        raise ValueError("full-suite verdict configuration is not a bounded regular file")
    try:
        config = json.loads(config_file.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("full-suite verdict configuration is unreadable") from error
    if (not isinstance(config, dict) or set(config) - {"schema_version", "store_root"}
            or config.get("schema_version") != 1):
        raise ValueError("full-suite verdict configuration must have schema_version 1")
    store = config.get("store_root")
    if store is None:
        return default
    if not isinstance(store, str) or not store:
        raise ValueError("store_root must be a non-empty absolute path")
    root = Path(store).expanduser()
    if not root.is_absolute():
        raise ValueError("store_root must be absolute")
    return root.resolve()


def cache_directory(repo: Path, override: str | None) -> Path:
    selected = override or os.environ.get("FULL_SUITE_VERDICT_CACHE_DIR")
    if selected:
        path = Path(selected).expanduser()
        if not path.is_absolute():
            path = Path.cwd() / path
        return path.resolve()
    return configured_store_root() / repo_key(repo)


def valid_hex(value: object, lengths: tuple[int, ...]) -> bool:
    return (isinstance(value, str) and len(value) in lengths
            and all(char in "0123456789abcdef" for char in value))


def normalized_identity(tree: str, role: str, checks: str, runtime: str) -> tuple[str, str, str, str]:
    if not valid_hex(tree, (40, 64)):
        raise ValueError("tree must be a full Git tree hash")
    if role not in ROLES:
        raise ValueError("role must be base or main")
    if not valid_hex(checks, (64,)):
        raise ValueError("checks must be a SHA-256 identity")
    if not runtime or len(runtime) > 4096 or any(ord(char) < 32 for char in runtime):
        raise ValueError("runtime identity is empty or malformed")
    return tree, role, checks, runtime


def record_key(tree: str, role: str, checks: str, runtime: str) -> str:
    tree, role, checks, runtime = normalized_identity(tree, role, checks, runtime)
    identity = json.dumps([tree, role, checks, runtime], ensure_ascii=False,
                          separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(b"OMP-KIT-FULL-SUITE-VERDICT-v3\0" + identity).hexdigest()
    return f"{tree}.{role}.{digest}"


def judge_identity(root: Path) -> str:
    script = root / "scripts" / "suite-metrics.py"
    result = text_output(checked_run([sys.executable, str(script), "identity", "--root", str(root), "--scope", "full"]),
                         "judge identity")
    if not valid_hex(result, (64,)):
        raise ValueError("judge identity is not a SHA-256 digest")
    return result


def runtime_identity(root: Path) -> str:
    script = root / "scripts" / "suite-metrics.py"
    result = text_output(checked_run([sys.executable, str(script), "runtime"], output_bytes=4096),
                         "runtime identity")
    if not result or len(result) > 4096 or any(ord(char) < 32 for char in result):
        raise ValueError("runtime identity is malformed")
    return result


def load_metrics(root: Path):
    scripts = root / "scripts"
    sys.path.insert(0, str(scripts))
    path = scripts / "suite-metrics.py"
    spec = importlib.util.spec_from_file_location("omp_kit_suite_metrics", path)
    if spec is None or spec.loader is None:
        raise ValueError("suite metrics cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def excluded_paths(root: Path) -> set[str]:
    manifest = root / "scripts" / "gate-ci-only.tsv"
    if not manifest.is_file():
        return set()
    lines = manifest.read_text(encoding="utf-8").splitlines()
    return {line.split("\t", 1)[0] for line in lines[1:] if line}


def declared_suite_files(root: Path) -> set[str]:
    declared: set[str] = set()
    for directory in ("tests/cli", "tests/fleet-guard"):
        base = root / directory
        if base.is_dir():
            declared.update(path.relative_to(root).as_posix() for path in base.rglob("*.test.ts")
                            if path.is_file() and "var/agent-tmp/" not in path.relative_to(root).as_posix())
    base = root / "tests/cli"
    if base.is_dir():
        declared.update(path.relative_to(root).as_posix() for path in base.glob("*.test.sh") if path.is_file())
    for directory in ("tests/cli", "tests/scripts"):
        base = root / directory
        if base.is_dir():
            declared.update(path.relative_to(root).as_posix() for path in base.iterdir()
                            if path.is_file() and (path.name.endswith("_test.py") or path.name.endswith(".test.py")))
    return declared - excluded_paths(root)


def declared_suite_files_from_git(repo: Path, commit: str) -> set[str]:
    raw = checked_run(["git", "-C", str(repo), "ls-tree", "-r", "--name-only", "-z", commit])
    try:
        paths = {item.decode("utf-8", errors="strict") for item in raw.split(b"\0") if item}
    except UnicodeDecodeError as error:
        raise ValueError("suite paths are not UTF-8") from error
    declared = {path for path in paths
                if path.startswith(("tests/cli/", "tests/fleet-guard/"))
                and path.endswith(".test.ts") and "var/agent-tmp/" not in path}
    declared.update(path for path in paths if path.startswith("tests/cli/") and "/" not in path[len("tests/cli/"):]
                    and path.endswith(".test.sh"))
    for directory in ("tests/cli/", "tests/scripts/"):
        declared.update(path for path in paths if path.startswith(directory) and "/" not in path[len(directory):]
                        and (path.endswith("_test.py") or path.endswith(".test.py")))
    if "scripts/gate-ci-only.tsv" in paths:
        manifest = checked_run(["git", "-C", str(repo), "show", f"{commit}:scripts/gate-ci-only.tsv"])
        lines = text_output(manifest, "CI-only manifest").splitlines()
        excluded = {line.split("\t", 1)[0] for line in lines[1:] if line}
        declared.difference_update(excluded)
    return declared


def json_value(path: Path) -> object:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_RECORD_BYTES:
        raise ValueError("record is not a bounded regular file")
    return json.loads(path.read_text(encoding="utf-8"))


def json_file(path: Path) -> dict:
    value = json_value(path)
    if not isinstance(value, dict):
        raise ValueError("record is not a JSON object")
    return value


def measured_counts(files: list[dict]) -> dict[str, int]:
    """Include verified focused rows, not only this invocation's complement."""
    counts = {"bun": 0, "shell": 0, "python": 0}
    for row in files:
        runner = row["runner"]
        if runner == "bun":
            count = row.get("test_count")
            if not isinstance(count, int) or isinstance(count, bool) or count < 0:
                raise ValueError("Bun measured run count is invalid")
            counts["bun"] += count
        elif runner == "sh":
            counts["shell"] += 1
        elif runner == "python3":
            counts["python"] += 1
        else:
            raise ValueError("measured runner is invalid")
    return counts


def measured_wall(files: list[dict], invocation_ms: int) -> int:
    """Count verified focused work once, excluding idle gaps between invocations."""
    intervals = []
    for row in files:
        start, end = row["started_ms"], row["finished_ms"]
        if (not isinstance(start, int) or isinstance(start, bool) or start < 0
                or not isinstance(end, int) or isinstance(end, bool) or end < start):
            raise ValueError("minimum-run measured interval is invalid")
        intervals.append((start, end))
    covered, previous_end = 0, 0
    for start, end in sorted(intervals):
        covered += max(0, end - max(start, previous_end))
        previous_end = max(previous_end, end)
    return max(invocation_ms, covered)




def validate_runtime_environment(environment: object, runtime: str) -> None:
    metrics = load_metrics(Path(__file__).resolve().parent.parent)
    if (not isinstance(environment, dict) or not isinstance(environment.get("PATH"), str)
            or not all(isinstance(key, str) and isinstance(value, str) for key, value in environment.items())
            or not runtime.endswith("/env-" + metrics.environment_digest(environment))):
        raise ValueError("record environment differs from its runtime")



def validate_record(path: Path, *, judge_root: Path, tree: str | None = None, role: str | None = None,
                    checks: str | None = None, runtime: str | None = None,
                    suite_root: Path | None = None, repo: Path | None = None,
                    commit: str | None = None, exact_filename: bool = False,
                    historical: bool = False) -> tuple[dict | None, str]:
    try:
        entry = json_file(path)
        if entry.get("version") != 3:
            raise ValueError("record schema is not version 3")
        entry_tree = entry.get("tree")
        entry_role = entry.get("judge_role")
        entry_checks = entry.get("checks")
        entry_runtime = entry.get("runtime")
        if (not isinstance(entry_tree, str) or not entry_tree
                or not isinstance(entry_role, str) or not entry_role
                or not isinstance(entry_checks, str) or not entry_checks
                or not isinstance(entry_runtime, str) or not entry_runtime):
            raise ValueError("record identity is incomplete")
        normalized_identity(entry_tree, entry_role, entry_checks, entry_runtime)
        if "environment" in entry:
            validate_runtime_environment(entry["environment"], entry_runtime)
        judge = entry.get("judge")
        if (not isinstance(judge, dict) or judge.get("role") != entry_role
                or judge.get("checks_sha256") != entry_checks or judge.get("runtime") != entry_runtime):
            raise ValueError("record judge identity is inconsistent")
        if tree is not None and entry_tree != tree:
            raise ValueError("tree mismatch")
        if role is not None and entry_role != role:
            raise ValueError("judge role mismatch")
        if checks is not None and entry_checks != checks:
            raise ValueError("judge hash mismatch")
        if runtime is not None and entry_runtime != runtime:
            raise ValueError("runtime mismatch")
        if exact_filename and path.name != record_key(entry_tree, entry_role, entry_checks, entry_runtime) + ".json":
            raise ValueError("record filename does not match its identity")
        if entry.get("verdict") not in ("PASS", "FAIL"):
            raise ValueError("verdict is not complete")
        exit_code = entry.get("exit_code")
        if not isinstance(exit_code, int) or isinstance(exit_code, bool):
            raise ValueError("exit code is invalid")
        evidence = entry.get("evidence")
        if not isinstance(evidence, dict) or evidence.get("complete") is not True:
            raise ValueError("evidence is incomplete")
        files = evidence.get("files")
        declared = evidence.get("declared_files")
        if not isinstance(files, list):
            raise ValueError("measured file evidence is invalid")
        if not isinstance(declared, list) or not all(isinstance(item, str) for item in declared) or len(set(declared)) != len(declared):
            raise ValueError("declared suite list is invalid")
        metrics = load_metrics(judge_root)
        # Historical rows establish only a reference, never a reusable current PASS.
        producer = files[0].get("judge") if historical and files and isinstance(files[0], dict) else None
        if not metrics.complete_records(files, declared, expected_judge=producer):
            raise ValueError("measured file evidence is incomplete")
        if suite_root is not None:
            expected_files = declared_suite_files(suite_root)
            if set(declared) != expected_files:
                raise ValueError("declared suite set differs from the exact source tree")
        elif repo is not None and commit is not None:
            expected_files = declared_suite_files_from_git(repo, commit)
            if set(declared) != expected_files:
                raise ValueError("declared suite set differs from the exact commit tree")
        count_names = ("bun_files", "bun_ran", "bun_fail", "shell_suites", "shell_fail", "py_suites", "py_fail")
        raw_counts = tuple(evidence.get(name) for name in count_names)
        counts: list[int] = []
        for value in raw_counts:
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise ValueError("suite counts are invalid")
            counts.append(value)
        bun_files, bun_ran, bun_fail, shell_suites, shell_fail, py_suites, py_fail = counts
        coverage = evidence.get("covered_by_focused", {})
        if not isinstance(coverage, dict):
            raise ValueError("focused coverage is invalid")
        covered = [coverage.get(kind, []) for kind in ("bun", "shell", "py")]
        if not all(isinstance(rows, list) and all(isinstance(item, str) for item in rows) for rows in covered):
            raise ValueError("focused coverage paths are invalid")
        covered_count = sum(len(rows) for rows in covered)
        if len(files) != bun_files + shell_suites + py_suites + covered_count or not files:
            raise ValueError("suite counts do not match measured rows")
        if (bun_files == 0 and bun_ran != 0) or (bun_files > 0 and bun_ran == 0):
            raise ValueError("Bun run count is inconsistent")
        if bun_fail > bun_ran or shell_fail > shell_suites or py_fail > py_suites:
            raise ValueError("failure counts exceed the run counts")
        for row in files:
            closure = row.get("closure")
            if not isinstance(closure, dict) or closure.get("tree") != entry_tree:
                raise ValueError("measured row does not bind the candidate tree")
        # Older records may carry the retired qualification; it is not a current gate.
        minimum_failures = isinstance(entry.get("minimum_run"), dict) and entry["minimum_run"].get("status") == "FAIL"
        if entry["verdict"] == "PASS":
            if exit_code != 0 or bun_fail or shell_fail or py_fail or minimum_failures or any(row.get("rc") != 0 for row in files):
                raise ValueError("PASS contains a failing suite")
        elif exit_code == 0 or not (bun_fail or shell_fail or py_fail or minimum_failures):
            raise ValueError("FAIL has no recorded failure")
        if "culprit" in entry:
            validate_culprit(entry["culprit"], entry["verdict"])
        log_path = path.with_suffix(".log")
        log_info = log_path.lstat()
        if not stat.S_ISREG(log_info.st_mode):
            raise ValueError("paired log is not a regular file")
        digest = hashlib.sha256()
        with log_path.open("rb") as log:
            for chunk in iter(lambda: log.read(1 << 20), b""):
                digest.update(chunk)
        if evidence.get("log_sha256") != digest.hexdigest():
            raise ValueError("paired log digest mismatch")
        return entry, "VALID"
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError, TypeError, KeyError, AttributeError) as error:
        return None, str(error)





def lookup(repo: Path, tree: str, role: str, checks: str, runtime: str, *,
           judge_root: Path, cache_dir: str | None, suite_root: Path | None,
           commit: str | None) -> tuple[dict | None, str]:
    tree, role, checks, runtime = normalized_identity(tree, role, checks, runtime)
    directory = cache_directory(repo, cache_dir)
    key = record_key(tree, role, checks, runtime)
    return validate_record(directory / (key + ".json"), judge_root=judge_root,
                           tree=tree, role=role, checks=checks, runtime=runtime,
                           suite_root=suite_root, repo=repo if commit else None,
                           commit=commit, exact_filename=True)


# RUNTIMEMISS1 (ompkit-fp72.120.16.242): the runtime id hashes PATH, so a PASS judged under another PATH (for example
# with agent-bin first) reads back as MISS and release-local re-ran a 15 min suite for a tree that had passed. On an
# exact-key miss, a valid record for the same tree and checks under another runtime is named RUNTIME_MISMATCH with
# both env digests and the differing fields. It is never a PASS.
RUNTIME_FIELDS = ("system", "machine", "bun", "python")


def describe_runtime_mismatch(metrics, stored: str, prefix: str, environment: dict[str, str]) -> str:
    """Both runtime ids' env digests and every field that differs, PATH entries decoded where the digest allows."""
    current_env = metrics.environment_digest(environment)
    stored_prefix, _sep, stored_env = stored.rpartition("/env-")
    fields = [f"{name} {old} -> {new}" for name, old, new in
              zip(RUNTIME_FIELDS, stored_prefix.split("/"), prefix.split("/")) if old != new]
    if stored_env != current_env:
        entries = environment.get("PATH", "").split(os.pathsep)
        added = [entry for index, entry in enumerate(entries)
                 if metrics.environment_digest({**environment, "PATH": os.pathsep.join(entries[:index] + entries[index + 1:])})
                 == stored_env]
        others = [key for key in sorted(environment) if key != "PATH"
                  and metrics.environment_digest({**environment, key: ""}) == stored_env]
        if added:
            fields.append("PATH added " + ", ".join(dict.fromkeys(added)))
        elif others:
            fields.append("unset in the stored runtime: " + ", ".join(others))
        else:
            fields.append("environment differs (PATH entries removed or reordered; no single added entry explains it)")
    return (f"RUNTIME_MISMATCH stored env-{stored_env} current env-{current_env}: "
            + ("; ".join(fields) or "runtime ids differ"))


def read_back(exact: dict | None, others: list[dict], metrics, prefix: str, environment: dict[str, str]) -> str:
    """PASS, FAIL or MISS for the exact key; on a miss, RUNTIME_MISMATCH for a valid record under another runtime."""
    if exact is not None:
        return "PASS" if exact["verdict"] == "PASS" else "FAIL"
    for entry in others:
        return describe_runtime_mismatch(metrics, entry["runtime"], prefix, environment) + f" (stored {entry['verdict']})"
    return "MISS"


def other_runtime_records(candidates, runtime: str, validate) -> list[dict]:
    """Valid records among candidates whose runtime differs from runtime, in name order."""
    found = []
    for path in sorted(candidates):
        try:
            stored = json_file(path).get("runtime")
        except (OSError, ValueError, UnicodeError):
            continue
        if isinstance(stored, str) and stored != runtime:
            entry, _reason = validate(path, stored)
            if entry is not None:
                found.append(entry)
    return found


def current_runtime_parts(judge_root: Path) -> tuple[object, str, dict[str, str]]:
    metrics = load_metrics(judge_root)
    prefix, environment = metrics.runtime_parts()
    return metrics, prefix, environment


def command_identity(args: argparse.Namespace, judge_root: Path) -> tuple[str, str]:
    checks = getattr(args, "checks", None) or judge_identity(judge_root)
    runtime = getattr(args, "runtime", None) or runtime_identity(judge_root)
    if not valid_hex(checks, (64,)) or not runtime:
        raise ValueError("judge identity is incomplete")
    return checks, runtime


# CIONLY1: push-time CI-only evidence covers every locally runnable exclusion, including split live journeys.
# The spec, complete judge identity and every selected file's bytes bind the record; selection changes orphan PASS.
# Keep the existing base-file bounds. New journey bounds retain their 900 s test budget: observed N+2 196.62 s,
# compiled 360.52 s, relink 216.11 s, package-live 120.18 s at load 10->40 (at least 2.49x measured headroom).
CI_ONLY_FILES = (
    ("tests/cli/package-release.test.ts", 900),
    ("tests/cli/kit-update.test.ts", 2400),
    ("tests/cli/kit-update-nplus-two.test.ts", 900),
    ("tests/cli/kit-update-compiled.test.ts", 900),
    ("tests/cli/kit-update-relink.test.ts", 900),
    ("tests/cli/package-release-live.test.ts", 900),
)
CI_ONLY_GITHUB_ONLY = {
    "tests/cli/external-live.test.ts":
        "GitHub core suite owns the relocated OMP live proof; dev-Mac exports have a known fast-tier diff.",
    "tests/fleet-guard/reservations.live.test.ts":
        "Explicit CI live Agent Mail suite needs 127.0.0.1:8765; it is not a hermetic local verdict.",
}
CI_ONLY_BUN_ARGS = ("test", "--timeout=120000")
CI_ONLY_ENV = (("OMP_KIT_HEAVY_MAX_WAIT_S", "180"), ("OMP_KIT_DISK_OBSERVER", "statfs"))
CI_ONLY_KEYS = frozenset(("version", "kind", "tree", "commit", "checks", "runtime", "spec", "verdict", "files",
                          "environment", "log_sha256", "finished_ms"))
CI_ONLY_FILE_KEYS = frozenset(("path", "timeout_s", "rc", "timed_out", "duration_ms"))
CI_ONLY_OUTPUT_BYTES = 4 << 20
CI_ONLY_TIMEOUT_RC = 124  # the coreutils `timeout` status release-local's runs report
CI_ONLY_SPAWN_RC = 127
CI_ONLY_DOMAIN = b"OMP-KIT-CI-ONLY-VERDICT-v1\0"


def validate_ci_only_coverage(suite_root: Path) -> None:
    """Every CI-only exclusion has exactly one local or explicitly reasoned GitHub owner."""
    lines = (suite_root / "scripts" / "gate-ci-only.tsv").read_text(encoding="utf-8").splitlines()
    declared = {path for path, kind, *_rest in (line.split("\t") for line in lines[1:] if line)
                if kind == "ci-only"}
    local = {path for path, _limit in CI_ONLY_FILES}
    github = set(CI_ONLY_GITHUB_ONLY)
    if len(local) != len(CI_ONLY_FILES) or local & github:
        raise ValueError("CI-only coverage has duplicate execution owners")
    if any(not reason.strip() for reason in CI_ONLY_GITHUB_ONLY.values()):
        raise ValueError("CI-only GitHub exemption needs a reason")
    missing = declared - local - github
    stale = (local | github) - declared
    if missing or stale:
        raise ValueError(f"CI-only coverage differs: missing execution owner={sorted(missing)}; "
                         f"selection without ci-only exclusion={sorted(stale)}")


def ci_only_spec() -> dict:
    return {"files": [{"path": path, "timeout_s": limit} for path, limit in CI_ONLY_FILES],
            "argv": ["bun", *CI_ONLY_BUN_ARGS], "env": dict(CI_ONLY_ENV),
            "case_cwd": "suite-root", "git": "init, fetch --depth 1 of the exact commit", "schedule": "serial",
            "github_only": dict(CI_ONLY_GITHUB_ONLY)}


def ci_only_checks(judge_root: Path, suite_root: Path) -> str:
    validate_ci_only_coverage(suite_root)
    digest = hashlib.sha256(CI_ONLY_DOMAIN)
    digest.update(judge_identity(judge_root).encode("ascii") + b"\0")
    digest.update(json.dumps(ci_only_spec(), sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\0")
    for path, _limit in CI_ONLY_FILES:
        data = (suite_root / path).read_bytes()
        digest.update(path.encode("utf-8") + b"\0" + str(len(data)).encode("ascii") + b"\0")
        digest.update(data)
    return digest.hexdigest()


def ci_only_key(tree: str, checks: str, runtime: str) -> str:
    tree, _role, checks, runtime = normalized_identity(tree, "main", checks, runtime)
    identity = json.dumps([tree, checks, runtime], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return f"{tree}.ci-only.{hashlib.sha256(CI_ONLY_DOMAIN + identity).hexdigest()}"


def ci_only_header(row: dict) -> str:
    return (f"CI-ONLY-FILE {row['path']} rc={row['rc']} timed_out={int(row['timed_out'])} "
            f"duration_ms={row['duration_ms']}")


def validate_ci_only_record(path: Path, *, tree: str, checks: str, runtime: str) -> tuple[dict | None, str]:
    """A bounded record whose identity, spec, verdict and digested log all agree, else None and why."""
    try:
        entry = json_file(path)
        if (set(entry) not in (CI_ONLY_KEYS, CI_ONLY_KEYS | {"culprit"})
                or entry["version"] != 1 or entry["kind"] != "ci-only"):
            raise ValueError("ci-only record schema is invalid")
        if entry["tree"] != tree or entry["checks"] != checks or entry["runtime"] != runtime:
            raise ValueError("ci-only record identity differs")
        validate_runtime_environment(entry["environment"], runtime)
        if path.name != ci_only_key(tree, checks, runtime) + ".json":
            raise ValueError("ci-only record filename does not match its identity")
        if not valid_hex(entry["commit"], (40, 64)) or entry["spec"] != ci_only_spec():
            raise ValueError("ci-only record commit or spec is invalid")
        finished = entry["finished_ms"]
        if not isinstance(finished, int) or isinstance(finished, bool) or finished < 0:
            raise ValueError("ci-only record time is invalid")
        files = entry["files"]
        if not isinstance(files, list) or len(files) != len(CI_ONLY_FILES):
            raise ValueError("ci-only record files are invalid")
        for row, (name, limit) in zip(files, CI_ONLY_FILES):
            if (not isinstance(row, dict) or set(row) != CI_ONLY_FILE_KEYS or row["path"] != name
                    or row["timeout_s"] != limit or not isinstance(row["timed_out"], bool)):
                raise ValueError("ci-only record file row is invalid")
            for field in ("rc", "duration_ms"):
                if not isinstance(row[field], int) or isinstance(row[field], bool):
                    raise ValueError(f"ci-only record {field} is invalid")
            if row["duration_ms"] < 0 or (row["timed_out"] and row["rc"] != CI_ONLY_TIMEOUT_RC):
                raise ValueError("ci-only record timing is invalid")
        if entry["verdict"] != ("FAIL" if any(row["rc"] != 0 for row in files) else "PASS"):
            raise ValueError("ci-only verdict disagrees with its exit codes")
        if "culprit" in entry:
            validate_culprit(entry["culprit"], entry["verdict"])
        log_path = path.with_suffix(".log")
        if not stat.S_ISREG(log_path.lstat().st_mode):
            raise ValueError("ci-only paired log is not a regular file")
        digest = hashlib.sha256()
        with log_path.open("rb") as log:
            head = [log.readline(4096) for _row in files]
            for line in head:
                digest.update(line)
            for chunk in iter(lambda: log.read(1 << 20), b""):
                digest.update(chunk)
        if entry["log_sha256"] != digest.hexdigest():
            raise ValueError("ci-only paired log digest mismatch")
        if [line.decode("utf-8", errors="strict").rstrip("\n") for line in head] != [ci_only_header(row) for row in files]:
            raise ValueError("ci-only paired log disagrees with the recorded exit codes")
        return entry, "VALID"
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError, TypeError, KeyError) as error:
        return None, str(error)


def ci_only_identity(repo: Path, tree: str, *, judge_root: Path, suite_root: Path,
                     cache_dir: str | None) -> tuple[str, str, Path]:
    """The checks digest, runtime and record path a ci-only verdict of tree is stored and found under."""
    checks = ci_only_checks(judge_root, suite_root)
    runtime = runtime_identity(judge_root)
    return checks, runtime, cache_directory(repo, cache_dir) / "ci-only" / (ci_only_key(tree, checks, runtime) + ".json")


def write_atomic(path: Path, data: bytes) -> None:
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temp.write_bytes(data)
    os.replace(temp, path)


def tail_lines(data: bytes, count: int) -> str:
    return "\n".join(data.decode("utf-8", errors="replace").rstrip("\n").splitlines()[-count:])


def ci_only_environment(repo: Path, commit: str, suite_root: Path) -> dict[str, str]:
    """Prepare an exact-commit export for both the CI-only verdict and its per-file reruns."""
    # package-release archives from Git; the work-root check needs this export as its case cwd.
    checked_run(["git", "-C", str(suite_root), "-c", "init.defaultBranch=main", "init", "-q"], deadline_s=60)
    checked_run(["git", "-C", str(suite_root), "fetch", "-q", "--depth", "1", str(repo), commit], deadline_s=120)
    env = load_metrics(Path(__file__).resolve().parent.parent).suite_environment()
    env.update(CI_ONLY_ENV)
    if os.environ.get("TMPDIR"):
        env["TMPDIR"] = os.environ["TMPDIR"]
    env["KITLIB_TMP_ROOT"] = str(suite_root / "var" / "agent-tmp")
    env["OMP_KIT_CASE_CWD"] = str(suite_root)
    return env


def run_ci_only(repo: Path, commit: str, *, judge_root: Path, suite_root: Path, cache_dir: str | None) -> int:
    """Judge CI_ONLY_FILES on suite_root (an export of commit) one at a time and record the verdict."""
    commit = text_output(checked_run(["git", "-C", str(repo), "rev-parse", "--verify", f"{commit}^{{commit}}"]), "commit")
    tree = text_output(checked_run(["git", "-C", str(repo), "rev-parse", "--verify", f"{commit}^{{tree}}"]), "tree")
    for name, _limit in CI_ONLY_FILES:
        if not (suite_root / name).is_file():
            print(f"CI-ONLY: SKIP tree={tree} {name} is absent from this commit; nothing recorded")
            return 0
        if checked_run(["git", "-C", str(repo), "show", f"{commit}:{name}"]) != (suite_root / name).read_bytes():
            raise ValueError(f"{name} in {suite_root} is not the bytes of {commit}")
    checks, runtime, path = ci_only_identity(repo, tree, judge_root=judge_root, suite_root=suite_root,
                                             cache_dir=cache_dir)
    entry, _reason = validate_ci_only_record(path, tree=tree, checks=checks, runtime=runtime)
    if entry is not None and entry["verdict"] == "PASS":
        print(f"CI-ONLY: VERDICT PASS tree={tree} (already recorded: {path.name})")
        return 0
    env = ci_only_environment(repo, commit, suite_root)
    # LIVEEVAL1 (ompkit-fp72.120.16.248): the export and every scratch root under it are deleted after this run, so
    # e2e-live copies a failing live scenario's transcript here; it becomes <record>.evidence beside the record.
    evidence = path.with_suffix(".evidence")
    pending = path.with_suffix(f".evidence.{os.getpid()}.tmp")
    path.parent.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(pending, ignore_errors=True)  # only a dead run with this pid could have left it
    pending.mkdir(mode=0o700)
    env["OMP_KIT_E2E_EVIDENCE_DIR"] = str(pending)
    rows: list[dict] = [{} for _ in CI_ONLY_FILES]
    outputs: list[tuple[bytes, bytes]] = [(b"", b"") for _ in CI_ONLY_FILES]

    def judge(index: int, name: str, limit: int) -> None:
        started = time.monotonic()
        try:
            result = run(["bun", *CI_ONLY_BUN_ARGS, name], deadline_s=limit, cwd=suite_root, env=env,
                         max_output_bytes=CI_ONLY_OUTPUT_BYTES)
            rc = CI_ONLY_TIMEOUT_RC if result.timed_out else (result.rc if result.rc is not None else -1)
            outputs[index] = (result.stdout, result.stderr)
            timed_out = result.timed_out
        except OSError as error:
            rc, timed_out = CI_ONLY_SPAWN_RC, False
            outputs[index] = (b"", f"ci-only: cannot start bun: {error}\n".encode("utf-8"))
        rows[index] = {"path": name, "timeout_s": limit, "rc": rc, "timed_out": timed_out,
                       "duration_ms": int((time.monotonic() - started) * 1000)}

    # KITUPDATELOAD1: every CI-only file runs a real ladder (`test --full`, up to 8 OMP sessions each), so they run
    # one at a time: side by side they overloaded the host and turned wall-clock gates red (a0558d56e4, 929b2a44c9).
    def judge_all() -> None:
        for index, (name, limit) in enumerate(CI_ONLY_FILES):
            judge(index, name, limit)

    worker = threading.Thread(target=judge_all, daemon=True)
    # A TERM/INT reaches the main thread as Cancelled; leaving the block kills every bun group run() still owns.
    try:
        with pysafe.cancel_on_signals():
            worker.start()
            while worker.is_alive():
                worker.join(1.0)
    except BaseException:
        shutil.rmtree(pending, ignore_errors=True)
        raise
    verdict = "FAIL" if any(row["rc"] != 0 for row in rows) else "PASS"
    log = "".join(ci_only_header(row) + "\n" for row in rows).encode("utf-8")
    for row, (stdout, stderr) in zip(rows, outputs):
        log += f"=== {row['path']} stdout\n".encode("utf-8") + stdout + f"\n=== {row['path']} stderr\n".encode("utf-8") + stderr + b"\n"
    entry = {"version": 1, "kind": "ci-only", "tree": tree, "commit": commit, "checks": checks, "runtime": runtime,
             "spec": ci_only_spec(), "verdict": verdict, "files": rows,
             "environment": load_metrics(judge_root).runtime_parts()[1],
             "log_sha256": hashlib.sha256(log).hexdigest(), "finished_ms": int(time.time() * 1000)}
    if evidence.is_symlink() or evidence.is_file():
        evidence.unlink()
    elif evidence.exists():
        shutil.rmtree(evidence)  # the superseded record's evidence
    kept = any(pending.iterdir())
    if kept:
        os.replace(pending, evidence)
    else:
        pending.rmdir()
    write_atomic(path.with_suffix(".log"), log)
    write_atomic(path, (json.dumps(entry, sort_keys=True, indent=1) + "\n").encode("utf-8"))
    for row in rows:
        print(f"CI-ONLY: {row['path']} rc={row['rc']} timed_out={int(row['timed_out'])} duration_ms={row['duration_ms']}")
    # Every failing file's output in this one run (RELFAILFAST1): stderr's last 60 lines, then stdout's last 20.
    for row, (stdout, stderr) in zip(rows, outputs):
        if row["rc"] != 0:
            print(f"CI-ONLY: {row['path']} FAIL; output (last 60 lines of stderr, then stdout):")
            print(tail_lines(stderr, 60))
            print(tail_lines(stdout, 20))
    if kept:
        print(f"CI-ONLY: failing live scenario transcripts kept beside the record: {evidence}")
    print(f"CI-ONLY: VERDICT {verdict} tree={tree} record={path}")
    return 0 if verdict == "PASS" else 1


def records(repo: Path, directory: Path, judge_root: Path, tree: str | None) -> dict:
    rows = []
    if directory.is_dir():
        for path in sorted(directory.glob("*.json"), key=lambda item: item.name):
            try:
                raw = json_file(path)
            except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
                raw = {}
            record_tree = raw.get("tree") if isinstance(raw.get("tree"), str) else None
            if tree is not None and record_tree != tree:
                continue
            valid, reason = validate_record(path, judge_root=judge_root)
            judge = raw.get("judge") if isinstance(raw.get("judge"), dict) else None
            verdict = raw.get("verdict") if raw.get("verdict") in ("PASS", "FAIL") else None
            rows.append({"tree": record_tree, "judge": judge, "verdict": verdict,
                         "integrity": "VALID" if valid is not None else "INVALID",
                         "reason": "" if valid is not None else reason, "record": path.name})
    return {"overall": "OK", "repo_key": repo_key(repo), "store": str(directory), "records": rows}


# PHANTOMRED1 (ompkit-fp72.120.16.252): a suite red is listed only from the runner's own status rows.
# The combined log also carries every suite's raw output, and a passing test whose nested fixture prints
# "RED script-suite <name>" put a phantom red in every failing list it shared a log with.
OUTER_SUITE_RED = re.compile(r"RED (?:script|python)-suite \S+ rc=-?[0-9]+")
BUN_FILE_HEADER = re.compile(r"[A-Za-z0-9_./-]+\.test\.ts:")


def failing_tests(log_text: str, status_text: str) -> list[str]:
    """The verdict's failing-test lines: bun (fail) lines under their file header from the combined log
    (at most 40), then the outer runner's RED suite rows from its status file (at most 20)."""
    bun: list[str] = []
    current = ""
    for line in log_text.splitlines():
        if BUN_FILE_HEADER.fullmatch(line):
            current = line
        if line.startswith("(fail)"):
            bun.append(f"  {current} {line}")
    reds = [f"  {row}" for row in status_text.splitlines() if OUTER_SUITE_RED.fullmatch(row)]
    return bun[:40] + reds[:20]



def add_store_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--repo", required=True)
    parser.add_argument("--cache-dir")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    path_cmd = actions.add_parser("path")
    add_store_options(path_cmd)
    path_cmd.add_argument("--tree", required=True)
    path_cmd.add_argument("--role", choices=ROLES, required=True)
    path_cmd.add_argument("--checks")
    path_cmd.add_argument("--runtime")
    path_cmd.add_argument("--judge-root")
    timings_cmd = actions.add_parser("timings")
    add_store_options(timings_cmd)
    lookup_cmd = actions.add_parser("lookup")
    add_store_options(lookup_cmd)
    lookup_cmd.add_argument("--tree", required=True)
    lookup_cmd.add_argument("--role", choices=ROLES, required=True)
    lookup_cmd.add_argument("--checks", required=True)
    lookup_cmd.add_argument("--runtime", required=True)
    lookup_cmd.add_argument("--judge-root")
    lookup_cmd.add_argument("--suite-root")
    lookup_cmd.add_argument("--commit")
    pass_cmd = actions.add_parser("require-pass")
    add_store_options(pass_cmd)
    pass_cmd.add_argument("--tree", required=True)
    pass_cmd.add_argument("--role", choices=ROLES, required=True)
    pass_cmd.add_argument("--judge-root", required=True)
    pass_cmd.add_argument("--suite-root", required=True)
    ci_run_cmd = actions.add_parser("run-ci-only")
    add_store_options(ci_run_cmd)
    ci_run_cmd.add_argument("--commit", required=True)
    ci_run_cmd.add_argument("--judge-root")
    ci_run_cmd.add_argument("--suite-root")
    ci_pass_cmd = actions.add_parser("require-ci-only-pass")
    add_store_options(ci_pass_cmd)
    ci_pass_cmd.add_argument("--tree", required=True)
    ci_pass_cmd.add_argument("--judge-root", required=True)
    ci_pass_cmd.add_argument("--suite-root", required=True)
    list_cmd = actions.add_parser("list")
    add_store_options(list_cmd)
    list_cmd.add_argument("--tree")
    list_cmd.add_argument("--judge-root")
    failing_cmd = actions.add_parser("failing-tests")
    failing_cmd.add_argument("--log", required=True)
    args = parser.parse_args()
    if args.action == "failing-tests":
        # The runner's status rows arrive on stdin: the verdict removes its status file with the run state.
        try:
            log_text = Path(args.log).read_text(encoding="utf-8", errors="replace")
        except OSError as error:
            print("VERDICT_STORE_ERROR: " + str(error), file=sys.stderr)
            return 2
        outcome, rows, _truncated = pysafe.read_stdin(30)
        if outcome != pysafe.OK:
            print(f"VERDICT_STORE_ERROR: status rows on stdin: {outcome}", file=sys.stderr)
            return 2
        for line in failing_tests(log_text, rows.decode("utf-8", "replace")):
            print(line)
        return 0
    try:
        repo = repository_root(args.repo)
        judge_root = Path(getattr(args, "judge_root", None) or Path(__file__).resolve().parent.parent).expanduser().resolve()
        directory = cache_directory(repo, args.cache_dir)
        if args.action == "path":
            checks = args.checks or judge_identity(Path(args.judge_root).expanduser().resolve()
                                                   if args.judge_root else Path(__file__).resolve().parent.parent)
            runtime = args.runtime or runtime_identity(Path(args.judge_root).expanduser().resolve()
                                                        if args.judge_root else Path(__file__).resolve().parent.parent)
            key = record_key(args.tree, args.role, checks, runtime)
            print(directory / (key + ".json"))
            return 0
        if args.action == "timings":
            print(directory / "timings")
            return 0
        if args.action == "lookup":
            entry, _reason = lookup(repo, args.tree, args.role, args.checks, args.runtime,
                                   judge_root=judge_root, cache_dir=args.cache_dir,
                                   suite_root=Path(args.suite_root).resolve() if args.suite_root else None,
                                   commit=args.commit)
            if entry is None:
                print("MISS")
            elif entry["verdict"] == "PASS":
                print("PASS")
            else:
                print(f"FAIL {entry['exit_code']}")
            return 0
        if args.action == "require-pass":
            judge_root = Path(args.judge_root).expanduser().resolve()
            checks, runtime = command_identity(args, judge_root)
            entry, _reason = lookup(repo, args.tree, args.role, checks, runtime,
                                   judge_root=judge_root, cache_dir=args.cache_dir,
                                   suite_root=Path(args.suite_root).expanduser().resolve(), commit=None)
            if entry is None:
                tree, role, checks, runtime = normalized_identity(args.tree, args.role, checks, runtime)
                suite_root = Path(args.suite_root).expanduser().resolve()
                others = other_runtime_records(
                    directory.glob(f"{tree}.{role}.*.json"), runtime,
                    lambda path, stored: validate_record(path, judge_root=judge_root, tree=tree, role=role,
                                                         checks=checks, runtime=stored, suite_root=suite_root,
                                                         exact_filename=True))
                if others:
                    print(read_back(None, others, *current_runtime_parts(judge_root)))
                    return 1
            print(read_back(entry, [], None, "", {}))
            return 0 if entry is not None and entry["verdict"] == "PASS" else 1
        if args.action == "run-ci-only":
            suite_root = Path(args.suite_root).expanduser().resolve() if args.suite_root else judge_root
            try:
                return run_ci_only(repo, args.commit, judge_root=judge_root, suite_root=suite_root,
                                   cache_dir=args.cache_dir)
            except pysafe.Cancelled as cancelled:
                print(f"CI-ONLY: cancelled by signal {cancelled.signum}; nothing recorded", file=sys.stderr)
                return 128 + cancelled.signum
        if args.action == "require-ci-only-pass":
            if not valid_hex(args.tree, (40, 64)):
                raise ValueError("tree must be a full Git tree hash")
            checks, runtime, path = ci_only_identity(repo, args.tree, judge_root=judge_root,
                                                     suite_root=Path(args.suite_root).expanduser().resolve(),
                                                     cache_dir=args.cache_dir)
            entry, reason = validate_ci_only_record(path, tree=args.tree, checks=checks, runtime=runtime)
            if entry is None:
                others = other_runtime_records(
                    path.parent.glob(f"{args.tree}.ci-only.*.json"), runtime,
                    lambda other, stored: validate_ci_only_record(other, tree=args.tree, checks=checks, runtime=stored))
                if others:
                    print(read_back(None, others, *current_runtime_parts(judge_root)))
                    return 1
                print(f"ci-only record {path.name}: {reason}", file=sys.stderr)
            print(read_back(entry, [], None, "", {}))
            return 0 if entry is not None and entry["verdict"] == "PASS" else 1
        result = records(repo, directory, judge_root, args.tree)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        return 0
    except (OSError, UnicodeError, ValueError, TypeError, KeyError) as error:
        print("VERDICT_STORE_ERROR: " + str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    load_metrics(Path(__file__).resolve().parent.parent).pin_runtime()
    raise SystemExit(main())
