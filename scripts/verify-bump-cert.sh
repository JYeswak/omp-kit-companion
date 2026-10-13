#!/bin/sh
# verify-bump-cert.sh — fp72.65: prove the called CI run certified THIS bump.
#
# The train calls ci.yml with source_sha=<bump> and version=<release>. Stage 2
# tags only when every native-receipt in the run records that same SHA (and
# version where the receipt carries one). Anything else: refuse, naming it.
#
# Usage: sh scripts/verify-bump-cert.sh --version X.Y.Z --sha SHA --receipts DIR
#   DIR holds one receipt.json per downloaded native-receipt artifact (nested
#   one level: <platform-track>/receipt.json, as actions/download-artifact
#   lays it out with pattern + merge-multiple). Exit 0 on verified proof;
#   exit 4 on mismatch or an empty receipt set; exit 2 on bad usage.
set -eu

VERSION=""
SHA=""
DIR=""
while [ "$#" -gt 0 ]; do
	case "$1" in
		--version) VERSION="$2"; shift 2 ;;
		--sha) SHA="$2"; shift 2 ;;
		--receipts) DIR="$2"; shift 2 ;;
		*) echo "usage: verify-bump-cert.sh --version X.Y.Z --sha SHA --receipts DIR" >&2; exit 2 ;;
	esac
done
if ! printf '%s' "$VERSION" | grep -qE '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then echo "version must be X.Y.Z" >&2; exit 2; fi
if ! printf '%s' "$SHA" | grep -qE '^[0-9a-f]{40}$'; then echo "sha must be a 40-hex commit" >&2; exit 2; fi
if [ -z "$DIR" ] || [ ! -d "$DIR" ]; then echo "receipts dir is missing: $DIR" >&2; exit 2; fi
command -v jq >/dev/null 2>&1 || { echo "verify-bump-cert: jq is required" >&2; exit 3; }

count=0
for receipt in "$DIR"/*/receipt.json "$DIR"/receipt.json; do
	[ -f "$receipt" ] || continue
	count=$((count + 1))
	ok="$(jq -e --arg v "$VERSION" --arg sha "$SHA" '
		(.source_sha == $sha) and ((.version // $v) == $v)
	' "$receipt" 2>/dev/null)" || ok=""
	if [ "$ok" != "true" ]; then echo "verify-bump-cert: $receipt does not record bump $SHA v$VERSION" >&2; exit 4; fi
done
if [ "$count" -eq 0 ]; then echo "verify-bump-cert: no native receipts in $DIR" >&2; exit 4; fi
printf 'CERT=verified version=%s sha=%s receipts=%s\n' "$VERSION" "$SHA" "$count"; exit 0
