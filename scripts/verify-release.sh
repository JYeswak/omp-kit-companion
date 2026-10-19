#!/bin/sh
# Verify a release signature or SBOM on a machine that did not build it.
# Usage: verify-release.sh (--pubkey PUB --file FILE --sig SIG | --sbom SBOM --archive ARCHIVE)
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
command -v bun >/dev/null 2>&1 || { echo 'verify-release: Bun build tool is required' >&2; exit 3; }
exec bun run --no-env-file --config=/dev/null "$ROOT/scripts/verify-release.ts" "$@"
