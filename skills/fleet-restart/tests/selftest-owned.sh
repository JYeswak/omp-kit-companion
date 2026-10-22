#!/bin/sh
# Run the fleet-restart selftest from a checkout or git archive with an owned
# repo-local TMPDIR. The selftest deliberately refuses an unmarked scratch root;
# this wrapper creates exactly one owned root and removes it on every exit path.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd -P)
ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/../../.." && pwd -P)
WORK_PARENT="$ROOT/var/agent-tmp"
mkdir -p "$WORK_PARENT"
WORK=$(mktemp -d "$WORK_PARENT/fleet-restart-selftest.$$.XXXXXX")
cleanup() {
    rm -rf "$WORK"
}
trap cleanup EXIT HUP INT TERM

start=$(ps -p $$ -o lstart= 2>/dev/null | sed 's/^ *//;s/ *$//' || true)
printf 'pid=%s\nprocess_start=%s\nlabel=fleet-restart-selftest\nrepo=%s\ncreated=%s\n' \
    "$$" "$start" "$ROOT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$WORK/.owner"

cd "$ROOT"
TMPDIR="$WORK" PYTHONDONTWRITEBYTECODE=1 python3 "$ROOT/skills/fleet-restart/scripts/selftest.py"
