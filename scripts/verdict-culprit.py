#!/usr/bin/env python3
"""CULPRIT1 (ompkit-6xxhu): name the commit that turned a published head's full suite red.

scripts/release-verdict.sh runs this, from the judged commit's own export, after the full-suite
runner returns nonzero. Steps:

  1. read the head tree's newest valid main-role verdict in the shared store; anything but a FAIL
     records nothing;
  2. take the failing test files from that verdict's measured rows (rc != 0);
  3. rerun those files at the head, each run in a fresh `git archive` export under this run's
     kitlib tmp dir; when none fails again the red was a flake and no commit is blamed;
  4. otherwise bisect the first-parent commits newer than the newest commit whose tree has a valid
     main-role PASS (at most 8, the head included), rerunning only the files that failed again;
  5. record the result as the verdict's `culprit` object (full-suite-verdict-store.py validates
     it), print `CULPRIT <sha> <author> <bead>` or `CULPRIT none (<reason>)`, and add a REWORK
     comment to the culprit's bead (`br comments add`, in the tracker that owns its prefix).

When the preceding judged head (the newest first-parent ancestor with a main-role verdict) was a
FAIL with the same culprit, the head stayed red for a wave: the bead already has its comment, so
this prints `PROPOSE: git revert --no-edit <sha>  # forward revert; not run` instead. Nothing here
ever runs that command or changes a bead's status. A verdict that already carries a culprit is
reported as recorded and never commented twice.

Usage: verdict-culprit.py --repo DIR --commit SHA [--cache-dir DIR] [--br-bin BR]
                          [--tracker DIR] [--file-deadline S] [--dry-run]
--dry-run recomputes and prints the attribution but writes no record and adds no comment.
Seams: BR_BIN (br binary), OMP_KIT_CULPRIT_TRACKER (tracker for ompkit- beads, default
~/Developer/omp-kit), FULL_SUITE_VERDICT_CACHE_DIR (store, as for the runner).
Exit: 0 with one CULPRIT line, 1 internal error (still prints `CULPRIT none (...)`), 2 usage.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
from kitlib_io import atomic_replace_bytes  # noqa: E402
from kitlib_run import run  # noqa: E402
from kitlib_tmp import owned_tmp  # noqa: E402

MAX_COMMITS = 8
# The step runs while release-verdict holds its lock, so a wide FAIL (28 files on 72a5c54785) reruns only the
# first few failing files in path order: one break usually reddens many files, and the next head waits on us.
MAX_FILES = 6
FLAKE_REASON = "flake: passes on rerun at head"
TRACKED_PREFIX = "ompkit-"
GIT_DEADLINE_S = 120
BR_DEADLINE_S = 60
SCRUBBED_ENV = ("GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "BEADS_DB")


def load_store():
    spec = importlib.util.spec_from_file_location("full_suite_verdict_store", SCRIPTS / "full-suite-verdict-store.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("scripts/full-suite-verdict-store.py is unreadable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STORE = load_store()


def clean_env(**extra: str) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if key not in SCRUBBED_ENV}
    env.update(extra)
    return env


def git(repo: Path, *args: str, deadline_s: float = GIT_DEADLINE_S) -> str:
    result = run(["git", "-C", str(repo), *args], deadline_s=deadline_s, env=clean_env())
    if result.rc != 0 or result.timed_out:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"git {args[0]} failed: {detail}")
    return result.stdout.decode("utf-8", errors="strict").strip()


def note(message: str) -> None:
    print("verdict-culprit: " + message, file=sys.stderr, flush=True)


class Store:
    """Valid main-role records of the shared store, read once per tree."""

    def __init__(self, directory: Path, judge_root: Path) -> None:
        self.directory = directory
        self.judge_root = judge_root
        self.cache: dict[str, list[tuple[tuple[int, str], Path, dict]]] = {}

    def records(self, tree: str) -> list[tuple[tuple[int, str], Path, dict]]:
        """Valid main-role records for tree, newest first."""
        if tree not in self.cache:
            rows = []
            for path in self.directory.glob(f"{tree}.main.*.json"):
                entry, _reason = STORE.validate_record(path, judge_root=self.judge_root, tree=tree, role="main",
                                                       exact_filename=True, historical=True)
                if entry is None:
                    continue
                started = entry.get("timing", {}).get("started_ms")
                if not isinstance(started, int) or isinstance(started, bool):
                    started = 0
                rows.append(((started, path.name), path, entry))
            rows.sort(key=lambda row: row[0], reverse=True)
            self.cache[tree] = rows
        return self.cache[tree]


def failing_files(entry: dict) -> list[tuple[str, str]]:
    """(path, runner) of every measured suite file that failed in this run, sorted by path."""
    rows = entry["evidence"]["files"]
    return sorted({(row["path"], row["runner"]) for row in rows
                   if row.get("rc") != 0 and row.get("origin") != "focused"})


class Rerunner:
    """Reruns failing files at one commit, each commit in its own export under the run's tmp dir."""

    def __init__(self, repo: Path, work: str, deadline_s: float) -> None:
        self.repo = repo
        self.work = work
        self.deadline_s = deadline_s

    def failing(self, sha: str, files: list[tuple[str, str]], *, stop_at_first: bool) -> list[str]:
        tree = git(self.repo, "rev-parse", f"{sha}^{{tree}}")
        failed: list[str] = []
        with owned_tmp("culprit-" + sha[:12], root=self.work) as export:
            tarball = os.path.join(export, ".export.tar")
            git(self.repo, "archive", "--format=tar", "-o", tarball, sha, deadline_s=600)
            unpacked = run(["tar", "-xf", tarball, "-C", export], deadline_s=600)
            os.unlink(tarball)
            if unpacked.rc != 0 or unpacked.timed_out:
                raise RuntimeError(f"cannot export {sha}")
            for path, runner in files:
                if self.fails(Path(export), tree, path, runner):
                    failed.append(path)
                    if stop_at_first:
                        break
        note(f"{sha[:12]}: {'fails' if failed else 'passes'} ({', '.join(failed) or 'every rerun file green'})")
        return failed

    def fails(self, export: Path, tree: str, path: str, runner: str) -> bool:
        if not (export / path).is_file():
            # The file did not exist yet, so its failure was not there either.
            return False
        kit_tmp = export / "var" / "agent-tmp"
        kit_tmp.mkdir(parents=True, exist_ok=True)
        with owned_tmp("culprit-run", root=self.work) as scratch:
            env = clean_env(TMPDIR=scratch, KITLIB_TMP_ROOT=str(kit_tmp), OMP_KIT_DISK_OBSERVER="statfs",
                            OMP_KIT_CASE_CWD=str(self.repo))
            if runner == "bun":
                config = export / "bunfig.toml"
                if config.is_file():
                    env["BUN_CONFIG_FILE"] = str(config)
                command = ["bun", "--config=" + (str(config) if config.is_file() else "/dev/null"),
                           "test", "--timeout=120000", "./" + path]
            else:
                command = [runner, path]
            # The suite runs every file through the commit's own measured, hermetic launcher; so
            # does the rerun, when that commit has one.
            if (export / "scripts" / "suite-metrics.py").is_file() and (export / "scripts" / "suite-hermetic-env.sh").is_file():
                argv = ["python3", "-B", "scripts/suite-metrics.py", "run",
                        "--record", os.path.join(scratch, "row.json"), "--path", path, "--runner", runner,
                        "--tree", tree, "--cwd", str(export), "--deadline", str(self.deadline_s), "--", *command]
            else:
                argv = command
            result = run(argv, cwd=export, env=env, deadline_s=self.deadline_s + 30)
        return result.rc != 0 or result.timed_out


