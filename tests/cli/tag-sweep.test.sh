#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
work=$(mktemp -d "${TMPDIR:-/tmp}/tag-sweep.XXXXXX")
trap 'rm -rf "$work"' EXIT
printf '%s\n' v0.2.45 v0.2.47 v0.2.48 > "$work/tags"
printf '%s\n' '[{"tag_name":"v0.2.48"}]' > "$work/releases"
if sh "$ROOT/scripts/tag-sweep.sh" --repo example/kit --tags-file "$work/tags" --releases-file "$work/releases" --receipt "$work/missing.json"; then
  echo 'expected missing release to fail closed' >&2; exit 1
fi
jq -e '.status == "detected" and .missing_count == 2 and (.missing | sort == ["v0.2.45","v0.2.47"])' "$work/missing.json" >/dev/null
printf '%s\n' '[{"tag_name":"v0.2.45"},{"tag_name":"v0.2.47"},{"tag_name":"v0.2.48"}]' > "$work/releases-all"
sh "$ROOT/scripts/tag-sweep.sh" --repo example/kit --tags-file "$work/tags" --releases-file "$work/releases-all" --receipt "$work/quiet.json" >/dev/null
jq -e '.status == "quiet" and .missing_count == 0' "$work/quiet.json" >/dev/null
printf '%s\n' 'ok tag sweep detects an unpublished tag and stays quiet when all releases exist'
