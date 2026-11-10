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
import stat
import sys
from urllib.parse import unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kitlib_run import run
import pysafe

# RELFLAKE1 (J-2026-11-10-04): four red files indicate a broad failure, not a flake.
MAX_FLAKE_FILES = 3

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
# SUITEREMOTE1 (ompkit-qsktr): declared suite files a composed record must judge on the reading (macOS) host,
# never on a Linux worker. tests/cli/service.test.ts is what CI's push run judges only on macos-15
# (mac-service-contracts). The rest run tests on Darwin that skip on Linux: measured 2026-11-08 by comparing
# per-test (pass)/(skip) names of a Linux full run of 1b49f8ccb6 on contabo-1 with the Mac's main PASS of
# tree 385dcbc66f (sandbox-exec write fences, macOS plutil, Darwin-only preflight and release paths).
# tests/cli/snapshot-publication.test.py needs the native Agent Mail `am` binary, which only this host carries.
LOCAL_REQUIRED = (
    "tests/cli/operator-snapshot.test.ts",
    "tests/cli/preflight.test.ts",
    "tests/cli/release-local.test.ts",
    "tests/cli/release-next-version.test.ts",
    "tests/cli/runtime.test.ts",
    "tests/cli/service.test.ts",
    "tests/cli/snapshot-publication.test.py",
    "tests/fleet-guard/plutil.test.ts",
    "tests/cli/check-pushed-beads.test.sh",  # Linux failure, ompkit-ltawi
    "tests/cli/install-commit-msg-bead.test.sh",  # Linux failure, ompkit-ltawi
    "tests/cli/ref-txn-bead.test.sh",  # Linux failure, ompkit-ltawi
    "tests/cli/savefirst-pre-push.test.sh",  # Linux failure, ompkit-ltawi
    "tests/cli/scratch-kitlib.test.ts",  # Linux failure, ompkit-ltawi
    "tests/cli/full-suite-complement.test.sh",  # Linux failure, ompkit-ltawi
    "tests/cli/kit-update-nplus-two.test.ts",  # Linux failure, ompkit-ltawi
    "tests/cli/package-release-live.test.ts",  # Linux failure, ompkit-ltawi
    # RELFLAKE1 (ompkit-1ra0d.109): on the shared 4-core shards these hit bun's 120 s per-test limit (each takes
    # 20-45 s here) or failed a wall-clock/CPU budget, a different one per verdict of one unchanged tree; every
    # one passes alone on Linux and on this host. Six 2026-11-10 verdicts named them.
    "tests/cli/package-release.test.ts",  # native full-test hit 120 s on 3 verdicts
    "tests/cli/apply-policy-settings.test.ts",  # hit 120 s
    "tests/cli/output-ids.test.ts",  # hit 120 s
    "tests/cli/test-runner.test.ts",  # long-token CPU budget, 21 historic failure lines
    "tests/cli/regex-budget.test.ts",  # stream budget timing
    # LOCKLINUX1 (ompkit-1ra0d.111): the non-inheriting-child lock cases fail intermittently on Linux only (5 verdict
    # logs 11-09..11-10, never on macOS). The release judges them here; CI's Linux job still runs both files, so the
    # Linux defect stays visible there until LOCKLINUX1 names the holder.
    "tests/cli/kitlib-lock.test.ts",
    "tests/scripts/kitlib_lock_test.py",
)


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


def validate_flakes(entry: dict, metrics) -> set[str]:
    """Keep original failed rows intact; only complete, local single reruns excuse them."""
    flakes = entry.get("flakes", [])
    reruns = entry["evidence"].get("reruns", [])
    if not isinstance(flakes, list) or not isinstance(reruns, list):
        raise ValueError("single-rerun evidence must be lists")
    if not flakes and not reruns:
        return set()
    failed = {row["path"]: row for row in entry["evidence"]["files"] if row["rc"] != 0}
    if (entry["judge_role"] != "main" or not 0 < len(failed) <= MAX_FLAKE_FILES
            or not metrics.complete_records(reruns, sorted(failed))):
        raise ValueError("single-rerun evidence is incomplete")
    expected = []
    for row in reruns:
        if row["closure"]["tree"] != entry["tree"] or row.get("origin") == "remote":
            raise ValueError("single rerun is not local evidence for this tree")
        if row["rc"] == 0:
            first = failed[row["path"]]
            expected.append({"file": row["path"], "first_fail_tests": max(1, first.get("test_failures", 1)),
                             "rerun": "pass"})
    if flakes != expected:
        raise ValueError("flake names differ from successful single reruns")
    return {row["file"] for row in flakes}


