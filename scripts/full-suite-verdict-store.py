#!/usr/bin/env python3
"""Resolve and validate the shared, role-bound full-suite verdict store."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
from urllib.parse import unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kitlib_run import run

ROLES = ("base", "main")
MAX_RECORD_BYTES = 1 << 20
MAX_COMMAND_OUTPUT = 16 << 20


def checked_run(argv: list[str], *, deadline_s: float = 15, cwd: Path | None = None,
                output_bytes: int = MAX_COMMAND_OUTPUT) -> bytes:
    result = run(argv, deadline_s=deadline_s, cwd=cwd, max_output_bytes=output_bytes)
    if result.rc != 0 or result.timed_out or result.truncated:
        raise ValueError(f"command did not complete: {argv[0]}")
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


def json_file(path: Path) -> dict:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_RECORD_BYTES:
        raise ValueError("record is not a bounded regular file")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("record is not a JSON object")
    return value


def validate_record(path: Path, *, judge_root: Path, tree: str | None = None, role: str | None = None,
                    checks: str | None = None, runtime: str | None = None,
                    suite_root: Path | None = None, repo: Path | None = None,
                    commit: str | None = None, exact_filename: bool = False) -> tuple[dict | None, str]:
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
        if not metrics.complete_records(files, declared):
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
        if entry["verdict"] == "PASS":
            if exit_code != 0 or bun_fail or shell_fail or py_fail or any(row.get("rc") != 0 for row in files):
                raise ValueError("PASS contains a failing suite")
        elif exit_code == 0 or not (bun_fail or shell_fail or py_fail):
            raise ValueError("FAIL has no recorded failure")
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


def command_identity(args: argparse.Namespace, judge_root: Path) -> tuple[str, str]:
    checks = getattr(args, "checks", None) or judge_identity(judge_root)
    runtime = getattr(args, "runtime", None) or runtime_identity(judge_root)
    if not valid_hex(checks, (64,)) or not runtime:
        raise ValueError("judge identity is incomplete")
    return checks, runtime


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
    list_cmd = actions.add_parser("list")
    add_store_options(list_cmd)
    list_cmd.add_argument("--tree")
    list_cmd.add_argument("--judge-root")
    args = parser.parse_args()
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
            if entry is not None and entry["verdict"] == "PASS":
                print("PASS")
                return 0
            print("FAIL" if entry is not None else "MISS")
            return 1
        result = records(repo, directory, judge_root, args.tree)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        return 0
    except (OSError, UnicodeError, ValueError, TypeError, KeyError) as error:
        print("VERDICT_STORE_ERROR: " + str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
