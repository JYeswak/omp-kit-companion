#!/usr/bin/env python3
"""kit-commit: serialize `git commit` per checkout for shared-checkout fleets.

Wraps one `git commit` invocation for agents committing in the same checkout
(ompkit-fp72.19.1.9 GITLOCK1, decision J-2026-10-18-48):

  1. Takes an exclusive flock on <gitdir>/omp-kit-commit.lock (blocking up to
     --flock-timeout, default 120 s) so concurrent wave agents queue for
     seconds instead of colliding on index.lock. The lock releases on process
     death, including SIGKILL.
  2. Runs `git commit "$@"`; on a transient lock collision (git's lock-error
     text on stderr), retries with backoff up to --retries (default 5) for
     writers that do not use this wrapper.
  3. On termination (not SIGKILL), kills a still-running git child and asks
     the kit to reap a leftover index.lock
     (`omp-kit scratch index-lock --reap --yes --min-age-ms 0`, skipped when
     omp-kit is absent): the child is known dead and the reaper's empty, lsof
     and git-cwd gates still apply. SIGKILL leaves cleanup to the fleet-watch
     reaper (120 s) and the next wrapper run never touches a live holder.

Non-interactive only: stdin is DEVNULL, so `git commit` without -m fails
instead of opening an editor. Fleet callers always pass `-m`.

Usage: kit-commit.py [--flock-timeout S] [--retries N] [--] [commit] <git commit args...>
Exit: git commit's exit code; 75 when the flock times out; 2 on usage errors.
"""

import fcntl
import os
import re
import shutil
import signal
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from pysafe import run_bounded  # noqa: E402

LOCK_ERR = re.compile(
    r"Unable to create '[^'\n]*index\.lock'"
    r"|index\.lock': File exists"
    r"|another git process seems to be running"
)
FLOCK_TIMEOUT_S = 120
RETRIES = 5
BACKOFF_S = (1, 2, 4, 8, 16)


def parse(argv):
    flock_timeout, retries, rest = FLOCK_TIMEOUT_S, RETRIES, []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--":
            rest.extend(argv[i + 1:])
            break
        if arg == "--flock-timeout" and i + 1 < len(argv):
            flock_timeout = int(argv[i + 1])
            i += 2
            continue
        if arg == "--retries" and i + 1 < len(argv):
            retries = int(argv[i + 1])
            i += 2
            continue
        if arg.startswith("--flock-timeout="):
            flock_timeout = int(arg.split("=", 1)[1])
            i += 1
            continue
        if arg.startswith("--retries="):
            retries = int(arg.split("=", 1)[1])
            i += 1
            continue
        rest.append(arg)
        i += 1
    if flock_timeout < 0 or retries < 0:
        raise ValueError("--flock-timeout and --retries must be non-negative")
    if rest[:1] == ["commit"]:
        rest = rest[1:]
    return flock_timeout, retries, rest


def reap_leftover(repo):
    omp_kit = shutil.which("omp-kit")
    if omp_kit is None:
        return
    lock = os.path.join(repo, ".git", "index.lock")
    if not os.path.exists(lock):
        return
    try:
        run_bounded([omp_kit, "scratch", "index-lock", "--repo", repo,
                     "--reap", "--yes", "--min-age-ms", "0", "--json"],
                    timeout=60, cwd=repo)
    except OSError:
        pass

def wait_for_group_exit(pgid, timeout):
    deadline = time.monotonic() + timeout
    while True:
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return True
        except (PermissionError, OSError):
            return False
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)


def stop_child_group(child):
    pgid = child.pid
    try:
        os.killpg(pgid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        pass
    try:
        child.wait(timeout=1)
    except subprocess.TimeoutExpired:
        pass
    if wait_for_group_exit(pgid, 1):
        return
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        pass
    try:
        child.wait(timeout=1)
    except subprocess.TimeoutExpired:
        pass
    wait_for_group_exit(pgid, 1)

def main(argv):
    try:
        flock_timeout, retries, rest = parse(argv)
    except (ValueError, IndexError) as error:
        print("kit-commit: %s" % error, file=sys.stderr)
        return 2
    try:
        top = run_bounded(["git", "rev-parse", "--show-toplevel"], timeout=30)
    except OSError:
        top = None
    if top is None or not top.ok:
        # Not a git checkout: nothing to serialize; plain passthrough.
        # git commit outside a repo fails fast, so a bound is harmless.
        try:
            result = run_bounded(["git", "commit", *rest], timeout=300)
        except OSError as error:
            print("kit-commit: cannot run git: %s" % error, file=sys.stderr)
            return 1
        sys.stdout.write(result.text("stdout"))
        sys.stderr.write(result.text("stderr"))
        return result.returncode if result.returncode is not None else 1
    repo = top.text("stdout").strip()
    try:
        gitdir_proc = run_bounded(["git", "rev-parse", "--absolute-git-dir"], timeout=30, cwd=repo)
    except OSError:
        gitdir_proc = None
    gitdir = gitdir_proc.text("stdout").strip() if gitdir_proc is not None and gitdir_proc.ok else os.path.join(repo, ".git")
    flock_path = os.path.join(gitdir, "omp-kit-commit.lock")
    try:
        flock_fd = os.open(flock_path, os.O_CREAT | os.O_WRONLY, 0o644)
    except OSError as error:
        print("kit-commit: cannot open %s: %s" % (flock_path, error), file=sys.stderr)
        return 1
    with os.fdopen(flock_fd, "w"):
        deadline = time.time() + flock_timeout
        while True:
            try:
                fcntl.flock(flock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.time() >= deadline:
                    print("kit-commit: flock on %s timed out after %d s" % (flock_path, flock_timeout),
                          file=sys.stderr)
                    return 75
                time.sleep(0.1)
        child = None

        def on_signal(signum, _frame):
            if child is not None and child.poll() is None:
                stop_child_group(child)
            reap_leftover(repo)
            sys.exit(128 + signum)

        previous = {sig: signal.signal(sig, on_signal) for sig in (signal.SIGTERM, signal.SIGINT)}
        try:
            attempt = 0
            while True:
                child = subprocess.Popen(["git", "commit", *rest], cwd=repo,
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         stdin=subprocess.DEVNULL, start_new_session=True)
                stdout, stderr = child.communicate()  # pysafe(subprocess-no-timeout): the wrapped commit inherits the caller's deadline, so a wrapper-side bound would kill long hook chains early and orphan their children; the wait here is unbounded and the caller (bash tool deadline or timeout wrapper) bounds it instead.
                rc = child.returncode
                err_text = stderr.decode(errors="replace")
                if rc == 0:
                    sys.stdout.write(stdout.decode(errors="replace"))
                    sys.stderr.write(err_text)
                    return 0
                if attempt < retries and LOCK_ERR.search(err_text):
                    # Transient collision: back off silently; only the final
                    # attempt's output reaches the caller, so retried lock
                    # text never leaks into tool results that rate scanners read.
                    time.sleep(BACKOFF_S[min(attempt, len(BACKOFF_S) - 1)])
                    attempt += 1
                    continue
                sys.stdout.write(stdout.decode(errors="replace"))
                sys.stderr.write(err_text)
                if rc < 0:
                    # Killed by a signal git did not survive: clean our own lock.
                    reap_leftover(repo)
                return rc if rc > 0 else 128 - rc
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
            try:
                fcntl.flock(flock_fd, fcntl.LOCK_UN)
            except OSError:
                pass


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
