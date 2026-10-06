#!/bin/sh
# Install the bead-id commit-msg hook into the existing hooks chain.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
HOOKS=$(git -C "$ROOT" rev-parse --git-path hooks)
CHAIN="$HOOKS/commit-msg"
DEST="$HOOKS/hooks.d/commit-msg/40-omp-kit-commit-msg-bead"
if [ ! -x "$CHAIN" ]; then
	mkdir -p "$(dirname "$DEST")"
	printf '#!/bin/sh\nexec sh "%s/scripts/commit-msg-bead.sh" "$@"\n' "$ROOT" > "$DEST"
	chmod +x "$DEST"
	printf 'installed bead-id hook (standalone): %s\n' "$DEST"
	exit 0
fi
if ! grep -q 'hooks.d' "$CHAIN" || ! grep -q 'commit-msg' "$CHAIN"; then
	echo "install-commit-msg-bead: refusing to bypass an existing non-chain commit-msg hook" >&2
	exit 2
fi
mkdir -p "$(dirname "$DEST")"
cp "$ROOT/scripts/commit-msg-bead.sh" "$DEST"
chmod +x "$DEST"
printf 'installed bead-id hook: %s\n' "$DEST"
