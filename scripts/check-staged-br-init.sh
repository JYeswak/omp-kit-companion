#!/bin/sh
# check-staged-br-init.sh — pre-commit member (BRINITPIN1).
# Staged Python, JS/TS and shell sources must pin every br init to the fixture's
# own .beads/beads.db with --db or inline BEADS_DB. The checker uses native Python
# AST, the shared kitlib lexer and shell tokenizer; incomplete shell analysis fails
# closed. br_init_check.py, kitlib_ratchet_core.py and pysafe.py sit beside this
# wrapper (the installer copies them); missing helpers or Python < 3.9 refuse.
# The staged index is compared with HEAD, so untouched legacy findings do not block.
# BR_INIT_GATE_TIMEOUT (whole seconds, default 60) sets the checker deadline.
set -u
budget=${BR_INIT_GATE_TIMEOUT:-60}
case "$budget" in
	'' | *[!0-9]* | 0) printf 'staged-br-init: REFUSED: BR_INIT_GATE_TIMEOUT must be a positive whole number of seconds\n' >&2; exit 1 ;;
esac
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
root=$(git rev-parse --show-toplevel) || { printf 'staged-br-init: not inside a work tree\n' >&2; exit 1; }
staged=$(git diff --cached --name-only --diff-filter=AMRTD) || { printf 'staged-br-init: cannot list staged paths\n' >&2; exit 1; }
printf '%s\n' "$staged" | grep -Eq '\.(py|ts|tsx|js|mjs|cjs|sh|bash)$|(^|/)\.?[^/.]+$' || exit 0
py=$(command -v python3) || { printf 'staged-br-init: REFUSED: judged files are staged and python3 is absent\n' >&2; exit 1; }
"$py" -c 'import sys; sys.exit(sys.version_info < (3, 9))' < /dev/null ||
	{ printf 'staged-br-init: REFUSED: python3 >= 3.9 is required to judge staged files\n' >&2; exit 1; }
for helper in pysafe.py kitlib_ratchet_core.py br_init_check.py; do
	[ -f "$here/$helper" ] || { printf 'staged-br-init: REFUSED: %s is missing beside %s; rerun the kit hook installer\n' "$helper" "$0" >&2; exit 1; }
done
out=$("$py" -B "$here/pysafe.py" run --timeout "$budget" -- "$py" -B "$here/br_init_check.py" --staged --repo "$root" < /dev/null 2>&1)
rc=$?
case "$rc" in
	0) exit 0 ;;
	1) printf 'staged-br-init: REFUSED: staged files contain an unpinned br init (use --db <fixture/.beads/beads.db> or inline BEADS_DB for that path)\n%s\n' "$out" >&2 ;;
	124) printf 'staged-br-init: REFUSED: the checker exceeded %s s and was killed\n%s\n' "$budget" "$out" >&2 ;;
	*) printf 'staged-br-init: REFUSED: the checker failed (exit %s)\n%s\n' "$rc" "$out" >&2 ;;
esac
exit 1
