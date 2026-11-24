#!/bin/sh
# Install the archive-based fresh gate and the Board reservation member into the repo's hooks.d chains.
# Usage: install-pre-push-gate.sh [--check [REPO]] (default: this kit checkout; install takes no arguments).
# Unknown arguments are refused before anything is written; --check only reports.
set -eu
usage() {
	echo "Usage: install-pre-push-gate.sh [--check [REPO]] (default: this kit checkout; install takes no arguments)." >&2
}
MODE=install
POS=""
while [ $# -gt 0 ]; do
	case "$1" in
		--check) MODE=check; shift ;;
		--*) printf 'install-pre-push-gate: unknown argument: %s\n' "$1" >&2; usage; exit 2 ;;
		*) if [ -n "$POS" ]; then printf 'install-pre-push-gate: unexpected argument: %s\n' "$1" >&2; usage; exit 2; fi; POS=$1; shift ;;
	esac
done
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
if [ "$MODE" = install ] && [ -n "$POS" ]; then
	printf 'install-pre-push-gate: unexpected argument: %s\n' "$POS" >&2; usage; exit 2
fi
TARGET=${POS:-$ROOT}
TARGET=$(CDPATH='' cd -- "$TARGET" && pwd -P) || { printf 'install-pre-push-gate: cannot enter %s\n' "${POS:-$TARGET}" >&2; exit 2; }
HOOKS=$(git -C "$TARGET" rev-parse --git-path hooks) || { printf 'install-pre-push-gate: %s is not a git repo\n' "$TARGET" >&2; exit 2; }
case "$HOOKS" in
	/*) ;;
	*) HOOKS="$TARGET/$HOOKS" ;;
esac
if [ "$MODE" = check ]; then
	stale=0
	dest="$HOOKS/hooks.d/pre-push/40-omp-kit-fresh-gate"
	src="$ROOT/scripts/pre-push-gate.sh"
	if [ ! -f "$dest" ]; then
		printf 'install-pre-push-gate: MISSING installed member: %s\n' "$dest" >&2
		stale=1
	elif ! cmp -s "$dest" "$src"; then
		printf 'install-pre-push-gate: STALE installed member: %s differs from %s; rerun %s\n' "$dest" "$src" "$0" >&2
		stale=1
	fi
	dest="$HOOKS/hooks.d/pre-commit/50-omp-kit-board-reservations"
	src="$ROOT/scripts/check-staged-board-reservations.sh"
	if [ ! -f "$dest" ]; then
		printf 'install-pre-push-gate: MISSING installed member: %s\n' "$dest" >&2
		stale=1
	elif ! cmp -s "$dest" "$src"; then
		printf 'install-pre-push-gate: STALE installed member: %s differs from %s; rerun %s\n' "$dest" "$src" "$0" >&2
		stale=1
	fi
	if [ "$stale" = 0 ]; then printf 'install-pre-push-gate: hooks fresh in %s\n' "$TARGET"; exit 0; fi
	exit 3
fi
CHAIN="$HOOKS/pre-push"
DEST="$HOOKS/hooks.d/pre-push/40-omp-kit-fresh-gate"
[ -x "$CHAIN" ] || { echo "install-pre-push-gate: expected executable chain runner: $CHAIN" >&2; exit 2; }
if ! grep -q 'hooks.d' "$CHAIN" || ! grep -q 'pre-push' "$CHAIN"; then
	echo "install-pre-push-gate: refusing to bypass an existing non-chain pre-push hook" >&2
	exit 2
fi
# Custody is enforced when work is edited/committed: the pre-commit member 50-omp-kit-board-reservations checks every
# staged path against other seats' exclusive reservations on the Board (ompkit-tnqyr.3). Agent Mail is removed from
# this path (J-2026-11-24-09): this installer never runs `am`, and moves any Agent Mail pre-commit/pre-push plugin and
# the storage-root bootstrap members that only served it into the repo's var/agent-tmp/hook-backups (never deleted).
# Publication judges the immutable shared-main snapshot, so no reservation member is installed on pre-push
# (SNAPSHOTPUB1 ompkit-v66l.14); history admission stays with 30-omp-kit-on-main.
# The chain runners themselves are plain hooks.d dispatchers an earlier install left behind; a repository without
# them is refused rather than guessed at.
for hook in pre-commit pre-push; do
	path="$HOOKS/$hook"
	[ -x "$path" ] || { echo "install-pre-push-gate: expected executable chain runner: $path" >&2; exit 2; }
	if ! grep -q 'hooks.d' "$path"; then
		echo "install-pre-push-gate: refusing to replace an existing non-chain $hook hook" >&2
		exit 2
	fi
done
mkdir -p "$(dirname "$DEST")" "$HOOKS/hooks.d/pre-commit"
cp "$ROOT/scripts/pre-push-gate.sh" "$DEST"
chmod +x "$DEST"
BOARD_MEMBER="$HOOKS/hooks.d/pre-commit/50-omp-kit-board-reservations"
cp "$ROOT/scripts/check-staged-board-reservations.sh" "$BOARD_MEMBER"
chmod +x "$BOARD_MEMBER"
BACKUP="$TARGET/var/agent-tmp/hook-backups"
for old in pre-commit/50-agent-mail.py pre-push/50-agent-mail.py pre-commit/10-omp-kit-storage-root pre-push/10-omp-kit-storage-root; do
	if [ -e "$HOOKS/hooks.d/$old" ]; then
		mkdir -p "$BACKUP"
		mv "$HOOKS/hooks.d/$old" "$BACKUP/$(printf '%s' "$old" | tr / -).$$"
		printf 'install-pre-push-gate: moved %s to %s\n' "$old" "$BACKUP"
	fi
done
printf 'installed pre-push fresh gate: %s\ninstalled board reservation member: %s\n' "$DEST" "$BOARD_MEMBER"
