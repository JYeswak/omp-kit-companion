#!/usr/bin/env python3
"""SUITEREMOTE1 (ompkit-qsktr): run the full suite's Linux share on rch's Linux workers.

scripts/full-suite-verdict.sh drives it; nothing here decides a verdict. The workers are the enabled
rch workers tagged linux (``rch workers list --json``; FULL_SUITE_REMOTE_WORKERS="user@host ..." names
them instead), reached as the unprivileged suite user that scripts/suite-worker-setup.sh created, and
admitted only when their /opt/omp-kit-suite/READY.json carries exactly this tree's CI pins and they
have the disk and memory a shard needs. FULL_SUITE_REMOTE_SSH names an ssh-compatible transport
(default ssh). FULL_SUITE_REMOTE_JOBS sets each worker's pool width (default: its cores, at most 4).

Subcommands:
  pins     print the CI pins a worker must carry, as key=value words (--marker: READY.json's form).
  workers  print the enabled rch Linux workers.
  plan     probe the workers and split every non-local-required file across the admitted ones,
           longest first (timing hints only); exit 3 when no worker is configured, ready or reachable.
  run      ship the exact `git archive` of the commit plus its depth-1 commit object to every planned
           worker, run each shard with the candidate's own full-suite-verdict.sh --shard-files, and
           fetch and validate every shard's complete rows; exit 1 unless every shard is complete.
  merge    fold the validated shard rows into the verdict's rows and declared list and write the
           record's evidence.remote block.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shlex
import sys
import tarfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kitlib_run import run  # noqa: E402
from kitlib_tmp import owned_tmp  # noqa: E402

SCRIPTS = Path(__file__).resolve().parent
MAX_JSON_BYTES = 4 << 20
MAX_FETCH_BYTES = 256 << 20
SUITE_USER = "omp-suite"
READY_PATH = "/opt/omp-kit-suite/READY.json"
# CI's ubuntu runner brings its own Node; a worker gets this pinned build (nodejs.org SHASUMS256.txt).
NODE_VERSION = "22.23.2"
NODE_SHA256 = "d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307"
# The push regexploit gate and its suites need python3.11 and regexploit-js (the Mac's omp-kit-regex-tools venv:
# regexploit 1.0.0 on Python 3.11.18); a worker builds the same venv with uv (sha256-checked release).
UV_VERSION = "0.13.7"
PYTHON311_VERSION = "3.11.18"
REGEXPLOIT_VERSION = "1.0.0"
# diagnostics.test.ts exercises the rch client (`missing rch` without it); the Mac carries rch 2.1.34.
RCH_VERSION = "2.1.34"
# A shard needs its archive, per-file scratch and logs: measured peaks stay far below these floors.
MIN_FREE_KIB = 3 << 20
MIN_AVAILABLE_KIB = 1536 << 10
NO_WORKER = 3
PROBE_DEADLINE_S = 30
TRANSFER_DEADLINE_S = 300
SSH_OPTIONS = ("-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15",
               "-o", "ServerAliveCountMax=8")
# Worker-side commands are fixed programs; every variable part is a positional argument.
PROBE = ('cat "$1"; echo; echo "@@disk $(df -Pk "$HOME/work" | awk \'NR == 2 { print $4 }\')"; '
         'echo "@@mem $(awk \'$1 == "MemAvailable:" { print $2 }\' /proc/meminfo)"; echo "@@cpu $(nproc)"')
UPLOAD = ('set -eu; mkdir -p "$HOME/work"; '
          'find "$HOME/work" -mindepth 1 -maxdepth 1 -name "run-*" -mmin +1440 -exec rm -rf {} +; '
          'mkdir "$HOME/work/$1"; tar -xf - -C "$HOME/work/$1"')
SHARD = ('set -eu; d="$HOME/work/$1"; mkdir "$d/a" "$d/judge"; tar -xf "$d/cand.tar" -C "$d/a"; '
         'tar -xf "$d/git.tar" -C "$d/a"; tar -xf "$d/judge.tar" -C "$d/judge"; '
         'exec flock -w "$5" "$HOME/work/.suite.lock" env FULL_SUITE_JOBS="$4" FULL_SUITE_TIMEOUT_SECS="$5" '
         'sh "$d/judge/scripts/full-suite-verdict.sh" --repo "$d/a" --commit "$2" --judge-role "$3" '
         '--archive-dir "$d/a" --shard-files "$d/files.list" --shard-out "$d/out"')
FETCH = 'set -eu; tar -cf - -C "$HOME/work/$1" out'
CLEAN = 'rm -rf "$HOME/work/$1"'


def say(message: str) -> None:
    print(f"FULL-SUITE: REMOTE: {message}", flush=True)


def read_text(path: Path, limit: int = MAX_JSON_BYTES) -> str:
    with path.open("rb") as handle:
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"{path} exceeds {limit} bytes")
    return data.decode("utf-8")


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    if spec is None or spec.loader is None:
        raise ValueError(f"{filename} cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ci_pins(root: Path) -> dict[str, str]:
    """The exact pins .github/workflows/ci.yml installs for its ubuntu cli-contracts legs."""
    ci = read_text(root / ".github" / "workflows" / "ci.yml")
    lsp = re.search(r'npm install --global "@oh-my-pi/pi-coding-agent@\$\{OMP_VERSION\}" '
                    r'typescript-language-server@([0-9.]+) typescript@([0-9.]+)', ci)
    br_step = ci.split("- name: Install pinned br for policy-gate tests", 1)
    br = re.search(r'ver="([0-9.]+)"', br_step[1]) if len(br_step) == 2 else None
    compat = json.loads(read_text(root / "scripts" / "omp-compat.json"))
    bun = read_text(root / ".bun-version").strip()
    # commit-preflight's pinned shellcheck engine (its shell gate runs it under Docker).
    shellcheck = re.search(r"'(koalaman/shellcheck:v[0-9.]+)'", read_text(root / "scripts" / "commit-preflight.py"))
    if lsp is None or br is None or shellcheck is None or not isinstance(compat.get("certified"), str) or not bun:
        raise ValueError("ci.yml, omp-compat.json, commit-preflight.py or .bun-version no longer names the worker pins")
    return {"bun": bun, "omp": compat["certified"], "tsls": lsp.group(1), "ts": lsp.group(2), "br": br.group(1),
            "node": NODE_VERSION, "node_sha256": NODE_SHA256, "shellcheck": shellcheck.group(1),
            "uv": UV_VERSION, "python311": PYTHON311_VERSION, "regexploit": REGEXPLOIT_VERSION, "rch": RCH_VERSION}


def pins_marker(pins: dict[str, str]) -> str:
    """READY.json's "pins": what suite-worker-setup.sh installed, compared exactly before a worker is used."""
    return ",".join(f"{key}={pins[key]}" for key in sorted(pins))


