#!/bin/sh
# SOURCEGATE1: judge index blobs only, and only in opted-in repositories.
set -u
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
root=$(git rev-parse --show-toplevel) || exit 1
[ -f "$root/.omp/sources.toml" ] || exit 0
out=$(python3 -B "$here/sources.py" staged --repo "$root" 2>&1)
rc=$?
[ "$rc" = 0 ] && exit 0
printf 'staged-sources: REFUSED\n%s\nFix: python3 scripts/sources.py add --url URL --quote QUOTE --claim CLAIM --id ID; remove memory citations and stage the registry and corrected document.\n' "$out" >&2
exit 1
