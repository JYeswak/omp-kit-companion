#!/bin/sh
# Install the Agent trailer prepare-commit-msg hook into the existing hooks chain.
# Usage: install-agent-trailer-hook.sh (takes no arguments; installs into this kit checkout).
# Unknown arguments are refused before anything is written.
set -eu
if [ $# -gt 0 ]; then
	printf 'install-agent-trailer-hook: unknown argument: %s\n' "$1" >&2
	echo "Usage: install-agent-trailer-hook.sh (takes no arguments; installs into this kit checkout)." >&2
	exit 2
fi
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
HOOKS=$(git -C "$ROOT" rev-parse --git-path hooks)
CHAIN="$HOOKS/prepare-commit-msg"
DEST="$HOOKS/hooks.d/prepare-commit-msg/30-omp-kit-agent-trailer"
if [ ! -x "$CHAIN" ]; then
	mkdir -p "$(dirname "$DEST")"
	printf '#!/bin/sh\nexec sh "%s/scripts/agent-trailer-hook.sh" "$@"\n' "$ROOT" > "$DEST"
	chmod +x "$DEST"
	printf 'installed agent trailer hook (standalone): %s\n' "$DEST"
	exit 0
fi
if ! grep -q 'hooks.d' "$CHAIN" || ! grep -q 'prepare-commit-msg' "$CHAIN"; then
	echo "install-agent-trailer-hook: refusing to bypass an existing non-chain prepare-commit-msg hook" >&2
	exit 2
fi
mkdir -p "$(dirname "$DEST")"
cp "$ROOT/scripts/agent-trailer-hook.sh" "$DEST"
chmod +x "$DEST"
printf 'installed agent trailer hook: %s\n' "$DEST"
