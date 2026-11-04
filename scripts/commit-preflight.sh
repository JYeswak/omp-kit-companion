#!/bin/sh
# Run source staged-file checks and INSTALLED staged pre-commit members,
# never fresh-gate or tests. Both --files (working bytes on HEAD) and default
# (caller's staged bytes) use an isolated index and object store.
# Usage: sh scripts/commit-preflight.sh [--message FILE] [--files PATH...]
# Opt-in exception: [--tests FILE...] runs those files in the verdict's export
# layout (stamped HEAD archive plus the overlay, fresh `git init -q`, long
# TMPDIR, the gate's suite-metrics runner under heavy); a failure is
# REFUSED EXPORT_TEST_FAILED FILE.
# Without --message, Deploy-Step previews the obligation; stale-worktree,
# reversal authority and commit-notes are explicitly NOT_JUDGED.
# Exits 0 when executed checks pass (not commit admission), 1 findings or broken
# installed gates, 2 setup failure. No installed kit is UNKNOWN, not PASS, and
# leaves the exit code unchanged. Supply the real message for note coverage.
# Notes use both the native release floor and HEAD delta: an existing fragment
# is not coverage for a follow-on commit that contributes no new note.
# This is author feedback, not publication proof: reservation, bead/message
# policy, release checks and fresh-gate remain the real commit/push guards.
# ShellCheck follows the full effective-index helper closure and staged config,
# using fresh-gate's koalaman/shellcheck:v0.9.0, default severity, -x -P /archive.
# Docker and its cached image are required; unavailable is UNJUDGED, never a
# local-version green fallback or an image download during cheap feedback.
# An omp-kit preflight verb should wrap this entrypoint, not fork it.
set -eu
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
PYTHONDONTWRITEBYTECODE=1 exec "$here/commit-preflight.py" "$@"
