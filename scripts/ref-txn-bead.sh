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
#
# Reviewed history transforms (HISTADMIT1, ompkit-2w7h.3): a history scrub
# rewrites old id-less commits, so every rewritten counterpart looks new. When
# a history operation's owner record holds the index (<gitdir>/index.lock is
# JSON, never Git's binary index), the transaction is admitted only through
# ref-txn-witness.py beside this file: it requires the operation's owned
# context plus an independent, immutable review of that exact transform, and
# prints the gained commits that are not mapped counterparts, which get the
# ordinary check below. A missing reader refuses that operation only; with no
# owner record, behavior is unchanged.
set -u
[ "${1:-}" = "prepared" ] || exit 0
HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
CHECK="$HERE/commit-msg-bead.sh"
READER="$HERE/ref-txn-witness.py"
ZERO=0000000000000000000000000000000000000000
if [ -f "$HERE/bead-verdict.sh" ]; then
	# shellcheck source=scripts/bead-verdict.sh
	. "$HERE/bead-verdict.sh" 2>/dev/null || true
fi
rc=0
MSG=""
TXN=$(cat) || exit 4

history_operation() { # true when a history operation's owner record holds the index
	gitdir=$(git rev-parse --absolute-git-dir 2>/dev/null) || return 1
	[ -f "$gitdir/index.lock" ] && [ ! -L "$gitdir/index.lock" ] || return 1
	[ "$(dd if="$gitdir/index.lock" bs=1 count=1 2>/dev/null)" = "{" ]
}

while read -r old new ref; do
	[ "$ref" = "refs/heads/main" ] || continue
	case "$new" in "$ZERO" | "") continue ;; esac
	if history_operation; then
		if [ ! -f "$READER" ] || ! command -v python3 > /dev/null 2>&1; then
			printf 'ref-txn-bead: a history operation holds the index but its witness reader is missing beside %s; refusing this %s update\n' "$0" "$ref" >&2
			exit 4
		fi
		# runpy keeps the hook's cwd (the repository) and its stdin (the transaction lines).
		if ! commits=$(printf '%s\n' "$TXN" | python3 -B -c 'import runpy, sys; sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name="__main__")' "$READER" admit); then
			printf 'ref-txn-bead: refusing %s update: the history transform has no matching independent review witness\n' "$ref" >&2
			exit 4
		fi
	else
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
		if command -v bead_verdict_lookup >/dev/null 2>&1 && bead_verdict_lookup "$(git rev-parse --show-toplevel 2>/dev/null)" "$sha" 2>/dev/null; then
			continue
		fi
		if ! git log --format=%B -n 1 "$sha" > "$MSG" 2>/dev/null; then
			printf 'ref-txn-bead: cannot read commit %s; refusing the update\n' "$sha" >&2
			rc=4
			continue
		fi
		if ! BEAD_VERDICT_PENDING=0 sh "$CHECK" "$MSG" > /dev/null 2>&1; then
			printf 'ref-txn-bead: refusing %s update: commit %s names no existing bead id; add your bead id to its message\n' "$ref" "$sha" >&2
			rc=4
			continue
		fi
		# Cache the live PASS for later pushes of the same sha (best-effort).
		# Only a real tracker verdict is cached: without a tracker file the
		# judge passes trivially and there is nothing worth reusing.
		REF_TOP=$(git rev-parse --show-toplevel 2>/dev/null) || REF_TOP=""
		REF_DB="$REF_TOP/.beads/beads.db"
		if [ -n "${BEADS_DB:-}" ]; then REF_DB="$BEADS_DB"; fi
		if [ -n "$REF_TOP" ] && [ -f "$REF_DB" ] && command -v bead_verdict_note >/dev/null 2>&1; then
			bead_verdict_note "$REF_TOP" "$sha" 2>/dev/null || true
		fi
	done
done <<EOF
$TXN
EOF
[ -z "$MSG" ] || kitlib_tmp_cleanup "$msg_dir"
exit "$rc"
