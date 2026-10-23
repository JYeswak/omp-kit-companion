#!/bin/sh
# check-staged-fragments.sh — pre-commit member (ompkit-1wgy, SHIFTLEFT1).
# Staged changelog fragments must be promotable: the push notes gate
# (check-pushed-notes.sh) folds CHANGELOG.md plus every changelog.d/*.md of
# the candidate and refuses on any fold error. This member writes the staged
# index (GIT_INDEX_FILE is respected, so `git commit --only` temporary indexes
# are judged) as an unreferenced probe commit on HEAD and runs the repo's own
# scripts/release-notes.sh fold over the probe tree. No ref moves. Runs only
# when a changelog.d/*.md is staged Added or Modified and the repo ships
# scripts/release-notes.sh. Exit 1 refuses the commit; an unborn HEAD passes.
set -u
root=$(git rev-parse --show-toplevel) || { printf 'staged-fragments: not inside a work tree\n' >&2; exit 1; }
git rev-parse -q --verify 'HEAD^{commit}' > /dev/null || exit 0
staged=$(git diff --cached --name-only --diff-filter=AM -- 'changelog.d/*.md') || { printf 'staged-fragments: cannot list staged paths\n' >&2; exit 1; }
[ -n "$staged" ] || exit 0
[ -f "$root/scripts/release-notes.sh" ] || exit 0
tree=$(git write-tree) || { printf 'staged-fragments: cannot write the staged tree\n' >&2; exit 1; }
probe=$(printf 'staged-fragments probe\n' | GIT_AUTHOR_NAME=probe GIT_AUTHOR_EMAIL=probe@invalid GIT_COMMITTER_NAME=probe GIT_COMMITTER_EMAIL=probe@invalid \
	git commit-tree "$tree" -p HEAD) || { printf 'staged-fragments: cannot write the probe commit\n' >&2; exit 1; }
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
[ -f "$here/kitlib-tmp.sh" ] || { printf 'staged-fragments: REFUSED: kitlib-tmp.sh missing beside %s; rerun scripts/install-commit-msg-bead.sh\n' "$(basename -- "$0")" >&2; exit 1; }
# shellcheck source=scripts/kitlib-tmp.sh
. "$here/kitlib-tmp.sh"
KITLIB_TMP_ROOT=${TMPDIR:-$root/var/agent-tmp} # tempsafe: picks the kitlib root only, kitlib_tmp below owns the dir
mkdir -p "$KITLIB_TMP_ROOT" || { printf 'staged-fragments: cannot make %s\n' "$KITLIB_TMP_ROOT" >&2; exit 1; }
scratch='' # assigned by kitlib_tmp via eval
kitlib_tmp scratch staged-fragments || { printf 'staged-fragments: cannot make a scratch dir\n' >&2; exit 1; }
validation="$scratch/validation"
mkdir -p "$validation/changelog.d"
paths=changelog.d
git cat-file -e "$probe:CHANGELOG.md" 2>/dev/null && paths="CHANGELOG.md changelog.d"
# shellcheck disable=SC2086
git archive "$probe" $paths | tar -x -C "$validation" || { printf 'staged-fragments: cannot extract the staged changelog\n' >&2; exit 1; }
# The validation dir is its own repository. Git exports GIT_DIR (and GIT_INDEX_FILE) to hooks; in a
# linked worktree that GIT_DIR is <repo>/.git/worktrees/<name>, and `git init` under it re-initializes
# the real repository as bare (core.bare=true in its shared config: ompkit-xa5s.41, the 2026-10-23
# companion flips after `omp-kit land --patch`). So neither the init nor the fold sees the hook's git env.
git_redirects='GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES'
# shellcheck disable=SC2086
(unset $git_redirects; git -C "$validation" init -q) || { printf 'staged-fragments: cannot init the validation dir\n' >&2; exit 1; }
# shellcheck disable=SC2086
if err=$(unset $git_redirects; cd "$validation" && sh "$root/scripts/release-notes.sh" fold 2>&1 >/dev/null); then
	exit 0
fi
printf 'staged-fragments: REFUSED: staged changelog fragments are not promotable; the push notes gate will refuse them\n%s\n' "$err" >&2
exit 1
