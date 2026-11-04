#!/bin/sh
# check-pushed-beads.sh — COMMIT1 pre-push bead check (ompkit-2w7h).
# Usage: check-pushed-beads.sh --repo DIR --base SHA --tip SHA [--db PATH] [--br BIN]
# Every non-merge commit reachable from tip but not from any origin remote-tracking
# ref must name a bead id that exists in the repo tracker. The base is diagnostic:
# squash merges can leave already-landed origin/main commits in the pushed range.
# Messages are checked through scripts/commit-msg-bead.sh. The checker reads git
# objects only, so commit-tree commits are covered without touching the worktree.
# It refuses (exit 4), naming the first offending sha. Test seams: --db overrides
# the tracker, --br overrides the br binary (both forwarded).
# PUSHADMIT1 (ompkit-fp72.120.16.221): in --pre-push mode each line also passes
# --remote-ref. When the repo holds a reviewed plan copy
# (<git-common-dir>/omp-kit/history-review/*.plan.json, written by
# ref-txn-witness.py review), ref-txn-witness.py push-admit decides: exit 3
# keeps the ordinary range, exit 0 admits the reviewed rewrite and returns the
# range minus its mapped counterparts (still judged here), anything else
# refuses. With no plan copy no witness runs and the check is unchanged.
set -u

REPO=""
BASE=""
TIP=""
DB=""
BRBIN=""
PREPUSH=0
RREF=""
while [ $# -gt 0 ]; do
	case "$1" in
		--repo) REPO=${2:-}; shift 2 ;;
		--base) BASE=${2:-}; shift 2 ;;
		--tip) TIP=${2:-}; shift 2 ;;
		--db) DB=${2:-}; shift 2 ;;
		--br) BRBIN=${2:-}; shift 2 ;;
		--remote-ref) RREF=${2:-}; shift 2 ;;
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
		sh "$0" --repo "$REPO" --base "$4" --tip "$2" --remote-ref "$3" ${DB:+--db "$DB"} ${BRBIN:+--br "$BRBIN"} || rc=$?
	done
	exit "$rc"
fi
if [ -z "$REPO" ] || [ -z "$BASE" ] || [ -z "$TIP" ]; then
	printf 'check-pushed-beads: needs --repo DIR --base SHA --tip SHA\n' >&2
	exit 2
fi
# The tracker is the pushed repo's own unless --db names one. Left empty, the
# message hook resolves it from the caller's cwd, and from outside the repo it
# finds none and passes every commit (a false-clean fleet check, 2026-10-16).
[ -n "$DB" ] || DB="$REPO/.beads/beads.db"
HOOKDIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
HOOK="$HOOKDIR/commit-msg-bead.sh"
[ -f "$HOOK" ] || { printf 'check-pushed-beads: hook body missing at %s\n' "$HOOK" >&2; exit 2; }
[ -f "$HOOKDIR/kitlib-tmp.sh" ] || { printf 'check-pushed-beads: kitlib-tmp.sh missing at %s\n' "$HOOKDIR" >&2; exit 2; }
# shellcheck source=scripts/kitlib-tmp.sh
. "$HOOKDIR/kitlib-tmp.sh"
reviewed_witness() {
	# prints the witness reader's directory when a reviewed plan copy exists; else fails fast with no python spawned
	common=$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
	set -- "$common"/omp-kit/history-review/*.plan.json
	[ -e "$1" ] || return 1
	for w in "$HOOKDIR" "$HOOKDIR/../reference-transaction"; do
		if [ -f "$w/ref-txn-witness.py" ]; then printf '%s' "$w"; return 0; fi
	done
	return 1
}
wrc=3
if [ -n "$RREF" ] && W=$(reviewed_witness); then
	# A literal -c runner keeps the Python argv statically judged (staged-pysafe); the reader is cwd-bound to the repo.
	COMMITS=$(CDPATH='' cd -- "$REPO" && python3 -B -c 'import runpy, sys; sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name="__main__")' "$W/ref-txn-witness.py" push-admit "$TIP" "$RREF" "$BASE" -- --no-merges "$TIP" --not --remotes=origin)
	wrc=$?
	if [ "$wrc" != "0" ] && [ "$wrc" != "3" ]; then
		printf 'check-pushed-beads: refusing %s -> %s: a reviewed history plan claims this push and its witness refused (exit %s)\n' "$TIP" "$RREF" "$wrc" >&2
		exit 4
	fi
fi
if [ "$wrc" = "3" ]; then
	COMMITS=$(git -C "$REPO" rev-list --no-merges "$TIP" --not --remotes=origin 2>/dev/null) || { printf 'check-pushed-beads: cannot list commits at tip %s outside origin remotes (base %s)\n' "$TIP" "$BASE" >&2; exit 2; }
fi
msg_dir='' # assigned by kitlib_tmp via eval
kitlib_tmp msg_dir pushed-beads-msg || exit 2
TMPMSG=$msg_dir/msg
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
	printf 'check-pushed-beads: no unpushed commits reachable from %s; nothing to check (base %s)\n' "$TIP" "$BASE" >&2
fi
exit 0
