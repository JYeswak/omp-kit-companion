#!/bin/sh
# commit-msg-bead.sh — COMMIT1 commit-msg hook body (ompkit-2w7h).
# Refuses a commit whose message names no bead id that exists in the repo's
# tracker. Installed by scripts/install-commit-msg-bead.sh into the hooks.d
# chain. Git calls: commit-msg MSG_FILE [SOURCE [SHA]].
# Bead ids: full `ompkit-<token>` or short `rz5.<n>`; existence is checked
# with `br show` (rc 0 exists, rc 3 missing). Merge/template sources are
# exempt (their messages are generated); repos without a tracker are
# skipped, never blocked. Test seams: BEADS_DB overrides the tracker path,
# BR_BIN overrides the br binary under test.
set -u

FILE=${1:-}
SOURCE=${2:-}
case "$SOURCE" in
	merge|template) exit 0 ;;
esac
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
	exit 0
fi
BR=${BR_BIN:-br}
if [ -n "${BEADS_DB:-}" ]; then
	DB="$BEADS_DB"
else
	ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
	DB="$ROOT/.beads/beads.db"
	[ -f "$DB" ] || exit 0
fi
MSG=$(cat -- "$FILE" 2>/dev/null) || exit 0
CANDIDATES=$(printf '%s' "$MSG" | grep -oE '(ompkit-[A-Za-z0-9][A-Za-z0-9._-]*)|(rz5\.[0-9]+)' 2>/dev/null) || true
if [ -z "$CANDIDATES" ]; then
	printf 'commit-msg-bead: refusing commit with no bead id (full ompkit-<id> or rz5.<n>); see the bead workflow\n' >&2
	exit 4
fi
matched=0
for id in $CANDIDATES; do
	if "$BR" --db "$DB" show "$id" >/dev/null 2>&1; then
		matched=1
		break
	fi
done
if [ "$matched" = "1" ]; then
	exit 0
fi
printf 'commit-msg-bead: refusing commit: none of the named ids exists in %s\n' "$DB" >&2
exit 4
