#!/bin/sh
# check-staged-pysafe.sh — pre-commit member (ompkit-xa5s.34, PYSAFE1).
# Staged .py and executable inline Python in .sh/.ts add no new hang-prone
# finding: missing timeouts, inherited stdin, blocking waits, unguarded stdin,
# unbounded reads or loops. Suppressions need an inline reason. Judges the
# index git is about to commit (GIT_INDEX_FILE is respected, so `git commit
# --only` temporary indexes are judged) against HEAD: a finding is new when
# its (rule, scope, source text) occurs more often than in HEAD, so untouched
# pre-existing findings never block and new ones always do. The checker runs
# under `pysafe.py run` with a process-group deadline, so this member cannot
# hang a commit. pysafe_check.py and pysafe.py sit beside this file (the
# installer copies them; in the companion and in a kit release they are its
# siblings in scripts/); if either is missing, or python3 is older than 3.9,
# the commit is refused rather than passed unjudged. Exit 1 refuses.
# PYSAFE_GATE_TIMEOUT (whole seconds, default 60) sets the checker deadline.
set -u
budget=${PYSAFE_GATE_TIMEOUT:-60}
case "$budget" in
	'' | *[!0-9]* | 0) printf 'staged-pysafe: REFUSED: PYSAFE_GATE_TIMEOUT must be a positive whole number of seconds\n' >&2; exit 1 ;;
esac
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
root=$(git rev-parse --show-toplevel) || { printf 'staged-pysafe: not inside a work tree\n' >&2; exit 1; }
staged=$(git diff --cached --name-only --diff-filter=AMRT -- '*.py' '*.sh' '*.ts') || { printf 'staged-pysafe: cannot list staged paths\n' >&2; exit 1; }
[ -n "$staged" ] || exit 0
py=$(command -v python3) || { printf 'staged-pysafe: REFUSED: Python sources are staged and python3 is absent\n' >&2; exit 1; }
"$py" -c 'import sys; sys.exit(sys.version_info < (3, 9))' < /dev/null ||
	{ printf 'staged-pysafe: REFUSED: python3 >= 3.9 is required to judge staged Python sources\n' >&2; exit 1; }
for helper in pysafe.py pysafe_check.py pysafe_inline.py pysafe_inline_literals.py kitlib_ratchet_core.py; do
	[ -f "$here/$helper" ] || { printf 'staged-pysafe: REFUSED: %s is missing beside %s; rerun the kit hook installer\n' "$helper" "$0" >&2; exit 1; }
done
out=$("$py" -B "$here/pysafe.py" run --timeout "$budget" -- "$py" -B "$here/pysafe_check.py" --staged --repo "$root" < /dev/null 2>&1)
rc=$?
case "$rc" in
	0) exit 0 ;;
	1) printf 'staged-pysafe: REFUSED: staged Python sources add hang-prone code (fix it, or justify it inline with "# pysafe: <reason>")\n%s\n' "$out" >&2 ;;
	124) printf 'staged-pysafe: REFUSED: the checker exceeded %s s and was killed\n%s\n' "$budget" "$out" >&2 ;;
	*) printf 'staged-pysafe: REFUSED: the checker failed (exit %s)\n%s\n' "$rc" "$out" >&2 ;;
esac
exit 1