def rch_workers() -> list[dict[str, str]]:
    """Enabled rch workers tagged linux, from rch's own listing (the one inventory)."""
    result = run(["rch", "workers", "list", "--json"], deadline_s=30, max_output_bytes=MAX_JSON_BYTES)
    if result.rc != 0 or result.timed_out or result.truncated:
        raise ValueError("rch workers list --json failed")
    listing = json.loads(result.stdout.decode("utf-8"))
    workers = []
    for row in listing.get("data", {}).get("workers", []):
        tags = row.get("tags") or []
        if "linux" in tags and isinstance(row.get("host"), str) and isinstance(row.get("id"), str):
            workers.append({"id": row["id"], "host": row["host"], "user": str(row.get("user") or "root")})
    return workers


def suite_targets() -> tuple[list[str], str]:
    """The suite user's ssh targets and where they came from; empty when nothing is configured."""
    named = os.environ.get("FULL_SUITE_REMOTE_WORKERS", "").split()
    if named:
        return named, "FULL_SUITE_REMOTE_WORKERS"
    try:
        workers = rch_workers()
    except FileNotFoundError:
        return [], "no rch on PATH and FULL_SUITE_REMOTE_WORKERS is unset"
    except (OSError, ValueError, UnicodeError) as error:
        return [], f"rch workers list failed ({error})"
    if not workers:
        return [], "rch lists no enabled Linux worker"
    return [f"{SUITE_USER}@{worker['host']}" for worker in workers], "rch workers list"


