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
if [ -n "$DB" ]; then
	info=$(br --db "$DB" show "$BEAD" --json 2>/dev/null) || fail "cannot read bead $BEAD"
else
	info=$(br show "$BEAD" --json 2>/dev/null) || fail "cannot read bead $BEAD"
fi
assignee=$(printf '%s' "$info" | python3 -c "import json,sys; d=json.load(sys.stdin); d=d[0] if isinstance(d,list) else d; print(d.get('assignee') or '')" 2>/dev/null) || fail "cannot parse bead $BEAD"
if [ -n "$assignee" ] && [ "$assignee" = "$AGENT_NAME" ]; then
	refuse "caller $AGENT_NAME holds the claim on $BEAD; a different worker must close or grade"
fi
trailer=$(git log --format=%B --grep="$BEAD" 2>/dev/null | grep -iE '^[[:space:]]*Agent:[[:space:]]' | head -1) || true
if printf '%s' "$trailer" | grep -qiE "^[[:space:]]*Agent:[[:space:]]*${AGENT_NAME}[[:space:]]*$"; then
	refuse "caller $AGENT_NAME has an Agent trailer on a $BEAD commit; a different worker must close or grade"
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
