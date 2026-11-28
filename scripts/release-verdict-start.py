#!/usr/bin/env python3
"""scripts/release-verdict-start.py: AUTOCUTVERDICT1 (ompkit-hbt6q), the detached release qualification child.

Usage: release-verdict-start.py ROOT SHA

RELFAST1 (ompkit-fp72.120.16.309): qualify a batch of main lands after its quiet interval, never per commit. Each
published main commit schedules one finite detached child; a newer origin/main supersedes it. The child owns a session
because the transport that started it (a push whose bounded runner kills its process group when the push returns)
must not take it down. Every subprocess below uses kitlib_run with a deadline.

FULLONRELEASE1 (J-2026-11-10-03): default-on after 600 quiet seconds; OMP_KIT_RELEASE_VERDICT_QUIET_S sets 0..86400.

Callers: omp-kit land, whose exact-parent publication pushes from a private checkout that has no hook chain, and the pre-push
chain member when the repository has this file. The kit release ships it because the canonical working tree can lag behind
main and lack it (land then runs the release copy). The caller redirects stdout and stderr to <git-dir>/omp-kit/release-verdict.log.
"""
import os
import sys
import time

QUIET_S = 600  # J-2026-11-10-03: one suite per settled batch, not one per commit.


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        raise SystemExit("usage: release-verdict-start.py ROOT SHA")
    root, sha = argv[1:]
    quiet = int(os.environ.get("OMP_KIT_RELEASE_VERDICT_QUIET_S", str(QUIET_S)))
    if not 0 <= quiet <= 86400:
        raise SystemExit("release-verdict: quiet interval must be 0..86400 seconds")
    if os.fork():
        os._exit(0)
    os.setsid()
    priority = os.getpriority(os.PRIO_PROCESS, 0)
    if priority < 10:
        os.nice(10 - priority)
    # kitlib_run comes from the repository's scripts when it has them, else from the directory this file sits in (a kit release).
    for base in (os.path.join(root, "scripts"), os.path.dirname(os.path.abspath(__file__))):
        if os.path.exists(os.path.join(base, "kitlib_run.py")):
            sys.path.insert(0, base)
            break
    from kitlib_run import run

    print(f"release-verdict: quiet interval {quiet}s for {sha}", flush=True)
    time.sleep(quiet)
    fetch = run(["git", "-C", root, "fetch", "-q", "origin", "refs/heads/main:refs/remotes/origin/main"], deadline_s=120)
    head = run(["git", "-C", root, "rev-parse", "--verify", "refs/remotes/origin/main"], deadline_s=15)
    if fetch.rc != 0 or fetch.timed_out or head.rc != 0 or head.timed_out:
        sys.stderr.buffer.write(fetch.stderr + head.stderr)
        raise SystemExit("release-verdict: cannot fetch published main; qualification not started")
    newer = head.stdout.decode().strip()
    if newer != sha:
        print(f"release-verdict: {sha} superseded by {newer}", flush=True)
        return 0
    # Use the LOAD1 owner/lease path for this job and its local runner descendants.
    result = run(["omp-kit", "heavy", "--label", "release-verdict", "--max-runtime", "7200", "--",
                  "sh", os.path.join(root, "scripts/release-verdict.sh"), "--commit", sha, "--no-fetch"],
                 cwd=root, deadline_s=7200, max_output_bytes=16 << 20)
    sys.stdout.buffer.write(result.stdout)
    sys.stderr.buffer.write(result.stderr)
    if result.timed_out or result.rc != 0:
        print(f"release-verdict: qualification did not complete for {sha} rc={result.rc} timed_out={result.timed_out}", flush=True)
        return result.rc if result.rc is not None and result.rc > 0 else 1
    ready = run(["bun", os.path.join(root, "src/release-ready.ts"), "--repo", root], cwd=root, deadline_s=120)
    sys.stdout.buffer.write(ready.stdout)
    sys.stderr.buffer.write(ready.stderr)
    print(f"release-verdict: qualification finished for {sha} rc={result.rc}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
