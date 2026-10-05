#!/bin/sh
# agent-trailer-hook.sh — ID1 commit trailer hook body
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.108).
# prepare-commit-msg hook: appends an 'Agent: <name>' trailer from AGENT_NAME
# when the message has none. Leaves the message untouched when identity is
# unavailable (never invents one) or a trailer already exists. Installed by
# scripts/install-agent-trailer-hook.sh into the hooks.d chain.
# Git calls: prepare-commit-msg MSG_FILE [SOURCE [SHA]].
set -u

FILE=${1:-}
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
	exit 0
fi
if [ -z "${AGENT_NAME:-}" ]; then
	exit 0
fi
if grep -qiE '^[[:space:]]*Agent:[[:space:]]' "$FILE" 2>/dev/null; then
	exit 0
fi
{
	printf '\n'
	printf 'Agent: %s\n' "$AGENT_NAME"
} >> "$FILE"
