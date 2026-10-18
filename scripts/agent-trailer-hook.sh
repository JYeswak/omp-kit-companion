#!/bin/sh
# agent-trailer-hook.sh — ID1 commit trailer hook body
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.108; foreign-trailer refusal
# ompkit-fp72.99).
# prepare-commit-msg hook bound to the caller named by AGENT_NAME:
#   no 'Agent:' trailer                  -> append 'Agent: <AGENT_NAME>'
#   exactly one, naming the caller       -> accept, message untouched
#   exactly one, naming anyone else      -> refuse (exit 1, AGENT_TRAILER_MISMATCH)
#   more than one                        -> refuse (exit 1, AGENT_TRAILER_AMBIGUOUS)
# A refusal leaves the message untouched. Without AGENT_NAME the message is
# never touched and nothing is judged (the hook never invents an identity).
# Installed by scripts/install-agent-trailer-hook.sh into the hooks.d chain.
# Git calls: prepare-commit-msg MSG_FILE [SOURCE [SHA]].
set -u

FILE=${1:-}
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
	exit 0
fi
if [ -z "${AGENT_NAME:-}" ]; then
	exit 0
fi
TRAILERS=$(grep -iE '^[[:space:]]*Agent:[[:space:]]' "$FILE" 2>/dev/null)
if [ -z "$TRAILERS" ]; then
	{
		printf '\n'
		printf 'Agent: %s\n' "$AGENT_NAME"
	} >> "$FILE"
	exit 0
fi
COUNT=$(printf '%s\n' "$TRAILERS" | grep -c '')
if [ "$COUNT" -gt 1 ]; then
	printf "agent-trailer: AGENT_TRAILER_AMBIGUOUS: %s Agent trailers found; exactly one is allowed and it must name the bound caller '%s'\n" "$COUNT" "$AGENT_NAME" >&2
	exit 1
fi
NAMED=$(printf '%s\n' "$TRAILERS" | sed -E 's/^[[:space:]]*[Aa][Gg][Ee][Nn][Tt]:[[:space:]]*//; s/[[:space:]]*$//')
if [ "$NAMED" != "$AGENT_NAME" ]; then
	printf "agent-trailer: AGENT_TRAILER_MISMATCH: the message names Agent '%s' but the bound caller is '%s'\n" "$NAMED" "$AGENT_NAME" >&2
	exit 1
fi
