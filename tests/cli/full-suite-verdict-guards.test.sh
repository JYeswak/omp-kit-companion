#!/bin/sh
# shellcheck disable=SC1091
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
# full-suite-verdict-guards.test.sh — JUDGEIDENT1 and SUITETREE1 (ompkit-1ra0d.109, the 13100edb20 verdict incident).
# A main-role verdict qualifies a tree with that tree's own judge and its own declared suite. Planted 1: the staging
# directory's judging closure differs from the scripts being run (a verdict launched from a checkout on another HEAD)
# -> JUDGE_NOT_CANDIDATE before any suite runs. Planted 2: the staging directory holds a test file the commit does not
# contain (an untracked leftover passed as --archive-dir) -> SUITE_NOT_IN_COMMIT naming it, before any suite runs.
# Control: an exact extract of the commit passes both guards and the verdict runs the fixture's one suite.
set -u
FULL_SUITE_JOBS=1
export FULL_SUITE_JOBS
KITROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
# FULL_SUITE_VERDICT_UNDER_TEST lets a planted-negative run point at a scratch copy of the judge.
VERDICT_REL=scripts/full-suite-verdict.sh
REPO_TMP="$KITROOT_DIR/var/agent-tmp"
mkdir -p "$REPO_TMP"
# shellcheck source=scripts/kitlib-tmp.sh
. "$KITROOT_DIR/scripts/kitlib-tmp.sh"
KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP full-suite-verdict-guards-test || exit 1
TMP=$(cd "$TMP" && pwd -P)
pass=0
fail=0
ok() { if [ "$1" = 0 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s\n' "$2"; fi; }

# The fixture commit carries the real judging closure (so identity is computable) and one stub python suite.
repo="$TMP/repo"
mkdir -p "$repo/tests/cli"
closure=$(cd "$KITROOT_DIR" && python3 -B scripts/suite-metrics.py judging-files) || { echo "cannot list the judging closure"; exit 1; }
for path in $closure; do
	mkdir -p "$repo/$(dirname "$path")"
	cp "$KITROOT_DIR/$path" "$repo/$path"
done
printf "print('GUARDS_STUB_RAN', flush=True)\n" >"$repo/tests/cli/fixture_test.py"
git -C "$repo" init -q
git -C "$repo" config user.name "JUDGEIDENT1 test"
git -C "$repo" config user.email "judgeident1@example.invalid"
git -C "$repo" add -A
git -C "$repo" commit -q -m "[test] JUDGEIDENT1 fixture"
sha=$(git -C "$repo" rev-parse HEAD)

extract() { mkdir -p "$TMP/$1" && git -C "$repo" archive "$sha" | tar -xf - -C "$TMP/$1"; }

# run LABEL ARCHIVE: the fixture's own judge against ARCHIVE as --archive-dir; rc in $rc, output in $TMP/LABEL.out.
run() {
	rc=0
	(cd "$repo" && OMP_KIT_OMP_SRC_FETCH=0 sh "$VERDICT_REL" --repo "$repo" --commit "$sha" --judge-role main \
		--archive-dir "$2" --cache-dir "$TMP/$1.cache") >"$TMP/$1.out" 2>&1 || rc=$?
}

extract control
run control "$TMP/control"
[ "$rc" = 0 ] && grep -q '^FULL-SUITE: VERDICT PASS ' "$TMP/control.out" && grep -q '^full-suite: global timing-split pool' "$TMP/control.out" \
	&& ! grep -q 'JUDGE_NOT_CANDIDATE\|SUITE_NOT_IN_COMMIT' "$TMP/control.out"
ok $? "control-exact-extract-passes: rc=$rc out=$(tail -n 12 "$TMP/control.out")"

extract drift
printf '\n# drift: this staging directory is not the judge being run\n' >>"$TMP/drift/scripts/suite-metrics.py"
run drift "$TMP/drift"
[ "$rc" != 0 ] && grep -q 'JUDGE_NOT_CANDIDATE' "$TMP/drift.out" && ! grep -q 'global timing-split pool\|VERDICT PASS' "$TMP/drift.out"
ok $? "judge-not-candidate-refused-before-any-suite: rc=$rc out=$(tail -n 12 "$TMP/drift.out")"

extract leftover
printf "print('LEFTOVER_RAN', flush=True)\n" >"$TMP/leftover/tests/cli/leftover_test.py"
run leftover "$TMP/leftover"
[ "$rc" != 0 ] && grep -q 'SUITE_NOT_IN_COMMIT' "$TMP/leftover.out" && grep -q 'tests/cli/leftover_test.py' "$TMP/leftover.out" \
	&& ! grep -q 'global timing-split pool\|VERDICT PASS' "$TMP/leftover.out"
ok $? "untracked-leftover-refused-by-name-before-any-suite: rc=$rc out=$(tail -n 12 "$TMP/leftover.out")"

# A tree that carries no judging closure at all (a fixture, never a release) has no identity to compare: not refused.
extract bare
rm -f "$TMP/bare/scripts/suite-metrics.py"
run bare "$TMP/bare"
[ "$rc" = 0 ] && grep -q '^FULL-SUITE: VERDICT PASS ' "$TMP/bare.out" && ! grep -q 'JUDGE_NOT_CANDIDATE' "$TMP/bare.out"
ok $? "closure-less-fixture-tree-is-not-refused: rc=$rc out=$(tail -n 12 "$TMP/bare.out")"

kitlib_tmp_cleanup "$TMP" 2>/dev/null || :
printf 'full-suite-verdict-guards: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = 0 ]
