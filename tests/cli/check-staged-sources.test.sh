#!/bin/sh
# SOURCEGATE1: installed member judges the index, with paired controls.
set -u
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
SCRIPTS=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)
# shellcheck source=scripts/kitlib-tmp.sh
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
 if [ "$mode" = opted ]; then
  # HEAD's allowance names the old URL, not one interchangeable link.
  printf '{"plan.md":{"UNREGISTERED_LINK":["https://old.example/a"]}}\n' > "$R/.omp/sources-baseline.json"
  printf 'https://old.example/a\n' > "$R/plan.md"
  git -C "$R" add .omp/sources-baseline.json plan.md
  git -C "$R" -c core.hooksPath=/dev/null commit -qm '[test] baseline fixture'
  printf 'https://old.example/a\n\n' > "$R/plan.md"
  git -C "$R" add plan.md
  out=$(cd "$R" && sh "$member" 2>&1)
  check "$?" 0 baseline-exact-control "$out"
  printf 'https://new.example/b\n' > "$R/plan.md"
  git -C "$R" add plan.md
  out=$(cd "$R" && sh "$member" 2>&1)
  check "$?" 1 baseline-substitution-refused "$out"
  printf '{"plan.md":{"UNREGISTERED_LINK":["https://new.example/b"]}}\n' > "$R/.omp/sources-baseline.json"
  git -C "$R" add .omp/sources-baseline.json
  out=$(cd "$R" && sh "$member" 2>&1)
  check "$?" 1 baseline-identity-raise-refused "$out"
  case "$out" in *BASELINE_RAISED*) check 0 0 baseline-raise-code "$out";; *) check 1 0 baseline-raise-code "$out";; esac
  printf '{}\n' > "$R/.omp/sources-baseline.json"
  printf 'clean\n' > "$R/plan.md"
  git -C "$R" add .omp/sources-baseline.json plan.md
  out=$(cd "$R" && sh "$member" 2>&1)
  check "$?" 0 baseline-shrink-control "$out"
  mkdir -p "$R/docs/research"
  printf '%s\n' '{"schema":1,"id":"fixture","url":"https://example.org","final_url":"https://example.org","quotes":[]}' > "$R/docs/research/sources.jsonl"
  printf '[src:fixture]\n' > "$R/plan.md"
  git -C "$R" add docs/research/sources.jsonl plan.md
  out=$(cd "$R" && sh "$member" 2>&1)
  check "$?" 1 application-missing-refused "$out"
  case "$out" in *APPLICATION_MISSING*) check 0 0 application-code "$out";; *) check 1 0 application-code "$out";; esac
  printf '%s\n' '| Source | Decision | Artifact | Status | Gap bead |' '|---|---|---|---|---|' '| fixture | Use verified words | plan.md:1 | cited | ompkit-663q4 |' > "$R/docs/research/APPLICATION.md"
  out=$(cd "$R" && sh "$member" 2>&1)
  check "$?" 1 unstaged-application-still-refused "$out"
  git -C "$R" add docs/research/APPLICATION.md
  out=$(cd "$R" && sh "$member" 2>&1)
  check "$?" 0 staged-application-control "$out"
  printf '| broken working tree |\n' > "$R/docs/research/APPLICATION.md"
  out=$(cd "$R" && sh "$member" 2>&1)
  check "$?" 0 application-index-not-working-tree "$out"
 fi
done
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