def remote(target: str, program: str, *args: str, deadline_s: float, stdin: bytes | None = None,
           max_output_bytes: int = 1 << 20):
    """Run one fixed worker program with positional arguments over the configured ssh transport."""
    transport = os.environ.get("FULL_SUITE_REMOTE_SSH") or "ssh"
    command = " ".join(shlex.quote(word) for word in ("sh", "-c", program, "full-suite-remote", *args))
    return run([transport, *SSH_OPTIONS, target, command], deadline_s=deadline_s, stdin=stdin,
               max_output_bytes=max_output_bytes)


def probe(target: str, marker: str) -> tuple[str, int, str]:
    """(target, pool width, "") when admitted, else (target, 0, reason)."""
    try:
        result = remote(target, PROBE, READY_PATH, deadline_s=PROBE_DEADLINE_S)
    except OSError as error:
        return target, 0, f"transport failed ({error})"
    if result.timed_out:
        return target, 0, "unreachable (probe timed out)"
    if result.rc != 0:
        return target, 0, f"unreachable (rc={result.rc}: {result.stderr.decode('utf-8', 'replace').strip()[-200:]})"
    text = result.stdout.decode("utf-8", "replace")
    facts = dict(line[2:].split(" ", 1) for line in text.splitlines() if line.startswith("@@") and " " in line)
    ready_text = text.split("\n@@", 1)[0].strip()
    try:
        ready = json.loads(ready_text) if ready_text else {}
    except ValueError:
        ready = {}
    if not isinstance(ready, dict) or ready.get("pins") != marker:
        return target, 0, "not set up for this tree's CI pins (run scripts/suite-worker-setup.sh)"
    try:
        free_kib, available_kib, cpus = int(facts["disk"]), int(facts["mem"]), int(facts["cpu"])
    except (KeyError, ValueError):
        return target, 0, "probe output is incomplete"
    if free_kib < MIN_FREE_KIB:
        return target, 0, f"only {free_kib >> 20} GiB free in the work root"
    if available_kib < MIN_AVAILABLE_KIB:
        return target, 0, f"only {available_kib >> 10} MiB memory available (rch builds share these workers)"
    jobs = os.environ.get("FULL_SUITE_REMOTE_JOBS", "")
    width = int(jobs) if jobs.isdigit() and int(jobs) > 0 else max(1, min(4, cpus))
    return target, width, ""


def timing_hints(cache_dir: Path) -> dict[str, float]:
    """Seconds per file: this store's Linux shard table first, then any record's rows. Hints order work only."""
    hints: dict[str, float] = {}
    table = cache_dir / "timings" / "remote-linux.json"
    try:
        files = json.loads(read_text(table)).get("files", {})
        hints.update({path: ms / 1000 for path, ms in files.items() if isinstance(ms, (int, float))})
    except (OSError, ValueError, AttributeError):
        pass
    for entry in sorted(cache_dir.glob("*.json"), key=lambda path: path.stat().st_mtime, reverse=True):
        try:
            data = json.loads(read_text(entry, 8 << 20))
            rows = data.get("evidence", {}).get("files", []) if isinstance(data, dict) else []
            for row in rows:
                hints.setdefault(row["path"], row["elapsed_ms"] / 1000)
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            continue
    return hints


