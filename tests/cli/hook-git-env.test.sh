#!/bin/sh
# LANDBARE1: foreign validation repositories must never inherit hook selectors.
set -eu
SCRIPTS=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd -P)
# shellcheck source=scripts/kitlib-tmp.sh
. "$SCRIPTS/kitlib-tmp.sh"
kitlib_tmp TMP hook-git-env-test
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
for name in real decoy; do
 mkdir -p "$TMP/$name"
 git -C "$TMP/$name" -c init.templateDir= init -q
 git -C "$TMP/$name" config user.name Test
 git -C "$TMP/$name" config user.email test@invalid.example
 git -C "$TMP/$name" -c core.hooksPath=/dev/null commit -q --allow-empty -m root
 cp "$TMP/$name/.git/config" "$TMP/$name.config"
done
git -C "$TMP/decoy" worktree add -q --detach "$TMP/decoy-linked" HEAD
mkdir -p "$TMP/archive/changelog.d"
printf '# Changelog\n\n## [Unreleased]\n' > "$TMP/archive/CHANGELOG.md"
printf '### Security\n- Invalid category must be refused.\n' > "$TMP/archive/changelog.d/bad.md"
failed=0
for selector in GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES all; do
 case "$selector" in
 GIT_DIR) value=$(git -C "$TMP/decoy-linked" rev-parse --absolute-git-dir) ;;
 GIT_WORK_TREE) value=$TMP/decoy-linked ;;
 GIT_INDEX_FILE) value=$TMP/decoy/.git/index ;;
 GIT_COMMON_DIR) value=$TMP/decoy/.git ;;
 *) value=$TMP/decoy/.git/objects ;;
 esac
 out=$(
  if [ "$selector" = all ]; then
   linked_git=$(git -C "$TMP/decoy-linked" rev-parse --absolute-git-dir)
   set -- "GIT_DIR=$linked_git" "GIT_WORK_TREE=$TMP/decoy-linked" "GIT_INDEX_FILE=$TMP/decoy/.git/index" "GIT_COMMON_DIR=$TMP/decoy/.git" "GIT_OBJECT_DIRECTORY=$TMP/decoy/.git/objects" "GIT_ALTERNATE_OBJECT_DIRECTORIES=$TMP/decoy/.git/objects"
  else set -- "$selector=$value"; fi
  env "$@" sh "$SCRIPTS/check-pushed-notes.sh" --repo "$TMP/real" --base HEAD --tip HEAD --archive-dir "$TMP/archive" 2>&1
 ) && rc=0 || rc=$?
 case "$out" in *'unknown category "Security"'*) reached=yes ;; *) reached=no ;; esac
 if [ "$rc" != 1 ] || [ "$reached" != yes ]; then
  printf 'FAIL pushed-notes %s: validation not reached rc=%s\n%s\n' "$selector" "$rc" "$out"
  failed=1
 fi
 for name in real decoy; do
  if ! cmp -s "$TMP/$name.config" "$TMP/$name/.git/config" || [ "$(git -C "$TMP/$name" config --get core.bare)" != false ]; then
   printf 'FAIL pushed-notes %s: %s config changed\n' "$selector" "$name"
   failed=1
  fi
 done
 printf 'checked pushed-notes %s\n' "$selector"