def rerun_failures(args: argparse.Namespace) -> dict:
    """Use producer rows, never log prose, to select at most three files for one local rerun."""
    root = Path(__file__).resolve().parent.parent
    rows = json_value(Path(args.rows))
    failed = sorted((row for row in rows if row["rc"] != 0), key=lambda row: row["path"])
    result = {"flakes": [], "reruns": [], "twice_failing_files": []}
    if not 0 < len(failed) <= MAX_FLAKE_FILES:
        return result
    metrics = load_metrics(root)
    archive = Path(args.archive).resolve()
    # Use the same measured hermetic runner, tool policy and archive as the first pass.
    # The enclosing full-suite invocation still holds its suite lease.
    # Imported here, not at module load: an archived legacy base judge ships no kitlib_tmp.py and still
    # imports this store for every other action (private-index-land-3 'legacy base without HERMETIC1').
    from kitlib_tmp import owned_tmp
    with owned_tmp("full-suite-single-rerun") as scratch:
        for index, first in enumerate(failed):
            path = first["path"]
            runner = first["runner"]
            if runner == "bun":
                config = archive / "bunfig.toml"
                command = ["bun", f"--config={config if config.is_file() else '/dev/null'}",
                           "test", "--timeout=120000", "./" + path]
            else:
                command = [runner, path]
            record = Path(scratch) / f"{index}.json"
            child = run(["nice", "-n", "10", sys.executable, str(root / "scripts/suite-metrics.py"),
                         "run", "--record", str(record), "--path", path, "--runner", runner,
                         "--tree", args.tree, "--cwd", str(archive), "--workers", "1",
                         "--deadline", str(args.deadline), "--", *command],
                        cwd=archive, deadline_s=args.deadline + 15, max_output_bytes=MAX_COMMAND_OUTPUT)
            with Path(args.log).open("ab") as log:
                log.write(f"\nFULL-SUITE: single rerun: {path}\n".encode())
                log.write(child.stdout)
                log.write(child.stderr)
            row = json_file(record)
            if (child.timed_out or child.killed or child.truncated
                    or not metrics.complete_records([row], [path])):
                raise ValueError("single rerun did not finish completely: " + path)
            result["reruns"].append(row)
            if row["rc"] == 0:
                result["flakes"].append({"file": path, "first_fail_tests": max(1, first.get("test_failures", 1)),
                                         "rerun": "pass"})
            else:
                result["twice_failing_files"].append(path)
    return result


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


def declared_suite_files(root: Path, role: str = "base") -> set[str]:
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
    return declared if role == "main" else declared - excluded_paths(root)


def declared_suite_files_from_git(repo: Path, commit: str, role: str = "base") -> set[str]:
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
    if role != "main" and "scripts/gate-ci-only.tsv" in paths:
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


def validate_runtime_environment(environment: object, runtime: str) -> None:
    metrics = load_metrics(Path(__file__).resolve().parent.parent)
    if (not isinstance(environment, dict) or not isinstance(environment.get("PATH"), str)
            or not all(isinstance(key, str) and isinstance(value, str) for key, value in environment.items())
            or not runtime.endswith("/env-" + metrics.environment_digest(environment))):
        raise ValueError("record environment differs from its runtime")


def local_required(declared) -> list[str]:
    """The declared files a composed record must judge on this host (LOCAL_REQUIRED), sorted."""
    return sorted(set(LOCAL_REQUIRED) & set(declared))