def assign(files: list[str], widths: dict[str, int], hints: dict[str, float]) -> dict[str, list[str]]:
    """Longest processing time first onto the worker with the least load per pool slot. Unknown files go
    first with the longest known estimate, like the local pool's unknown-first order."""
    longest = max(hints.values(), default=60.0)
    ordered = sorted(files, key=lambda path: (path in hints, -hints.get(path, longest), path))
    load = {target: 0.0 for target in widths}
    shards: dict[str, list[str]] = {target: [] for target in widths}
    for path in ordered:
        target = min(load, key=lambda name: (load[name] / widths[name], name))
        shards[target].append(path)
        load[target] += hints.get(path, longest)
    return {target: names for target, names in shards.items() if names}


def plan(args: argparse.Namespace) -> int:
    out = Path(args.out)
    files = read_text(Path(args.files)).split()
    required = read_text(Path(args.local_required)).split()
    if not required:
        say("off (this tree declares no local-required file, and a record judged wholly on workers is "
            "refused); running the complete suite on this host")
        return NO_WORKER
    targets, source = suite_targets()
    if not targets:
        say(f"off ({source}); running the complete suite on this host")
        return NO_WORKER
    marker = pins_marker(ci_pins(SCRIPTS.parent))
    with ThreadPoolExecutor(max_workers=len(targets)) as pool:
        probes = list(pool.map(lambda target: probe(target, marker), targets))
    widths = {target: width for target, width, _reason in probes if width}
    for target, width, reason in probes:
        say(f"worker {target}: " + (f"admitted, {width} slots" if width else f"not used: {reason}"))
    if not widths:
        say(f"off (no {source} worker is ready and reachable); running the complete suite on this host")
        return NO_WORKER
    remote_files = [path for path in files if path not in set(required)]
    shards = assign(remote_files, widths, timing_hints(Path(args.cache_dir)))
    document = {"repo": args.repo, "commit": args.commit, "tree": args.tree, "role": args.role,
                "checks": args.checks, "cache_dir": args.cache_dir, "local_required": required,
                "shards": [{"worker": target, "jobs": widths[target], "files": names}
                           for target, names in sorted(shards.items())]}
    (out / "plan.json").write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
    (out / "remote-files").write_text("".join(path + "\n" for names in shards.values() for path in names))
    for target, names in sorted(shards.items()):
        say(f"shard {target}: {len(names)} files")
    return 0


