#!/bin/sh
# Install the archive-based fresh gate into the existing Agent Mail pre-push chain.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
HOOKS=$(git -C "$ROOT" rev-parse --git-path hooks)
CHAIN="$HOOKS/pre-push"
DEST="$HOOKS/hooks.d/pre-push/40-omp-kit-fresh-gate"
[ -x "$CHAIN" ] || { echo "install-pre-push-gate: expected executable chain runner: $CHAIN" >&2; exit 2; }
if ! grep -q 'hooks.d' "$CHAIN" || ! grep -q 'pre-push' "$CHAIN"; then
	echo "install-pre-push-gate: refusing to bypass an existing non-chain pre-push hook" >&2
	exit 2
fi
mkdir -p "$(dirname "$DEST")"
cp "$ROOT/scripts/pre-push-gate.sh" "$DEST"
chmod +x "$DEST"
printf 'installed pre-push fresh gate: %s\n' "$DEST"