done
mkdir -p "$TMP/real/scripts"
cp "$SCRIPTS/release-notes.sh" "$SCRIPTS/release-notes.ts" "$TMP/real/scripts/"
printf '# Changelog\n\n## [Unreleased]\n' > "$TMP/real/CHANGELOG.md"
git -C "$TMP/real" add scripts CHANGELOG.md
git -C "$TMP/real" -c core.hooksPath=/dev/null commit -qm validator
git -C "$TMP/real" worktree add -q --detach "$TMP/real-linked" HEAD
mkdir -p "$TMP/real-linked/changelog.d"
printf '### Security\n- Invalid category.\n' > "$TMP/real-linked/changelog.d/bad.md"
git -C "$TMP/real-linked" add changelog.d
linked_git=$(git -C "$TMP/real-linked" rev-parse --absolute-git-dir)
for selector in GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES all; do
 out=$(
  cd "$TMP/real-linked"
  set -- "GIT_DIR=$linked_git"
  if [ "$selector" = GIT_WORK_TREE ] || [ "$selector" = all ]; then set -- "$@" "GIT_WORK_TREE=$TMP/real-linked"; fi
  if [ "$selector" = GIT_INDEX_FILE ] || [ "$selector" = all ]; then set -- "$@" "GIT_INDEX_FILE=$linked_git/index"; fi
  if [ "$selector" = GIT_COMMON_DIR ] || [ "$selector" = all ]; then set -- "$@" "GIT_COMMON_DIR=$TMP/real/.git"; fi
  if [ "$selector" = GIT_OBJECT_DIRECTORY ] || [ "$selector" = all ]; then set -- "$@" "GIT_OBJECT_DIRECTORY=$TMP/real/.git/objects"; fi
  if [ "$selector" = GIT_ALTERNATE_OBJECT_DIRECTORIES ] || [ "$selector" = all ]; then set -- "$@" "GIT_ALTERNATE_OBJECT_DIRECTORIES=$TMP/real/.git/objects"; fi
  env "$@" sh "$SCRIPTS/check-staged-fragments.sh" 2>&1
 ) && rc=0 || rc=$?
 case "$out" in *'unknown category "Security"'*) reached=yes ;; *) reached=no ;; esac
 if [ "$rc" != 1 ] || [ "$reached" != yes ] ||
    ! cmp -s "$TMP/real.config" "$TMP/real/.git/config" ||
    ! cmp -s "$TMP/decoy.config" "$TMP/decoy/.git/config" ||
    [ "$(git -C "$TMP/real" config --get core.bare)" != false ]; then
  printf 'FAIL staged-fragments %s rc=%s\n%s\n' "$selector" "$rc" "$out"
  failed=1
 fi
 printf 'checked staged-fragments %s\n' "$selector"
done
# Exercise the installed fresh member's real startup scrub before its foreign
# archive operations. Stop before its suite dispatcher; no suite result is
# fabricated. The downstream Git operation is real, not a command echo.
python3 - "$SCRIPTS" "$TMP" <<'PY'
import os
from pathlib import Path
import sys

scripts, tmp = map(Path, sys.argv[1:])
sys.path.insert(0, str(scripts))
from kitlib_run import run as bounded_run
source = (scripts / "pre-push-gate.sh").read_text()
startup, separator, _ = source.partition("IFS=' '\n")
assert separator, "fresh member startup boundary missing"
redirects = {
    "GIT_DIR": bounded_run(
        ["git", "-C", str(tmp / "real-linked"), "rev-parse", "--absolute-git-dir"],
        deadline_s=30).stdout.decode().strip(),
    "GIT_WORK_TREE": str(tmp / "real-linked"),
    "GIT_INDEX_FILE": str(tmp / "real-linked" / ".git"),
    "GIT_COMMON_DIR": str(tmp / "real" / ".git"),
    "GIT_OBJECT_DIRECTORY": str(tmp / "real" / ".git" / "objects"),
    "GIT_ALTERNATE_OBJECT_DIRECTORIES": str(tmp / "real" / ".git" / "objects"),
}
# Use the linked worktree's real index, not its .git pointer file.
redirects["GIT_INDEX_FILE"] = str(Path(redirects["GIT_DIR"]) / "index")
for selector in [*redirects, "all"]:
    env = dict(os.environ)
    env["GIT_DIR"] = redirects["GIT_DIR"]
    env.update(redirects if selector == "all" else {selector: redirects[selector]})
    foreign = tmp / ("fresh-archive-" + selector)
    foreign.mkdir()
    configs = {name: (tmp / name / ".git" / "config").read_bytes()
               for name in ("real", "decoy")}
    result = bounded_run(["sh", "-s", "--", str(foreign)],
        stdin=(startup + 'git -C "$1" init -q\n').encode(),
        cwd=tmp / "real-linked", env=env, deadline_s=30)
    assert result.rc == 0, result.stdout + result.stderr
    assert (foreign / ".git" / "config").is_file(), selector
    for name, before in configs.items():
        assert (tmp / name / ".git" / "config").read_bytes() == before, (selector, name)
        bare = bounded_run(
            ["git", "-C", str(tmp / name), "config", "--get", "core.bare"], deadline_s=30)
        assert bare.rc == 0 and bare.stdout.strip() == b"false", (selector, name, bare)
    print("checked fresh-member startup foreign-init", selector)
PY
[ "$failed" = 0 ]
