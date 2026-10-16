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
# the br binary under test.
set -u

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
# shellcheck disable=SC2086
for id in $CANDIDATES; do
	# Read-only lookup (G13): a commit hook never imports into or flushes the tracker.
	if "$BR" --db "$DB" --no-auto-import --no-auto-flush show "$id" >/dev/null 2>&1; then
		exit 0
	fi
done
printf 'commit-msg-bead: refusing commit: none of the named tokens exists in %s\n' "$DB" >&2
exit 4
