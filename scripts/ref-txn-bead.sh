#!/bin/sh
# ref-txn-bead.sh — COMMIT1 reference-transaction member (ompkit-2w7h).
# The commit-msg hook never runs for plumbing (`commit-tree` + `update-ref`)
# or for `commit --no-verify`, so an id-less commit could still reach main and
# then block every later push at check-pushed-beads. On 2026-10-16 five such
# commits held 14 others off origin. Git runs the reference-transaction hook
# for every ref update however it is made. In the "prepared" state this member
# refuses (exit 4, aborting the update) a transaction that moves
# refs/heads/main to any non-merge commit, not already on an origin
# remote-tracking ref, whose message names no existing bead id. The judge is
# commit-msg-bead.sh, installed beside this file, so the commit, ref and push
# checks share one rule. Other refs and states pass untouched.
set -u
[ "${1:-}" = "prepared" ] || exit 0
HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
CHECK="$HERE/commit-msg-bead.sh"
ZERO=0000000000000000000000000000000000000000
rc=0
MSG=""
while read -r old new ref; do
	[ "$ref" = "refs/heads/main" ] || continue
	case "$new" in "$ZERO" | "") continue ;; esac
	# No old value given (plain update-ref): judge only what is new relative
	# to the ref's current tip, not every unpublished commit beneath it.
	if [ "$old" = "$ZERO" ]; then old=$(git rev-parse -q --verify "$ref" 2>/dev/null) || old=""; fi
	if [ -n "$old" ]; then
		commits=$(git rev-list --no-merges "$new" "^$old" --not --remotes=origin 2>/dev/null) || commits="__ERR__"
	else
		commits=$(git rev-list --no-merges "$new" --not --remotes=origin 2>/dev/null) || commits="__ERR__"
	fi
	if [ "$commits" = "__ERR__" ]; then
		printf 'ref-txn-bead: cannot list the commits %s would gain; refusing the update\n' "$ref" >&2
		exit 4
	fi
	for sha in $commits; do
		if [ -z "$MSG" ]; then
			# Sourced only when a message must be judged: most ref updates gain no commit.
			[ -f "$HERE/kitlib-tmp.sh" ] || { printf 'ref-txn-bead: kitlib-tmp.sh missing beside %s; refusing the update\n' "$0" >&2; exit 4; }
			# shellcheck source=scripts/kitlib-tmp.sh
			. "$HERE/kitlib-tmp.sh"
			msg_dir='' # assigned by kitlib_tmp via eval
			kitlib_tmp msg_dir ref-txn-bead || exit 4
			MSG=$msg_dir/msg
		fi
		if ! git log --format=%B -n 1 "$sha" > "$MSG" 2>/dev/null; then
			printf 'ref-txn-bead: cannot read commit %s; refusing the update\n' "$sha" >&2
			rc=4
			continue
		fi
		if ! sh "$CHECK" "$MSG" > /dev/null 2>&1; then
			printf 'ref-txn-bead: refusing %s update: commit %s names no existing bead id; add your bead id to its message\n' "$ref" "$sha" >&2
			rc=4
		fi
	done
done
[ -z "$MSG" ] || kitlib_tmp_cleanup "$msg_dir"
exit "$rc"
