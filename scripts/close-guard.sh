#!/bin/sh
# close-guard.sh — ID1 grader-must-differ-from-implementer guard
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.108).
# Run before closing or grading a bead: refuses when the caller (AGENT_NAME)
# is the bead's implementer — the claim assignee, or the Agent trailer on a
# commit naming the bead. A different actor passes, as does a bead labelled
# reviewer-fresh-context:<model>. Prints the reason; exit 4 on refusal,
# exit 0 to proceed, exit 2 on usage/context errors.
# Usage: close-guard.sh BEAD_ID [--db PATH]
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
DB=""
if [ "${2:-}" = "--db" ]; then
	DB=${3:-}
fi
if [ -z "$BEAD" ]; then
	fail "usage: close-guard.sh BEAD_ID [--db PATH]"
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
labels=$(printf '%s' "$info" | python3 -c "import json,sys; d=json.load(sys.stdin); d=d[0] if isinstance(d,list) else d; print('\n'.join(d.get('labels') or []))" 2>/dev/null) || fail "cannot parse bead labels"
if printf '%s' "$labels" | grep -q "^reviewer-fresh-context:"; then
	printf 'close-guard: OK (fresh-context review label)\n'
	exit 0
fi
if [ -n "$assignee" ] && [ "$assignee" = "$AGENT_NAME" ]; then
	refuse "caller $AGENT_NAME holds the claim on $BEAD; a different worker must close or grade"
fi
trailer=$(git log --format=%B --grep="$BEAD" 2>/dev/null | grep -iE '^[[:space:]]*Agent:[[:space:]]' | head -1) || true
if printf '%s' "$trailer" | grep -qiE "^[[:space:]]*Agent:[[:space:]]*${AGENT_NAME}[[:space:]]*$"; then
	refuse "caller $AGENT_NAME has an Agent trailer on a $BEAD commit; a different worker must close or grade"
fi
printf 'close-guard: OK (%s may close or grade %s)\n' "$AGENT_NAME" "$BEAD"