def commit_identity(repo: Path, sha: str) -> tuple[str, str | None]:
    author = git(repo, "log", "-1", "--format=%ae", sha) or "unknown"
    author = "".join("_" if char.isspace() else char for char in author)
    trailers = git(repo, "log", "-1", "--format=%(trailers:key=Bead,valueonly,separator=%x2C)", sha)
    bead = trailers.split(",", 1)[0].strip() if trailers else ""
    return author, bead if len(bead) <= 64 and STORE.BEAD_ID.fullmatch(bead) else None


def none(reason: str, files: list[str], method: str = "unattributed") -> dict:
    return {"sha": None, "author": None, "bead": None, "failing_files": files, "method": method, "reason": reason}


def culprit_line(culprit: dict) -> str:
    if culprit["method"] == "bisect":
        return f"CULPRIT {culprit['sha']} {culprit['author']} {culprit['bead'] or 'none'}"
    return f"CULPRIT none ({culprit['reason']})"


def attribute(repo: Path, chain: list[str], store: Store, files: list[tuple[str, str]], rerun: Rerunner) -> dict:
    """chain: first-parent commits newest first, the head first."""
    files = files[:MAX_FILES]
    paths = [path for path, _runner in files]
    if not files:
        return none("no failing test file recorded; the FAIL is a minimum-run shortfall", paths)
    head = chain[0]
    again = set(rerun.failing(head, files, stop_at_first=False))
    if not again:
        return none(FLAKE_REASON, paths, "flake-rerun")
    reproducing = [item for item in files if item[0] in again]
    good = None
    for index in range(1, len(chain)):
        tree = git(repo, "rev-parse", f"{chain[index]}^{{tree}}")
        if any(entry["verdict"] == "PASS" for _key, _path, entry in store.records(tree)):
            good = index
            break
    window = chain[:good] if good is not None else chain[:MAX_COMMITS]
    window.reverse()
    note(f"bisecting {len(window)} commit(s) since {'last main-role PASS ' + chain[good][:12] if good is not None else 'the window start (no main-role PASS found)'}")
    # window[-1] is the head and fails; find the oldest commit that fails.
    lo, hi = 0, len(window) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        bad = bool(rerun.failing(window[mid], reproducing, stop_at_first=True))
        hi, lo = (mid, lo) if bad else (hi, mid + 1)
    reproduced = [path for path, _runner in reproducing]
    if lo == 0 and good is None:
        return none(f"red before the {len(window)}-commit window; no main-role PASS within {MAX_COMMITS} "
                    "first-parent commits", reproduced)
    sha = window[lo]
    author, bead = commit_identity(repo, sha)
    return {"sha": sha, "author": author, "bead": bead, "failing_files": reproduced, "method": "bisect", "reason": ""}


