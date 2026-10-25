#!/bin/sh
# SOURCEGATE1: installed member judges the index, with paired controls.
set -u
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
SCRIPTS=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)
. "$SCRIPTS/kitlib-tmp.sh"
kitlib_tmp TMP staged-sources-test || exit 1
pass=0
fail=0
check() {
 if [ "$1" = "$2" ]; then pass=$((pass + 1));
 else fail=$((fail + 1)); printf 'FAIL %s: rc=%s expected=%s\n%s\n' "$3" "$1" "$2" "$4"; fi
}
for mode in opted plain; do
 R="$TMP/$mode"
 mkdir -p "$R"
 git -C "$R" init -q
 git -C "$R" config user.email test@invalid.example
 git -C "$R" config user.name Test
 git -C "$R" -c core.hooksPath=/dev/null commit -q --allow-empty -m '[test] root'
 out=$(sh "$SCRIPTS/install-commit-msg-bead.sh" "$R" 2>&1)
 check "$?" 0 "$mode-install" "$out"
 member="$R/.git/hooks/hooks.d/pre-commit/52-omp-kit-staged-sources"
 if [ "$mode" = opted ]; then
  mkdir -p "$R/.omp"
  printf 'globs = ["*.md"]\n' > "$R/.omp/sources.toml"
  git -C "$R" add .omp/sources.toml
 fi
 printf '[standard reading]\n' > "$R/plan.md"
 git -C "$R" add plan.md
 # Working tree is clean text, but the index still holds the memory marker.
 printf 'clean working tree\n' > "$R/plan.md"
 out=$(cd "$R" && sh "$member" 2>&1)
 rc=$?
 if [ "$mode" = opted ]; then
  check "$rc" 1 opted-staged-refused "$out"
  case "$out" in *MEMORY_CITATION*) check 0 0 named-code "$out";; *) check 1 0 named-code "$out";; esac
 else
  check "$rc" 0 no-opt-in-passes "$out"
 fi
 git -C "$R" add plan.md
 out=$(cd "$R" && sh "$member" 2>&1)
 check "$?" 0 "$mode-clean-passes" "$out"
done
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
