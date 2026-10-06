#!/bin/sh
# check-pushed-beads.sh — COMMIT1 pre-push bead check (ompkit-2w7h).
# Usage: check-pushed-beads.sh --repo DIR --base SHA --tip SHA [--db PATH] [--br BIN]
# Every non-merge commit in base..tip must name a bead id that exists in the
# repo tracker, checked through scripts/commit-msg-bead.sh on the commit
# message. Reads git objects only (git log), so commit-tree commits are
# checked like any other; the working tree is never touched. Refuses (exit 4)
# naming the first offending sha. Test seams: --db overrides the tracker,
# --br overrides the br binary (both forwarded).
set -u

REPO=""
BASE=""
TIP=""
DB=""
BRBIN=""
PREPUSH=0
while [ $# -gt 0 ]; do
	case "$1" in
		--repo) REPO=${2:-}; shift 2 ;;
		--base) BASE=${2:-}; shift 2 ;;
		--tip) TIP=${2:-}; shift 2 ;;
		--db) DB=${2:-}; shift 2 ;;
		--br) BRBIN=${2:-}; shift 2 ;;
		--pre-push) PREPUSH=1; shift ;;
		--) shift; break ;;
		*) printf 'check-pushed-beads: unknown argument %s\n' "$1" >&2; exit 2 ;;
	esac
done
if [ "$PREPUSH" = "1" ]; then
	if [ -z "$REPO" ]; then
		REPO=$(git rev-parse --show-toplevel 2>/dev/null) || { printf 'check-pushed-beads: --pre-push needs --repo DIR or a checkout cwd\n' >&2; exit 2; }
	fi
	rc=0
	while IFS= read -r line; do
		# pre-push hook lines: <local ref> <local sha> <remote ref> <remote sha>
		# four whitespace-separated fields by protocol
		# shellcheck disable=SC2086
		set -- $line
		if [ $# -ne 4 ]; then
			continue
		fi
		case "$2:$4" in
			0000000000000000000000000000000000000000:*|*:0000000000000000000000000000000000000000)
				printf 'check-pushed-beads: skipping unscopable push line\n' >&2
				continue
				;;
		esac
		sh "$0" --repo "$REPO" --base "$4" --tip "$2" ${DB:+--db "$DB"} ${BRBIN:+--br "$BRBIN"} || rc=$?
	done
	exit "$rc"
fi
if [ -z "$REPO" ] || [ -z "$BASE" ] || [ -z "$TIP" ]; then
	printf 'check-pushed-beads: needs --repo DIR --base SHA --tip SHA\n' >&2
	exit 2
fi
HOOKDIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
HOOK="$HOOKDIR/commit-msg-bead.sh"
[ -f "$HOOK" ] || { printf 'check-pushed-beads: hook body missing at %s\n' "$HOOK" >&2; exit 2; }
COMMITS=$(git -C "$REPO" rev-list --no-merges "$BASE..$TIP" 2>/dev/null) || { printf 'check-pushed-beads: cannot list %s..%s\n' "$BASE" "$TIP" >&2; exit 2; }
TMPMSG=$(mktemp "${TMPDIR:-/tmp}/pushed-beads-msg.XXXXXX") || exit 2
trap 'rm -f "$TMPMSG"' EXIT INT TERM
export BEADS_DB="$DB"
export BR_BIN="$BRBIN"
checked=0
# hook path is ours, set above; empty BEADS_DB/BR_BIN behave as unset inside the hook
# shellcheck disable=SC2086
for sha in $COMMITS; do
	checked=$((checked + 1))
	git -C "$REPO" log --format=%B -n 1 "$sha" > "$TMPMSG" 2>/dev/null || { printf 'check-pushed-beads: cannot read %s\n' "$sha" >&2; exit 2; }
	BEADS_DB="$DB" BR_BIN="$BRBIN" sh "$HOOK" "$TMPMSG" >/dev/null 2>&1 || { printf 'check-pushed-beads: refusing %s: no existing bead id in message\n' "$sha" >&2; exit 4; }
done
if [ "$checked" = "0" ]; then
	printf 'check-pushed-beads: no commits in %s..%s; nothing to check\n' "$BASE" "$TIP" >&2
fi
exit 0