def preceding_verdict(repo: Path, chain: list[str], store: Store) -> dict | None:
    for sha in chain[1:]:
        rows = store.records(git(repo, "rev-parse", f"{sha}^{{tree}}"))
        if rows:
            return rows[0][2]
    return None


def record_culprit(path: Path, entry: dict, culprit: dict) -> None:
    STORE.validate_culprit(culprit, entry["verdict"])
    digest = entry["evidence"]["log_sha256"]
    updated = dict(entry, culprit=culprit)
    data = (json.dumps(updated, indent=2, sort_keys=True) + "\n").encode("utf-8")

    def unchanged(_temp: str) -> None:
        current = json.loads(path.read_text(encoding="utf-8"))
        if current.get("evidence", {}).get("log_sha256") != digest or "culprit" in current:
            raise ValueError("the verdict record changed while it was attributed")

    atomic_replace_bytes(os.path.abspath(path), data, mode=path.stat().st_mode & 0o755,
                         durability="file", validate=unchanged)


def comment(br: str, tracker: Path, culprit: dict, head: str, record: Path) -> None:
    bead = culprit["bead"]
    if bead is None:
        note(f"no REWORK comment: {culprit['sha'][:12]} has no Bead: trailer")
        return
    if not bead.startswith(TRACKED_PREFIX):
        note(f"no REWORK comment: no tracker is configured for {bead}")
        return
    if not tracker.is_dir():
        note(f"no REWORK comment: tracker {tracker} is absent")
        return
    text = (f"REWORK: the main-role full suite is red at {head[:12]}, bisected to {culprit['sha'][:12]} "
            f"({culprit['author']}). Failing test file(s): {', '.join(culprit['failing_files'])}. "
            f"Verdict: {record}")
    result = run([br, "comments", "add", bead, text], cwd=tracker, env=clean_env(), deadline_s=BR_DEADLINE_S)
    if result.rc != 0 or result.timed_out:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        note(f"REWORK comment on {bead} failed (rc={result.rc}): {detail}")
    else:
        note(f"REWORK comment added to {bead}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--cache-dir")
    parser.add_argument("--br-bin", default=os.environ.get("BR_BIN") or "br")
    parser.add_argument("--tracker", default=os.environ.get("OMP_KIT_CULPRIT_TRACKER")
                        or str(Path.home() / "Developer" / "omp-kit"))
    parser.add_argument("--file-deadline", type=float, default=900)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        repo = STORE.repository_root(args.repo)
        head = git(repo, "rev-parse", "--verify", f"{args.commit}^{{commit}}")
        head_tree = git(repo, "rev-parse", f"{head}^{{tree}}")
        store = Store(STORE.cache_directory(repo, args.cache_dir), SCRIPTS.parent)
        rows = store.records(head_tree)
        if not rows or rows[0][2]["verdict"] != "FAIL":
            print(f"CULPRIT none (no FAIL verdict recorded for tree {head_tree})")
            return 0
        _key, record, entry = rows[0]
        if not args.dry_run and "culprit" in entry:
            print(culprit_line(entry["culprit"]))
            note(f"already recorded in {record}")
            return 0
        chain = git(repo, "rev-list", "--first-parent", f"--max-count={MAX_COMMITS + 1}", head).split()
        with owned_tmp("verdict-culprit") as work:
            culprit = attribute(repo, chain, store, failing_files(entry), Rerunner(repo, work, args.file_deadline))
        previous = preceding_verdict(repo, chain, store)
        repeated = (culprit["method"] == "bisect" and previous is not None and previous["verdict"] == "FAIL"
                    and isinstance(previous.get("culprit"), dict) and previous["culprit"].get("sha") == culprit["sha"])
        if not args.dry_run:
            record_culprit(record, entry, culprit)
        print(culprit_line(culprit))
        if repeated:
            print(f"PROPOSE: git revert --no-edit {culprit['sha']}  # forward revert; not run")
        elif culprit["method"] == "bisect" and not args.dry_run:
            comment(args.br_bin, Path(args.tracker), culprit, head, record)
        return 0
    except Exception as error:  # noqa: BLE001 - the one line must still say why nothing was attributed
        reason = " ".join(str(error).split()) or type(error).__name__
        print(f"CULPRIT none (culprit step error: {reason})")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
