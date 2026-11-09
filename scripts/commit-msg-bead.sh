#!/bin/sh
# commit-msg-bead.sh — COMMIT1 commit-msg hook body (ompkit-2w7h).
# Refuses a commit whose message names no bead id that exists in the repo's
# tracker. Installed by scripts/install-commit-msg-bead.sh into the hooks.d
# chain. Git calls: commit-msg MSG_FILE [SOURCE [SHA]].
# Id shapes are per-repo: any token the repo's own tracker resolves counts
# (full ompkit-<id>, short rz5.<n>, cfs- or uds-shaped ids, ...). Candidates
# are message tokens of 3+ chars; existence is decided by `br show` alone, not
# by token shape, so digit-less real ids (ompkit-kxdy) pass while made-up
# tokens are refused. Each candidate is checked with `br show` until one
# passes, at most 20 lookups. Merge/template sources are exempt (their
# messages are generated); repos without a tracker are skipped, never
# blocked. Test seams: BEADS_DB overrides the tracker path, BR_BIN overrides
# the br binary under test, BEAD_VERDICT_DIR overrides the record directory.
# `--record` is the post-commit mode: copy the commit-time PASS verdict to a
# record keyed by the exact HEAD sha (HOOKDEDUP1 ompkit-1ra0d.60); it always
# exits 0 and never refuses.
set -u
BEAD_HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P 2>/dev/null) || BEAD_HERE=""
if [ -n "$BEAD_HERE" ] && [ -f "$BEAD_HERE/bead-verdict.sh" ]; then
	# shellcheck source=scripts/bead-verdict.sh
	. "$BEAD_HERE/bead-verdict.sh" 2>/dev/null || true
fi

if [ "${1:-}" = "--record" ]; then
	# Post-commit mode (HOOKDEDUP1 ompkit-1ra0d.60): copy the commit-time PASS
	# verdict to a record keyed by the exact new commit sha. Never refuses:
	# any failure exits 0 and the push falls back to today's live `br` check.
	if command -v bead_msghash >/dev/null 2>&1 && command -v bead_verdict_dir >/dev/null 2>&1 && command -v bead_verdict_store >/dev/null 2>&1; then
		HEAD_SHA=$(git rev-parse HEAD 2>/dev/null) || HEAD_SHA=""
		if [ -n "$HEAD_SHA" ]; then
			HEAD_MSG=$(git log --format=%B -n 1 "$HEAD_SHA" 2>/dev/null) || HEAD_MSG=""
			HEAD_HASH=$(printf '%s' "$HEAD_MSG" | bead_msghash 2>/dev/null) || HEAD_HASH=""
			if [ -n "$HEAD_HASH" ] && RECORD_DIR=$(bead_verdict_dir 2>/dev/null) && [ -f "$RECORD_DIR/pending-$HEAD_HASH" ]; then
				RECORD_LINE=$(cat -- "$RECORD_DIR/pending-$HEAD_HASH" 2>/dev/null) || RECORD_LINE=""
				if [ -n "$RECORD_LINE" ]; then
					bead_verdict_store "$RECORD_DIR" "$HEAD_SHA" "$RECORD_LINE" 2>/dev/null || true
				fi
				# The pending record has served its one commit; it never admits anything itself.
				rm -f -- "$RECORD_DIR/pending-$HEAD_HASH" 2>/dev/null || true
			fi
		fi
	fi
	exit 0
fi

FILE=${1:-}
SOURCE=${2:-}
case "$SOURCE" in
	merge|template) exit 0 ;;
esac
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
	exit 0
fi
BR=${BR_BIN:-br}
if [ -n "${BEADS_DB:-}" ]; then
	DB="$BEADS_DB"
else
	ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
	DB="$ROOT/.beads/beads.db"
fi
[ -f "$DB" ] || exit 0
MSG=$(cat -- "$FILE" 2>/dev/null) || exit 0
TOKENS=$(printf '%s' "$MSG" | tr -c 'A-Za-z0-9_.-' '\n' | grep -E '.{3,}' | sort -u) || true
# Candidate order, so a real id is never cut by the 20-lookup cap (jev-9odh
# ranked 35th alphabetically and was refused, JadeSpire AM57919): Bead:/Beads:
# trailer values; the repo's own issue_prefix (tracker config.yaml, the active
# line, else the commented template); known fleet prefixes; any bead-shaped
# token (prefix-hash with a digit); then everything else.
CONFIG="$(dirname -- "$DB")/config.yaml"
PREFIX=$(sed -n 's/^issue_prefix:[[:space:]]*\([A-Za-z0-9_-]\{1,\}\).*/\1/p' "$CONFIG" 2>/dev/null | head -n 1) || PREFIX=""
if [ -z "$PREFIX" ]; then
	PREFIX=$(sed -n 's/^#[[:space:]]*issue_prefix:[[:space:]]*\([A-Za-z0-9_-]\{1,\}\).*/\1/p' "$CONFIG" 2>/dev/null | head -n 1) || PREFIX=""
