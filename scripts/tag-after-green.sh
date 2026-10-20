#!/bin/sh
# tag-after-green.sh — fp72.49 stage 2: tag exactly the certified bump SHA.
#
# The stage-1 train pushes the bump commit to main UNTAGGED with a
# refs/train/pending-vX.Y.Z ref recording the bump SHA. When that SHA's own
# push run completes, this script matches the run head SHA to the recorded
# bump SHA and tags it only when native-certification is green for every
# shipped platform/track. Anything else: no tag, reason on stdout.
#
# Usage: sh scripts/tag-after-green.sh --repo OWNER/REPO --run-id ID --head-sha SHA
#   GH_TOKEN must allow `gh api` and `git push`. Exit 0 on any decided outcome
#   (tagged, or skipped with a reason); exit 2 on operational failure.
set -eu

REPO=""
RUN_ID=""
HEAD_SHA=""
while [ "$#" -gt 0 ]; do
	case "$1" in
		--repo) REPO="$2"; shift 2 ;;
		--run-id) RUN_ID="$2"; shift 2 ;;
		--head-sha) HEAD_SHA="$2"; shift 2 ;;
		*) echo "usage: tag-after-green.sh --repo OWNER/REPO --run-id ID --head-sha SHA" >&2; exit 2 ;;
	esac
done
case "$REPO" in */*) ;; *) echo "repo must be OWNER/REPO" >&2; exit 2 ;; esac
case "$RUN_ID" in ''|*[!0-9]*) echo "run-id must be numeric" >&2; exit 2 ;; esac
if ! printf '%s' "$HEAD_SHA" | grep -qE '^[0-9a-f]{40}$'; then echo "head-sha must be a 40-hex commit" >&2; exit 2; fi

# Ship targets the release certifies (ci.yml release matrix minus the Intel probe).
SHIP_PLATFORMS="darwin-arm64-none linux-arm64-gnu linux-x64-gnu"

refs="$(git ls-remote origin 'refs/train/pending-v*')" || exit 2
version="$(printf '%s\n' "$refs" | awk -v sha="$HEAD_SHA" '$1 == sha { print $2 }' | sed -n 's#^refs/train/pending-v##p' | head -n 1)"
if [ -z "$version" ]; then echo "no tag: head_sha $HEAD_SHA is not a recorded train bump"; exit 0; fi
if ! printf '%s' "$version" | grep -qE '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then echo "no tag: recorded version is malformed: $version" >&2; exit 2; fi
if git ls-remote --tags origin "refs/tags/v$version" | grep -q .; then echo "no tag: v$version is already tagged"; exit 0; fi

jobs="$(gh api "repos/$REPO/actions/runs/$RUN_ID/jobs" --paginate --jq '.jobs[] | "\(.name)\t\(.conclusion)"')" || exit 2
for platform in $SHIP_PLATFORMS; do
	legs="$(printf '%s\n' "$jobs" | grep -F "native-certification ($platform," || true)"
	if [ -z "$legs" ]; then echo "no tag: no native-certification legs for $platform in run $RUN_ID"; exit 0; fi
	bad="$(printf '%s\n' "$legs" | awk -F '\t' '$2 != "success"')"
	if [ -n "$bad" ]; then echo "no tag: native-certification not green for $platform in run $RUN_ID:"; printf '%s\n' "$bad"; exit 0; fi
done

# Tag the exact certified SHA and retire its pending ref together or not at all.
git push --atomic origin "$HEAD_SHA:refs/tags/v$version" ":refs/train/pending-v$version" || exit 2
gh workflow run release.yml --repo "$REPO" --ref main -f version="$version" -f sha="$HEAD_SHA" || exit 2
echo "tagged v$version on $HEAD_SHA; candidate dispatched"
