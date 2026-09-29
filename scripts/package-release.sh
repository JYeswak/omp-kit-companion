#!/bin/sh
# Build one immutable platform candidate locally; CI certifies native behavior separately.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
command -v bun >/dev/null 2>&1 || { echo 'package-release: Bun build tool is required' >&2; exit 3; }
exec bun run --no-env-file --config=/dev/null "$ROOT/scripts/package-release.ts" "$@"