fi
TRAILER_TOKENS=$(printf '%s\n' "$MSG" | sed -n 's/^[[:space:]]*Beads\{0,1\}:[[:space:]]*//p' | tr -c 'A-Za-z0-9_.-' '\n' | grep -E '.{3,}') || true
OWN_TOKENS=$(printf '%s\n' "$TOKENS" | awk -v p="$PREFIX" 'p != "" && (index($0, p "-") == 1 || index($0, p ".") == 1)') || true
FLEET_TOKENS=$(printf '%s\n' "$TOKENS" | grep -E '^(ompkit-|rz5[.]|cfs-|uds-|jev-|kit-|zestroku-)' || true)
SHAPED_TOKENS=$(printf '%s\n' "$TOKENS" | grep -E '^[A-Za-z][A-Za-z0-9]*-[A-Za-z]*[0-9][A-Za-z0-9]*([.][0-9]+)*$' || true)
CANDIDATES=$(printf '%s\n%s\n%s\n%s\n%s\n' "$TRAILER_TOKENS" "$OWN_TOKENS" "$FLEET_TOKENS" "$SHAPED_TOKENS" "$TOKENS" | grep -E '.{3,}' | awk '!seen[$0]++' | head -20) || true
if [ -z "$CANDIDATES" ]; then
	printf 'commit-msg-bead: refusing commit with no bead-like token; name a bead id the tracker resolves\n' >&2
	exit 4
fi
# candidate tokens contain no glob characters by construction above
# BRBUSY1: br exits 3 only for "Issue not found". Any other failure (a busy or locked tracker right
# after a `br comments add`) is not evidence of a missing bead: retry it once, then name the br error.
UNANSWERED=""
bead_found() {
	if [ "${BEAD_VERDICT_PENDING:-1}" != 0 ] && command -v bead_msghash >/dev/null 2>&1 && command -v bead_verdict_dir >/dev/null 2>&1 && command -v bead_verdict_store >/dev/null 2>&1; then
		# HOOKDEDUP1: best-effort commit-time verdict record for the push and
		# ref guards. Silent and non-fatal: any failure falls back to the live
		# `br` check at push time. The push and ref guards call this body for an
		# existing commit with BEAD_VERDICT_PENDING=0: no commit follows, so a
		# pending record would never be consumed.
		PASS_HASH=$(printf '%s' "$MSG" | bead_msghash 2>/dev/null) || PASS_HASH=""
		if [ -n "$PASS_HASH" ] && PASS_DIR=$(bead_verdict_dir 2>/dev/null); then
			bead_verdict_store "$PASS_DIR" "pending-$PASS_HASH" "PASS $1 $PASS_HASH" 2>/dev/null || true
		fi
	fi
	exit 0
}
# shellcheck disable=SC2086
for id in $CANDIDATES; do
	# Read-only lookup (G13): a commit hook never imports into or flushes the tracker.
	BR_ERR=$("$BR" --db "$DB" --no-auto-import --no-auto-flush show "$id" 2>&1 >/dev/null) && bead_found "$id"
	BR_RC=$?
	[ "$BR_RC" -eq 3 ] || UNANSWERED="$UNANSWERED $id"
done
if [ -n "$UNANSWERED" ]; then
	sleep 1
	for id in $UNANSWERED; do
		BR_ERR=$("$BR" --db "$DB" --no-auto-import --no-auto-flush show "$id" 2>&1 >/dev/null) && bead_found "$id"
		BR_RC=$?
		if [ "$BR_RC" -ne 3 ]; then
			printf 'commit-msg-bead: refusing commit: br could not answer for %s (rc %s, retried once): %s; this is a tracker error, not a missing bead; retry when the tracker is free\n' "$id" "$BR_RC" "$(printf '%s' "$BR_ERR" | head -1)" >&2
			exit 4
		fi
	done
fi
printf 'commit-msg-bead: refusing commit: none of the named tokens exists in %s\n' "$DB" >&2
exit 4
