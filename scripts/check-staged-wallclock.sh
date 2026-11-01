#!/bin/sh
# check-staged-wallclock.sh -- pre-commit member (ompkit-qf9fk, WALLCLOCK1).
# Staged test files add no new line whose pass rides on a small fixed wall-clock bound (a child deadline or
# spawn timeout under 10 s, an elapsed-time toBeLessThan) unless the line is annotated
# `wallclock: p99=<measured> headroom=<factor>`. Tonight's 0.2.83 verdicts failed only on such bounds at load
# 20-36 (2 s, 3 s, 5 s, 10 s). Writes the staged index (GIT_INDEX_FILE is respected, so `git commit --only`
# is judged as committed) as an unreferenced probe commit on HEAD and runs wallclock_check.py, installed
# beside this member, over HEAD..probe: untouched offenders never block, new ones always do. Exit 1 refuses.
set -u
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
root=$(git rev-parse --show-toplevel) || { printf 'staged-wallclock: not inside a work tree\n' >&2; exit 1; }
git rev-parse -q --verify 'HEAD^{commit}' > /dev/null || exit 0
staged=$(git diff --cached --name-only --diff-filter=AM) || { printf 'staged-wallclock: cannot list staged paths\n' >&2; exit 1; }
printf '%s\n' "$staged" | grep -Eq '^tests/.*[.](ts|js|mjs|sh|py)$' || exit 0
checker="$here/wallclock_check.py"
[ -f "$checker" ] || { printf 'staged-wallclock: REFUSED: wallclock_check.py is missing beside this member\n' >&2; exit 1; }
tree=$(git write-tree) || { printf 'staged-wallclock: cannot write the staged tree\n' >&2; exit 1; }
probe=$(printf 'staged-wallclock probe\n' | GIT_AUTHOR_NAME=probe GIT_AUTHOR_EMAIL=probe@invalid GIT_COMMITTER_NAME=probe GIT_COMMITTER_EMAIL=probe@invalid \
	git commit-tree "$tree" -p HEAD) || { printf 'staged-wallclock: cannot write the probe commit\n' >&2; exit 1; }
cd "$here" || exit 1
exec python3 -B pysafe.py run --timeout 120 -- python3 -B wallclock_check.py --repo "$root" --base HEAD --head "$probe"
