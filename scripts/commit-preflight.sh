#!/bin/sh
# Run all staged-file checks, never fresh-gate or tests. --files uses working
# bytes on HEAD in a private index; default uses the caller's staged bytes.
# Usage: sh scripts/commit-preflight.sh [--message FILE] [--files PATH...]
# Without --message, Deploy-Step is checked against an empty planned message.
# Exits 0 only when every check passed; 1 findings, 2 setup/unjudged.
# This is author feedback, not publication proof: reservation, bead/message
# policy, release checks and fresh-gate remain the real commit/push guards.
# ShellCheck uses the installed local binary; CI's pinned version still judges
# publication. An omp-kit preflight verb should wrap this entrypoint, not fork it.
set -eu
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
PYTHONDONTWRITEBYTECODE=1 exec "$here/commit-preflight.py" "$@"
