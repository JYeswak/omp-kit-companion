#!/bin/sh
# check-staged-imports.sh — pre-commit member (ompkit-1wgy, SHIFTLEFT1).
# The commit about to be made must import only files present in its own tree.
# Writes the staged index (GIT_INDEX_FILE is respected, so `git commit --only`
# temporary indexes are judged) as an unreferenced probe commit on HEAD and
# runs check-commit-imports.sh over HEAD..probe. No ref moves. Before this,
# commits importing untracked files passed every commit hook and were refused
# only at push, after poisoning the unpublished history (60366a8, dead2a62b9).
# Exit 1 refuses the commit; an unborn HEAD passes (nothing to compare).
set -u
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
root=$(git rev-parse --show-toplevel) || { printf 'staged-imports: not inside a work tree\n' >&2; exit 1; }
git rev-parse -q --verify 'HEAD^{commit}' > /dev/null || exit 0
tree=$(git write-tree) || { printf 'staged-imports: cannot write the staged tree\n' >&2; exit 1; }
probe=$(printf 'staged-imports probe\n' | GIT_AUTHOR_NAME=probe GIT_AUTHOR_EMAIL=probe@invalid GIT_COMMITTER_NAME=probe GIT_COMMITTER_EMAIL=probe@invalid \
	git commit-tree "$tree" -p HEAD) || { printf 'staged-imports: cannot write the probe commit\n' >&2; exit 1; }
if out=$(sh "$here/check-commit-imports.sh" --repo "$root" --base HEAD --tip "$probe" 2>&1); then
	exit 0
fi
printf 'staged-imports: REFUSED: a staged file imports a path that is not staged or committed\n%s\n' "$out" >&2
exit 1
