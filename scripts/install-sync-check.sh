#!/bin/sh
# install-sync-check.sh - SYNC1 box 5 installer (ompkit-pwdi).
# Installs a self-contained sync-check.sh into a repo's scripts/ so the
# start gate, fast-forward and post-push assertion run the same everywhere.
# Usage: install-sync-check.sh [REPO] (default: this kit checkout).
# A foreign REPO gets a self-contained copy of the script body, never a
# reference into this checkout, so the check survives the kit moving.
# Prints the undo command. Exit nonzero when the installed copy cannot
# prove itself (its probe must exit 0 synced or 4 behind, never 2 broken).
set -eu
KITROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
TARGET=${1:-$KITROOT}
TARGET=$(CDPATH='' cd -- "$TARGET" && pwd -P) || { echo "install-sync-check: cannot enter ${1:-$KITROOT}" >&2; exit 2; }
git -C "$TARGET" rev-parse --git-dir >/dev/null 2>&1 || { echo "install-sync-check: $TARGET is not a git repo" >&2; exit 2; }
if [ "$TARGET" = "$KITROOT" ]; then
	echo "install-sync-check: the kit's own scripts/sync-check.sh is the source; nothing to install" >&2
	exit 2
fi
DEST="$TARGET/scripts/sync-check.sh"
mkdir -p "$(dirname "$DEST")"
cp "$KITROOT/scripts/sync-check.sh" "$DEST"
chmod +x "$DEST"
if sh "$DEST" --repo "$TARGET" >/dev/null 2>&1; then
	rc=0
else
	rc=$?
fi
if [ "$rc" = 2 ]; then
	echo "install-sync-check: installed copy cannot run in $TARGET (missing git/origin?)" >&2
	exit 1
fi
echo "installed sync check: $DEST (probe exit $rc: 0 synced, 4 behind)"
echo "undo: rm $DEST"