def package(repo: str, commit: str, scratch: Path) -> tuple[bytes, bytes, bytes]:
    """The exact `git archive` of the commit; a .git holding only its depth-1 commit object (what
    full-suite-verdict.sh fetches into its own archive for the main role); and this judge's own
    scripts/ and .github/test-budget.json, so every shard judges with the bytes this host's judge
    identity hashes (each shard reports its identity, and a different one is refused)."""
    environment = {key: value for key, value in os.environ.items()
                   if key not in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY")}
    archive = scratch / "cand.tar"
    steps = [
        ["git", "-C", repo, "archive", "--format=tar", "-o", str(archive), commit],
        ["git", "-C", str(scratch / "shallow"), "-c", "init.defaultBranch=main", "init", "-q"],
        ["git", "-C", str(scratch / "shallow"), "fetch", "-q", "--depth", "1", repo, commit],
    ]
    (scratch / "shallow").mkdir()
    environment["GIT_CEILING_DIRECTORIES"] = str(scratch)
    for step in steps:
        result = run(step, deadline_s=TRANSFER_DEADLINE_S, env=environment)
        if result.rc != 0 or result.timed_out:
            raise ValueError(f"{' '.join(step[3:5])} failed: {result.stderr.decode('utf-8', 'replace')[-300:]}")
    gitdir = io.BytesIO()
    with tarfile.open(fileobj=gitdir, mode="w") as bundle:
        bundle.add(str(scratch / "shallow" / ".git"), arcname=".git")
    judge = io.BytesIO()

    def no_cache(info: tarfile.TarInfo):
        return None if "__pycache__" in info.name.split("/") else info
    with tarfile.open(fileobj=judge, mode="w") as bundle:
        bundle.add(str(SCRIPTS), arcname="scripts", filter=no_cache)
        budget = SCRIPTS.parent / ".github" / "test-budget.json"
        if budget.is_file():
            bundle.add(str(budget), arcname=".github/test-budget.json")
    with archive.open("rb") as handle:
        return handle.read(), gitdir.getvalue(), judge.getvalue()


def upload_bytes(candidate: bytes, gitdir: bytes, judge: bytes, files: list[str]) -> bytes:
    payload = io.BytesIO()
    with tarfile.open(fileobj=payload, mode="w") as bundle:
        for name, data in (("cand.tar", candidate), ("git.tar", gitdir), ("judge.tar", judge),
                           ("files.list", "".join(path + "\n" for path in files).encode())):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o600
            bundle.addfile(info, io.BytesIO(data))
    return payload.getvalue()


def validate_shard(result: dict, shard: dict, plan_doc: dict, metrics) -> dict:
    """The shard's own evidence for exactly its files, from one producer, for this tree, commit and judge."""
    files = shard["files"]
    if (result.get("version") != 1 or result.get("tree") != plan_doc["tree"] or result.get("commit") != plan_doc["commit"]
            or result.get("judge_role") != plan_doc["role"] or result.get("checks") != plan_doc["checks"]):
        raise ValueError("shard evidence is for another tree, commit, role or judge")
    runtime = result.get("runtime")
    environment = result.get("environment")
    if (not isinstance(runtime, str) or not isinstance(environment, dict)
            or not runtime.endswith("/env-" + metrics.environment_digest(environment))):
        raise ValueError("shard runtime is inconsistent with its environment")
    rows = result.get("files")
    declared = result.get("declared_files")
    if not isinstance(declared, list) or sorted(declared) != sorted(files):
        raise ValueError("shard declared another file set")
    if not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
        raise ValueError("shard has no rows")
    judge = rows[0].get("judge")
    if not isinstance(judge, dict) or judge.get("sha256") != metrics.JUDGE_SHA256:
        raise ValueError("shard ran another suite-metrics producer")
    if not metrics.complete_records(rows, files, expected_judge=judge):
        raise ValueError("shard rows are incomplete or mix producers")
    if any(row.get("closure", {}).get("tree") != plan_doc["tree"] for row in rows):
        raise ValueError("shard rows do not bind the candidate tree")
    status = result.get("status")
    if not isinstance(status, list) or not all(isinstance(line, str) for line in status):
        raise ValueError("shard status is malformed")
    reported = sorted(line.split()[2] for line in status if line.split()[:1] in (["GREEN"], ["RED"]))
    scripts = sorted(row["path"] for row in rows if row["runner"] in ("sh", "python3"))
    if reported != scripts:
        raise ValueError("shard status does not account for every script suite")
    bun_rows = [row for row in rows if row["runner"] == "bun"]
    if bun_rows and sum(1 for line in status if line.startswith("BUN rc=")) != 1:
        raise ValueError("shard status lacks its one Bun summary")
    return {"worker": shard["worker"], "runtime": runtime, "environment": environment, "judge": judge,
            "files": files, "log_sha256": result.get("log_sha256"), "wall_ms": result.get("wall_ms"),
            "jobs": shard["jobs"], "verdict": result.get("verdict")}


def run_shard(shard: dict, plan_doc: dict, payload: bytes, run_id: str, deadline_at: float, metrics) -> dict:
    target = shard["worker"]
    started = time.monotonic()
    upload = remote(target, UPLOAD, run_id, deadline_s=TRANSFER_DEADLINE_S, stdin=payload)
    if upload.rc != 0 or upload.timed_out:
        raise ValueError(f"upload failed (rc={upload.rc}): {upload.stderr.decode('utf-8', 'replace')[-300:]}")
    try:
        remaining = int(deadline_at - time.monotonic())
        if remaining < 60:
            raise ValueError("no time left for the shard")
        result = remote(target, SHARD, run_id, plan_doc["commit"], plan_doc["role"], str(shard["jobs"]),
                        str(remaining - 30), deadline_s=remaining, max_output_bytes=8 << 20)
        progress = result.stdout.decode("utf-8", "replace") + result.stderr.decode("utf-8", "replace")
        if result.timed_out or result.rc != 0:
            raise ValueError(f"shard ended without complete evidence (rc={result.rc}, timed_out={result.timed_out}): "
                             + progress[-1500:])
        fetched = remote(target, FETCH, run_id, deadline_s=TRANSFER_DEADLINE_S, max_output_bytes=MAX_FETCH_BYTES)
        if fetched.rc != 0 or fetched.timed_out or fetched.truncated:
            raise ValueError(f"fetching shard evidence failed (rc={fetched.rc})")
    finally:
        remote(target, CLEAN, run_id, deadline_s=PROBE_DEADLINE_S)
    with tarfile.open(fileobj=io.BytesIO(fetched.stdout), mode="r") as bundle:
        def member(name: str) -> bytes:
            handle = bundle.extractfile(f"out/{name}")
            if handle is None:
                raise ValueError(f"shard evidence lacks {name}")
            return handle.read()
        result_doc = json.loads(member("result.json"))
        log = member("shard.log")
    if hashlib.sha256(log).hexdigest() != result_doc.get("log_sha256"):
        raise ValueError("shard log does not match its evidence")
    summary = validate_shard(result_doc, shard, plan_doc, metrics)
    rows = [{**row, "origin": "remote", "worker": target} for row in result_doc["files"]]
    say(f"shard {target}: {len(rows)} files complete in {int(time.monotonic() - started)}s, verdict {summary['verdict']}")
    return {"summary": summary, "rows": rows, "status": result_doc["status"], "log": log}


def run_plan(args: argparse.Namespace) -> int:
    out = Path(args.out)
    plan_doc = json.loads(read_text(out / "plan.json"))
    deadline_at = time.monotonic() + args.deadline
    metrics = load_module("omp_kit_suite_metrics", "suite-metrics.py")
    with owned_tmp("full-suite-remote", root=str(out)) as scratch:
        candidate, gitdir, judge = package(plan_doc["repo"], plan_doc["commit"], Path(scratch))
    run_id = "run-" + hashlib.sha256(f"{plan_doc['tree']}:{os.getpid()}:{time.time_ns()}".encode()).hexdigest()[:16]
    shards = plan_doc["shards"]
    say(f"shipping {len(candidate)} archive bytes for {plan_doc['commit']} to {len(shards)} workers ({run_id})")

    def one(shard: dict) -> dict:
        try:
            return run_shard(shard, plan_doc, upload_bytes(candidate, gitdir, judge, shard["files"]), run_id,
                             deadline_at, metrics)
        except (OSError, ValueError, KeyError, TypeError, tarfile.TarError) as error:
            return {"error": f"shard {shard['worker']}: {error}"}

    with ThreadPoolExecutor(max_workers=len(shards)) as pool:
        outcomes = list(pool.map(one, shards))
    errors = [outcome["error"] for outcome in outcomes if "error" in outcome]
    if errors:
        for error in errors:
            say("INCOMPLETE " + error)
        return 1
    (out / "shards.json").write_text(json.dumps([outcome["summary"] for outcome in outcomes], sort_keys=True))
    (out / "rows.json").write_text(json.dumps([row for outcome in outcomes for row in outcome["rows"]], sort_keys=True))
    (out / "status").write_text("".join(line + "\n" for outcome in outcomes for line in outcome["status"]))
    with (out / "remote.log").open("wb") as log:
        for outcome in outcomes:
            log.write(f"full-suite: remote shard {outcome['summary']['worker']} "
                      f"({outcome['summary']['runtime']}) output follows\n".encode())
            log.write(outcome["log"])
    table = Path(plan_doc["cache_dir"]) / "timings" / "remote-linux.json"
    try:
        previous = json.loads(read_text(table)) if table.exists() else {"version": 1, "files": {}}
        previous["files"].update({row["path"]: row["elapsed_ms"] for outcome in outcomes for row in outcome["rows"]})
        table.parent.mkdir(parents=True, exist_ok=True)
        temporary = table.with_name(table.name + f".tmp.{os.getpid()}")
        temporary.write_text(json.dumps(previous, sort_keys=True))
        os.replace(temporary, table)
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        say("timing hints were not updated (scheduling only; the evidence is unaffected)")
    say(f"all {len(outcomes)} shards complete")
    return 0


def merge(args: argparse.Namespace) -> int:
    """Append the shard rows to the verdict's rows and declared list; write evidence.json."""
    out = Path(args.out)
    store = load_module("omp_kit_full_suite_verdict_store", "full-suite-verdict-store.py")
    shards = json.loads(read_text(out / "shards.json"))
    remote_rows = json.loads(read_text(out / "rows.json", 64 << 20))
    rows_path, declared_path = Path(args.rows), Path(args.declared)
    rows = json.loads(read_text(rows_path, 64 << 20))
    declared = read_text(declared_path).split()
    overlap = {row["path"] for row in rows} & {row["path"] for row in remote_rows}
    if overlap or set(declared) & {row["path"] for row in remote_rows}:
        raise ValueError("a file ran both here and on a worker: " + ", ".join(sorted(overlap)))
    rows = sorted(rows + remote_rows, key=lambda row: row["path"])
    declared += [path for shard in shards for path in shard["files"]]
    evidence = {"shards": shards, "local_required": store.local_required(declared)}
    for path, value in ((rows_path, json.dumps(rows, sort_keys=True)),
                        (declared_path, "".join(path + "\n" for path in declared)),
                        (out / "evidence.json", json.dumps(evidence, sort_keys=True))):
        temporary = path.with_name(path.name + f".tmp.{os.getpid()}")
        temporary.write_text(value)
        os.replace(temporary, path)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    actions = parser.add_subparsers(dest="action", required=True)
    pins_cmd = actions.add_parser("pins")
    pins_cmd.add_argument("--root", default=str(SCRIPTS.parent))
    pins_cmd.add_argument("--marker", action="store_true")
    workers_cmd = actions.add_parser("workers")
    workers_cmd.add_argument("--format", choices=("ssh", "json"), default="json")
    plan_cmd = actions.add_parser("plan")
    for name in ("--repo", "--commit", "--tree", "--role", "--checks", "--files", "--local-required",
                 "--cache-dir", "--out"):
        plan_cmd.add_argument(name, required=True)
    run_cmd = actions.add_parser("run")
    run_cmd.add_argument("--out", required=True)
    run_cmd.add_argument("--deadline", type=int, required=True)
    merge_cmd = actions.add_parser("merge")
    for name in ("--out", "--rows", "--declared"):
        merge_cmd.add_argument(name, required=True)
    args = parser.parse_args(argv)
    try:
        if args.action == "pins":
            pins = ci_pins(Path(args.root))
            print(pins_marker(pins) if args.marker else " ".join(f"{key}={value}" for key, value in pins.items()))
            return 0
        if args.action == "workers":
            workers = rch_workers()
            if args.format == "ssh":
                for worker in workers:
                    print(f"{worker['user']}@{worker['host']}")
            else:
                print(json.dumps(workers, sort_keys=True))
            return 0
        if args.action == "plan":
            return plan(args)
        if args.action == "run":
            return run_plan(args)
        return merge(args)
    except (OSError, ValueError, KeyError, TypeError, UnicodeError) as error:
        print(f"FULL-SUITE: REMOTE: {args.action} failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
