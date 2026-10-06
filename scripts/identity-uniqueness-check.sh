#!/bin/sh
# identity-uniqueness-check.sh — ID1 pane identity uniqueness
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.108).
# Agent Mail keeps one identity file per pane; doctor reads those files plus
# the live tmux panes and flags: a live pane with no identity file, an
# identity file whose pane is no longer live (stale, e.g. a dead agent's
# name), and two live panes resolving to one name. Prints findings as
# identity: <kind> lines; exit 1 when any exist, 0 when clean.
# Usage: identity-uniqueness-check.sh --identity-dir DIR [--tmux-bin BIN]
set -u

fail() {
	printf 'identity-uniqueness: %s\n' "$1" >&2
	exit 2
}

DIR=""
TMUX_BIN="tmux"
while [ $# -gt 0 ]; do
	case "$1" in
		--identity-dir) DIR=${2:-}; shift 2 ;;
		--tmux-bin) TMUX_BIN=${2:-}; shift 2 ;;
		--) shift; break ;;
		*) fail "usage: identity-uniqueness-check.sh --identity-dir DIR [--tmux-bin BIN]" ;;
	esac
done
if [ -z "$DIR" ]; then
	fail "--identity-dir is required (Agent Mail identity/<project-hash> dir)"
fi
if [ ! -d "$DIR" ]; then
	fail "identity dir missing: $DIR"
fi
TMP_FINDINGS=$(mktemp "${TMPDIR:-/tmp}/identity-uniqueness.XXXXXX") || fail "cannot create findings file"
trap 'rm -f "$TMP_FINDINGS"' EXIT INT TERM

panes=$("$TMUX_BIN" list-panes -a -F '#{session_name} #{window_index} #{pane_index} #{pane_id}' 2>/dev/null) || fail "cannot list tmux panes"
names_for_panes=$(mktemp "${TMPDIR:-/tmp}/identity-pane-names.XXXXXX") || fail "cannot create scratch file"
trap 'rm -f "$TMP_FINDINGS" "$names_for_panes"' EXIT INT TERM

printf '%s\n' "$panes" | while IFS= read -r line; do
	[ -n "$line" ] || continue
	# shellcheck disable=SC2086
	set -- $line
	session=${1:-}; window=${2:-}; index=${3:-}; id=${4:-};
	digits=$(printf '%s' "$id" | tr -d -c '0-9');
	name="";
	for candidate in "$digits" "$session-$window-$index"; do
		if [ -n "$candidate" ] && [ -f "$DIR/$candidate" ]; then
			name=$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$DIR/$candidate" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/' | head -1);
			if [ -n "$name" ]; then break; fi;
		fi;
	done;
	if [ -z "$name" ]; then
		printf 'identity: no-file live pane %s session %s window %s index %s\n' "$id" "$session" "$window" "$index" >> "$TMP_FINDINGS";
	else
		printf '%s %s\n' "$name" "$id" >> "$names_for_panes";
	fi;
done

sort "$names_for_panes" 2>/dev/null | awk '{ print $1 }' | uniq -d | while IFS= read -r dup; do
	[ -n "$dup" ] || continue;
	at=$(grep "^$dup " "$names_for_panes" | awk '{ print $2 }' | tr '\n' ' ' | sed 's/ $//');
	printf 'identity: shared-name %s on live panes %s\n' "$dup" "$at" >> "$TMP_FINDINGS";
done

for file in "$DIR"/*; do
	[ -f "$file" ] || continue;
	base=$(basename "$file");
	live=0;
	if printf '%s' "$base" | grep -qE '^[0-9]+$'; then
		printf '%s\n' "$panes" | grep -qE "(^| )%$base( |$)" && live=1;
	else
		printf '%s\n' "$panes" | awk -v want="$base" '{ if ($1"-"$2"-"$3 == want) found=1 } END { exit !found }' && live=1;
	fi;
	if [ "$live" = "0" ]; then
		name=$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$file" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/' | head -1);
		printf 'identity: stale-file %s names %s, pane not live\n' "$base" "${name:-unknown}" >> "$TMP_FINDINGS";
	fi;
done

if [ -s "$TMP_FINDINGS" ]; then
	sort -u "$TMP_FINDINGS"
	printf 'identity-uniqueness: FAIL (%s finding(s))\n' "$(wc -l < "$TMP_FINDINGS" | tr -d ' ')" >&2
	exit 1
fi
printf 'identity-uniqueness: OK\n'
