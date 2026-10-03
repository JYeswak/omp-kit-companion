#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd -P)
command -v bun >/dev/null 2>&1 || { echo 'release-notes: Bun is required' >&2; exit 3; }
exec bun run --no-env-file --config=/dev/null "$SCRIPT_DIR/release-notes.ts" "$@"
