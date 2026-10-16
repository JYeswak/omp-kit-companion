#!/bin/sh
# close-guard.sh — ID1 grader-must-differ-from-implementer guard
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.108).
# Run before closing or grading a bead: refuses when the caller (AGENT_NAME)
# is the bead's implementer — the claim assignee, or the Agent trailer on a
# commit naming the bead. A fresh-context gate provider is recorded separately;
# it never overrides same-pane refusal. Prints the reason; exit 4 on refusal,
# exit 0 to proceed, exit 2 on usage/context errors.
 # Usage: close-guard.sh BEAD_ID [--db PATH] [--sub close|update] [--reason TEXT]
set -u

fail() {
	printf 'close-guard: %s\n' "$1" >&2
	exit 2
}
refuse() {
	printf 'close-guard: REFUSED %s\n' "$1" >&2
	exit 4
}

 BEAD=${1:-}
 DB=""; SUB=""; REASON=""
 shift 2>/dev/null || true
 while [ $# -gt 0 ]; do
 	case "$1" in
 		--db) DB=${2:-}; shift 2 ;;
 		--sub) SUB=${2:-}; shift 2 ;;
 		--reason) REASON=${2:-}; shift 2 ;;
 		*) shift ;;
 	esac
 done
 # Legacy positional form: close-guard.sh BEAD_ID [--db PATH]
 if [ -z "$BEAD" ]; then
 	fail "usage: close-guard.sh BEAD_ID [--db PATH] [--sub SUB] [--reason TEXT]"
 fi
if [ -z "${AGENT_NAME:-}" ]; then
	fail "AGENT_NAME is required (pane identity)"
fi
read_bead() {
	if [ -n "$DB" ]; then
		br --db "$DB" show "$BEAD" --json 2>/dev/null
	else
		br show "$BEAD" --json 2>/dev/null
	fi
}
# field NAME: print one bead field ('' when absent) from $info
field() {
	printf '%s' "$info" | python3 -c "import json,sys; d=json.load(sys.stdin); d=d[0] if isinstance(d,list) else d; print(d.get(sys.argv[1]) or '')" "$1" 2>/dev/null
}
info=$(read_bead) || fail "cannot read bead $BEAD"
assignee=$(field assignee) || fail "cannot parse bead $BEAD"
updated_at=$(field updated_at) || fail "cannot parse bead $BEAD"
if [ -n "$assignee" ] && [ "$assignee" = "$AGENT_NAME" ]; then
	refuse "caller $AGENT_NAME holds the claim on $BEAD; a different worker must close or grade"
fi
# Every commit naming the bead id as an exact token (fixed-string candidates,
# then a token-boundary check) is judged; any Agent trailer equal to the caller
# (case-insensitive, trimmed) refuses, whichever implementer came first.
hit=$(git log --fixed-strings --grep="$BEAD" --format='@@sha %H%n%B' 2>/dev/null | awk -v id="$BEAD" -v me="$AGENT_NAME" '
function trim(s) { sub(/^[ \t\r]+/, "", s); sub(/[ \t\r]+$/, "", s); return s }
function flush() { if (sha != "" && named && mine && out == "") out = sha; sha = ""; named = 0; mine = 0 }
function names(line,   rest, p, before, after) {
	rest = line
	while ((p = index(rest, id)) > 0) {
		before = (p > 1) ? substr(rest, p - 1, 1) : ""
		after = substr(rest, p + length(id), 1)
		if (before !~ /[A-Za-z0-9._-]/ && after !~ /[A-Za-z0-9._-]/) return 1
		rest = substr(rest, p + 1)
	}
	return 0
}
BEGIN { want = tolower(trim(me)) }
/^@@sha [0-9a-f]+$/ { flush(); sha = substr($0, 7); next }
{
	if (names($0)) named = 1
	l = $0
	if (tolower(l) ~ /^[ \t]*agent:/) { sub(/^[ \t]*[Aa][Gg][Ee][Nn][Tt]:/, "", l); if (tolower(trim(l)) == want) mine = 1 }
}
END { flush(); print out }') || hit=""
if [ -n "$hit" ]; then
	refuse "caller $AGENT_NAME has an Agent trailer on $BEAD commit $hit; a different worker must close or grade"
fi
# Native claim revision: the claim must not move while the guard decides.
info=$(read_bead) || fail "cannot re-read bead $BEAD"
assignee2=$(field assignee) || fail "cannot parse bead $BEAD"
updated_at2=$(field updated_at) || fail "cannot parse bead $BEAD"
if [ "$assignee2" != "$assignee" ] || [ "$updated_at2" != "$updated_at" ]; then
	refuse "claim on $BEAD changed during the check (assignee $assignee->$assignee2 / updated_at $updated_at->$updated_at2); re-run"
fi
 # LESSON1 (ompkit-ok3y): a close carries its lesson in the transition comment.
 # Only the close subcommand with a non-empty comment is judged; review/grading
 # entries and reason-less invocations keep the old behavior.
 if [ "$SUB" = "close" ] && [ -n "$REASON" ]; then
 	if printf '%s\n' "$REASON" | grep -qiE '^[[:space:]]*lesson[[:space:]]*:'; then
 		:
 	elif printf '%s\n' "$REASON" | grep -qiE '^[[:space:]]*none\.?[[:space:]]*$'; then
 		:
 	else
 		refuse "close of $BEAD carries no Lesson: line or explicit none in its transition comment"
 	fi
 fi
 printf 'close-guard: OK (%s may close or grade %s)\n' "$AGENT_NAME" "$BEAD"
