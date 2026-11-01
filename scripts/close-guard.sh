#!/bin/sh
# close-guard.sh — ID1 grader-must-differ-from-implementer guard
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.108).
# Direct grading and close refuse when the caller (AGENT_NAME) is the bead's
# implementer: its claim assignee or Agent-trailer author. --sub update is
# author handoff to review, not grading; claim stability and publication still
# apply. A fresh-context provider never overrides same-pane close refusal.
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
if [ "$SUB" != "update" ]; then
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
fi
# Native claim revision: the claim must not move while the guard decides.
info=$(read_bead) || fail "cannot re-read bead $BEAD"
assignee2=$(field assignee) || fail "cannot parse bead $BEAD"
updated_at2=$(field updated_at) || fail "cannot parse bead $BEAD"
if [ "$assignee2" != "$assignee" ] || [ "$updated_at2" != "$updated_at" ]; then
	refuse "claim on $BEAD changed during the check (assignee $assignee->$assignee2 / updated_at $updated_at->$updated_at2); re-run"
fi
# PUBLISHGATE1 (ompkit-idun5): transitions cannot accept an unpublished commit.
# Citations are the SHA in a DONE line, a repo@SHA token, or an explicit
# export/commit field. Missing or unresolvable citations fail closed.
if [ "$SUB" = "close" ] || [ "$SUB" = "update" ]; then
	publication_helper=$(dirname "$0")/br-update-lint.py
	cited=$("$publication_helper" publication-citations "$SUB" "$(pwd -P)" "$REASON") ||
		refuse "NOT_PUBLISHED UNKNOWN transition citation could not be parsed; publish with git_converge.py --push"
	if [ -n "$cited" ]; then
		publication_tab=$(printf '\t')
		printf '%s\n' "$cited" | while IFS="$publication_tab" read -r citation_repo sha; do
			if [ -z "$citation_repo" ] || [ -z "$sha" ]; then
				refuse "NOT_PUBLISHED UNKNOWN cited repository or SHA is empty; publish with git_converge.py --push"
			fi
			source_root=$(git -C "$citation_repo" rev-parse --show-toplevel 2>/dev/null) ||
				refuse "NOT_PUBLISHED UNKNOWN cited SHA $sha repository cannot be read; publish with git_converge.py --push"
			if [ "$source_root" != "${fetched_root:-}" ]; then
				git -C "$source_root" fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main ||
					refuse "NOT_PUBLISHED UNKNOWN fresh origin/main fetch failed for cited SHA $sha; publish with git_converge.py --push"
				remote_tip=$(git -C "$source_root" rev-parse --verify 'refs/remotes/origin/main^{commit}' 2>/dev/null) ||
					refuse "NOT_PUBLISHED UNKNOWN freshly fetched origin/main has no readable commit for cited SHA $sha; publish with git_converge.py --push"
				fetched_root=$source_root
			fi
			resolved=$(git -C "$source_root" rev-parse --verify "$sha^{commit}" 2>/dev/null) ||
				refuse "NOT_PUBLISHED UNKNOWN cited SHA $sha does not resolve to a commit; publish with git_converge.py --push"
			git -C "$source_root" merge-base --is-ancestor "$resolved" "$remote_tip" >/dev/null 2>&1
			ancestor_rc=$?
			case "$ancestor_rc" in
				0) ;;
				1) refuse "NOT_PUBLISHED $sha is not an ancestor of freshly fetched origin/main; publish with git_converge.py --push" ;;
				*) refuse "NOT_PUBLISHED UNKNOWN ancestry of cited SHA $sha could not be verified; publish with git_converge.py --push" ;;
			esac
		done
		publication_rc=$?
		[ "$publication_rc" -eq 0 ] || exit "$publication_rc"
	fi
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
if [ "$SUB" = "update" ]; then
	printf 'close-guard: OK (%s may hand off %s for review)\n' "$AGENT_NAME" "$BEAD"
else
	printf 'close-guard: OK (%s may close or grade %s)\n' "$AGENT_NAME" "$BEAD"
fi
