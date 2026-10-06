#!/bin/sh
# sync-check.sh - SYNC1 start gate + fast-forward (ompkit-pwdi boxes 1-2).
#
# Usage:
#   sync-check.sh --repo DIR                 # start gate: HEAD == origin/main?
#   sync-check.sh --repo DIR --fast-forward  # move HEAD when it can do so cleanly
#
# Exit: 0 synced / fast-forwarded (nothing to do is also 0);
#       4 refused: behind (gate) or cannot fast-forward (reason on stderr);
#       2 usage or config error (no repo, no origin/main, fetch failed).
#
# The script never stashes, resets, rebases, or edits the worktree. The only
# mutation is git's own ff-only merge, which refuses rather than overwrite
# dirty paths; every refusal names what blocks and what to run next.
set -u
REPO=""
FF=0
while [ $# -gt 0 ]; do
	case "$1" in
		--repo) [ $# -ge 2 ] || { echo "sync-check: --repo needs a directory" >&2; exit 2; }; REPO=$2; shift 2 ;;
		--fast-forward) FF=1; shift ;;
		-h|--help) sed -n '2,17p' "$0"; exit 0 ;;
		--) shift; break ;;
		-*) echo "sync-check: unknown argument: $1" >&2; exit 2 ;;
		*) break ;;
	esac
done
[ -n "$REPO" ] || { echo "sync-check: --repo DIR is required" >&2; exit 2; }
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || { echo "sync-check: $REPO is not a git repo" >&2; exit 2; }
git -C "$REPO" fetch --quiet origin 2>/dev/null || { echo "sync-check: cannot fetch origin for $REPO (offline?); retry when reachable" >&2; exit 2; }
HEAD_SHA=$(git -C "$REPO" rev-parse HEAD 2>/dev/null) || { echo "sync-check: $REPO has no HEAD commit" >&2; exit 2; }
UP_SHA=$(git -C "$REPO" rev-parse origin/main 2>/dev/null) || { echo "sync-check: origin has no main for $REPO" >&2; exit 2; }
if [ "$HEAD_SHA" = "$UP_SHA" ]; then
	echo "SYNCED $REPO at $HEAD_SHA"
	exit 0
fi
if [ "$FF" != 1 ]; then
	BEHIND=$(git -C "$REPO" rev-list --count HEAD..origin/main 2>/dev/null) || BEHIND="?"
	echo "sync-check: drop back: sync first: $REPO is $BEHIND commit(s) behind origin/main" >&2
	echo "sync-check: run: git -C $REPO merge --ff-only origin/main" >&2
	exit 4
fi
if ! git -C "$REPO" merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
	echo "sync-check: DIVERGED: $REPO HEAD and origin/main have diverged; reconcile by hand (never reset shared history)" >&2
	exit 4
fi
if ERR=$(git -C "$REPO" merge --ff-only origin/main 2>&1); then
	NEW_SHA=$(git -C "$REPO" rev-parse HEAD)
	echo "FAST-FORWARDED $REPO $HEAD_SHA..$NEW_SHA"
	exit 0
fi
echo "sync-check: fast-forward blocked: $(printf '%s' "$ERR" | head -1)" >&2
echo "sync-check: uncommitted work is in the way; commit or move aside your own files only, then re-run" >&2
exit 4
