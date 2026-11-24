#!/bin/sh
# check-staged-board-reservations.sh — pre-commit member (ompkit-tnqyr.3, BOARDLIVE1).
# Every staged path is judged against the Board's
# reservations for this project (omp-kit reservations --check-staged): a path another
# holder has reserved refuses the commit; paths you hold or nobody holds pass. The Board
# lookup keeps a last-good snapshot and, with none, refuses (fail closed).
# The Board is the only reservation backend; no Agent Mail plugin runs beside it.
# OMP_KIT_BIN overrides the omp-kit command (tests). Without it, a repository that carries src/cli.ts (the companion, its
# checkouts and the fresh-gate archive of a candidate) judges with its own CLI, so the member and the verb it calls ship
# together; any other repository uses the installed omp-kit. Exit 1 refuses.
set -u
root=$(git rev-parse --show-toplevel) || { printf 'staged-board-reservations: not inside a work tree\n' >&2; exit 1; }
kit=${OMP_KIT_BIN:-}
if [ -z "$kit" ]; then
	if [ -f "$root/src/cli.ts" ] && command -v bun > /dev/null 2>&1; then kit="bun $root/src/cli.ts"; else kit=omp-kit; fi
fi
# shellcheck disable=SC2086
out=$($kit reservations --check-staged --project "$root" --json < /dev/null 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then
	printf 'staged-board-reservations: REFUSED: staged paths are reserved by another holder or the Board is unjudgeable\n%s\n' "$out" >&2
	exit 1
fi
exit 0
