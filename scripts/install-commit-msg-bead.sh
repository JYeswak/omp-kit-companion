#!/bin/sh
# Install the bead-id commit-msg hook into the existing hooks chain.
# Usage: install-commit-msg-bead.sh [REPO] (default: this kit checkout).
# A foreign REPO gets a self-contained copy of the hook body, never a
# reference into this checkout, so the hook survives the kit moving.
set -eu
KITROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
TARGET=${1:-$KITROOT}
TARGET=$(CDPATH='' cd -- "$TARGET" && pwd -P) || { echo "install-commit-msg-bead: cannot enter ${1:-$KITROOT}" >&2; exit 2; }
HOOKS=$(git -C "$TARGET" rev-parse --git-path hooks) || { echo "install-commit-msg-bead: $TARGET is not a git repo" >&2; exit 2; }
case "$HOOKS" in
	/*) ;;
	*) HOOKS="$TARGET/$HOOKS" ;;
esac
CHAIN="$HOOKS/commit-msg"
DEST="$HOOKS/hooks.d/commit-msg/40-omp-kit-commit-msg-bead"
install_body() {
	cp "$KITROOT/scripts/commit-msg-bead.sh" "$DEST"
	chmod +x "$DEST"
}
if [ ! -x "$CHAIN" ]; then
	mkdir -p "$(dirname "$DEST")"
	if [ "$TARGET" = "$KITROOT" ]; then
		printf '#!/bin/sh\nexec sh "%s/scripts/commit-msg-bead.sh" "$@"\n' "$KITROOT" > "$DEST"
		chmod +x "$DEST"
		printf 'installed bead-id hook (standalone): %s\n' "$DEST"
		exit 0
	fi
	install_body
	printf 'installed bead-id hook (standalone copy): %s\n' "$DEST"
	exit 0
fi
if ! grep -q 'hooks.d' "$CHAIN" || ! grep -q 'commit-msg' "$CHAIN"; then
	mkdir -p "$(dirname "$DEST")"
	install_body
	printf 'installed bead-id hook as chain member (inactive until chained): %s\n' "$DEST"
	printf 'to activate: make %s run every executable in %s, then re-run this installer\n' "$CHAIN" "$(dirname "$DEST")" >&2
	exit 0
fi
mkdir -p "$(dirname "$DEST")"
install_body
printf 'installed bead-id hook: %s\n' "$DEST"
