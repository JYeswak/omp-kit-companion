#!/bin/sh
# candidate-failure.sh — fp72.49: a candidate that fails after its own SHA
# certified green opens a P0 issue with the evidence, never a rerun.
#
# Post-cert means the tag names the candidate SHA (stage 2 created it only
# after that SHA's push run certified it). Anything else — rehearsals,
# tag mismatches, runs with no failed jobs — creates no issue.
#
# Usage: sh scripts/candidate-failure.sh --repo OWNER/REPO --version X.Y.Z --sha SHA --run-id ID
#   GH_TOKEN must allow `gh api` and `gh issue create`. Exit 0 on any decided
#   outcome (issue opened, or skipped with a reason); exit 2 on failure.
set -eu

REPO=""
VERSION=""
SHA=""
RUN_ID=""
while [ "$#" -gt 0 ]; do
	case "$1" in
		--repo) REPO="$2"; shift 2 ;;
		--version) VERSION="$2"; shift 2 ;;
		--sha) SHA="$2"; shift 2 ;;
		--run-id) RUN_ID="$2"; shift 2 ;;
		*) echo "usage: candidate-failure.sh --repo OWNER/REPO --version X.Y.Z --sha SHA --run-id ID" >&2; exit 2 ;;
	esac
done
case "$REPO" in */*) ;; *) echo "repo must be OWNER/REPO" >&2; exit 2 ;; esac
if ! printf '%s' "$VERSION" | grep -qE '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then echo "version must be X.Y.Z" >&2; exit 2; fi
if ! printf '%s' "$SHA" | grep -qE '^[0-9a-f]{40}$'; then echo "sha must be a 40-hex commit" >&2; exit 2; fi
case "$RUN_ID" in ''|*[!0-9]*) echo "run-id must be numeric" >&2; exit 2 ;; esac

# Only a tag that names this SHA proves stage 2 certified it green.
tagged="$(git rev-parse "v$VERSION^{commit}" 2>/dev/null || true)"
if [ "$tagged" != "$SHA" ]; then echo "no issue: v$VERSION does not name $SHA (not a post-cert run)"; exit 0; fi

jobs="$(gh api "repos/$REPO/actions/runs/$RUN_ID/jobs" --paginate --jq '.jobs[] | select(.conclusion != "success") | "\(.name)\t\(.conclusion)"')" || exit 2
if [ -z "$jobs" ]; then echo "no issue: no failed jobs in run $RUN_ID"; exit 0; fi

diffstat="$(git diff --stat "$SHA^" "$SHA" 2>/dev/null || echo "diff unavailable")"
# shellcheck source=scripts/kitlib-tmp.sh
. "$(dirname -- "$0")/kitlib-tmp.sh"
work='' # assigned by kitlib_tmp via eval
kitlib_tmp work candidate-failure || exit 2
body="$work/body"
{
	printf 'Candidate for v%s (bump %s) FAILED after stage 2 certified that SHA green.\n' "$VERSION" "$SHA"
	printf 'Do not rerun: diagnose, fix forward, mirror to a P0 bead with this evidence.\n\n'
	printf 'Run: https://github.com/%s/actions/runs/%s\n' "$REPO" "$RUN_ID"
	printf 'Tag: v%s names %s (verified)\n\n' "$VERSION" "$SHA"
	printf 'Failing jobs (name, conclusion):\n%s\n\n' "$jobs"
	printf 'Bump diff vs parent:\n%s\n' "$diffstat"
} > "$body"
gh issue create --repo "$REPO" --title "[P0] candidate failed after green-certified bump v$VERSION ($SHA)" --body-file "$body" || exit 2
echo "opened P0 issue for v$VERSION ($SHA)"