def validate_remote(remote: object, files: list, declared: list, metrics, producer: dict | None,
                    entry_runtime: str) -> None:
    """SUITEREMOTE1: a record whose evidence.remote lists Linux worker shards is valid only when every
    shard's rows come from that shard's one producer (the same suite-metrics bytes this judge carries),
    the shards are disjoint, and the rest, which holds every local-required file and is never empty,
    comes from this host's producer. A record judged wholly on workers never satisfies a reader."""
    if not isinstance(remote, dict) or set(remote) != {"shards", "local_required"}:
        raise ValueError("remote evidence is malformed")
    shards = remote["shards"]
    if not isinstance(shards, list) or not shards:
        raise ValueError("remote evidence names no shard")
    expected_required = local_required(declared)
    if not expected_required or remote["local_required"] != expected_required:
        raise ValueError("remote evidence lacks this judge's local-required files")
    local_producer = producer or {"sha256": metrics.JUDGE_SHA256, "python": sys.version.split()[0]}
    rows: dict[str, dict] = {}
    for row in files:
        if not isinstance(row, dict) or not isinstance(row.get("path"), str) or row["path"] in rows:
            raise ValueError("measured file evidence is invalid")
        rows[row["path"]] = row
    if set(rows) != set(declared):
        raise ValueError("measured file evidence is incomplete")
    remote_paths: set[str] = set()
    for shard in shards:
        if not isinstance(shard, dict):
            raise ValueError("remote shard is malformed")
        worker, runtime, judge, shard_files = (shard.get("worker"), shard.get("runtime"), shard.get("judge"),
                                               shard.get("files"))
        if not isinstance(worker, str) or not worker or not isinstance(runtime, str) or not isinstance(judge, dict):
            raise ValueError("remote shard identity is incomplete")
        normalized_identity("0" * 40, "main", "0" * 64, runtime)
        validate_runtime_environment(shard.get("environment"), runtime)
        if judge.get("sha256") != local_producer["sha256"]:
            raise ValueError("remote shard ran another suite-metrics producer")
        if (not isinstance(shard_files, list) or not shard_files or len(set(shard_files)) != len(shard_files)
                or not set(shard_files) <= set(declared) or remote_paths & set(shard_files)):
            raise ValueError("remote shard file set is invalid")
        shard_rows = [rows[name] for name in shard_files]
        if any(row.get("origin") != "remote" or row.get("worker") != worker for row in shard_rows):
            raise ValueError("remote shard rows are not attributed to their worker")
        if not metrics.complete_records(shard_rows, shard_files, expected_judge=judge):
            raise ValueError("remote shard rows are incomplete or mix producers")
        remote_paths.update(shard_files)
    local = [name for name in declared if name not in remote_paths]
    if not set(expected_required) <= set(local):
        raise ValueError("a local-required file ran on a worker")
    local_rows = [rows[name] for name in local]
    if any(row.get("origin") == "remote" for row in local_rows):
        raise ValueError("a worker row is outside every shard")
    if not metrics.complete_records(local_rows, local, expected_judge=local_producer):
        raise ValueError("local file evidence is incomplete or mixes producers")


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
        local_rows = [row for row in files if isinstance(row, dict) and row.get("origin") != "remote"]
        producer = local_rows[0].get("judge") if historical and local_rows else None
        if "remote" in evidence:
            validate_remote(evidence["remote"], files, declared, metrics, producer, entry_runtime)
        elif not metrics.complete_records(files, declared, expected_judge=producer):
            raise ValueError("measured file evidence is incomplete")
        if suite_root is not None:
            expected_files = declared_suite_files(suite_root, entry_role)
            if set(declared) != expected_files:
                raise ValueError("declared suite set differs from the exact source tree")
        elif repo is not None and commit is not None:
            expected_files = declared_suite_files_from_git(repo, commit, entry_role)
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
        flaked = validate_flakes(entry, metrics)
        if entry["verdict"] == "PASS":
            failed_files = {row["path"] for row in files if row["rc"] != 0}
            if (exit_code != 0 or minimum_failures or failed_files != flaked
                    or ((bun_fail or shell_fail or py_fail) and not flaked)):
                raise ValueError("PASS contains a failing suite without a passing single rerun")
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
RUNTIME_FIELDS = ("system", "machine", "bun", "python", "omp")


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
    list_cmd = actions.add_parser("list")
    add_store_options(list_cmd)
    list_cmd.add_argument("--tree")
    list_cmd.add_argument("--judge-root")
    failing_cmd = actions.add_parser("failing-tests")
    rerun_cmd = actions.add_parser("rerun-failures")
    for option in ("rows", "archive", "tree", "log"):
        rerun_cmd.add_argument("--" + option, required=True)
    rerun_cmd.add_argument("--deadline", type=float, required=True)
    flakes_cmd = actions.add_parser("flakes")
    add_store_options(flakes_cmd)
    flakes_cmd.add_argument("--tree", required=True)
    flakes_cmd.add_argument("--role", choices=ROLES, required=True)
    flakes_cmd.add_argument("--judge-root", required=True)
    flakes_cmd.add_argument("--suite-root", required=True)
    failing_cmd.add_argument("--log", required=True)
    required_cmd = actions.add_parser("local-required")
    required_cmd.add_argument("--suite-root", required=True)
    args = parser.parse_args()
    if args.action == "rerun-failures":
        try:
            print(json.dumps(rerun_failures(args), sort_keys=True))
            return 0
        except (OSError, ValueError, TypeError, KeyError) as error:
            print("VERDICT_STORE_ERROR: " + str(error), file=sys.stderr)
            return 2
    if args.action == "local-required":
        # SUITEREMOTE1: the declared files of this source tree a composed record judges on this host.
        for name in local_required(declared_suite_files(Path(args.suite_root).expanduser().resolve(), "main")):
            print(name)
        return 0
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
        if args.action in ("require-pass", "flakes"):
            judge_root = Path(args.judge_root).expanduser().resolve()
            checks, runtime = command_identity(args, judge_root)
            entry, _reason = lookup(repo, args.tree, args.role, checks, runtime,
                                   judge_root=judge_root, cache_dir=args.cache_dir,
                                   suite_root=Path(args.suite_root).expanduser().resolve(), commit=None)
            if args.action == "flakes":
                if entry is None or entry["verdict"] != "PASS":
                    return 1
                for flake in entry.get("flakes", []):
                    print(flake["file"])
                return 0
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
        result = records(repo, directory, judge_root, args.tree)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        return 0
    except (OSError, UnicodeError, ValueError, TypeError, KeyError) as error:
        print("VERDICT_STORE_ERROR: " + str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    load_metrics(Path(__file__).resolve().parent.parent).pin_runtime()
    raise SystemExit(main())
