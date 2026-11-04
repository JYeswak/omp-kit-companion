#!/bin/sh
# shellcheck disable=SC1091
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
# full-suite-verdict-repo-path.test.sh — VERDICTREPOABS1 (ompkit-fp72.120.16.189).
# full-suite-verdict.sh resolves --repo to an absolute physical path before any chdir. Planted: --repo . from the
# fixture root runs its one stub suite instead of failing on a relative kitlib-tmp.sh path. Control: an absolute
# --repo runs the same way. Refusal: a missing --repo exits nonzero and names it, with no suite run.
set -u
FULL_SUITE_JOBS=1
export FULL_SUITE_JOBS
KITROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
# FULL_SUITE_VERDICT_UNDER_TEST lets a planted-negative run point at a scratch copy of the judge.
VERDICT=${FULL_SUITE_VERDICT_UNDER_TEST:-"$KITROOT_DIR/scripts/full-suite-verdict.sh"}
REPO_TMP="$KITROOT_DIR/var/agent-tmp"
mkdir -p "$REPO_TMP"
# shellcheck source=scripts/kitlib-tmp.sh
. "$KITROOT_DIR/scripts/kitlib-tmp.sh"
KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP full-suite-verdict-repo-path-test || exit 1
TMP=$(cd "$TMP" && pwd -P)
pass=0
fail=0
ok() { if [ "$1" = 0 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s\n' "$2"; fi; }

repo="$TMP/repo"
mkdir -p "$repo/scripts" "$repo/tests/cli"
cp "$KITROOT_DIR/scripts/kitlib-tmp.sh" "$repo/scripts/kitlib-tmp.sh"
printf '%s\n' "print('REPOABS_STUB_RAN', flush=True)" >"$repo/tests/cli/fixture_test.py"
git -C "$repo" init -q
git -C "$repo" config user.name "VERDICTREPOABS1 test"
git -C "$repo" config user.email "verdictrepoabs1@example.invalid"
git -C "$repo" add -A
git -C "$repo" commit -q -m "[test] VERDICTREPOABS1 fixture"

# run LABEL REPO_ARG: run the verdict from the fixture root with its own cache; rc in $rc, output in $TMP/LABEL.out.
run() {
	rc=0
	(cd "$repo" && KITROOT=$KITROOT_DIR OMP_KIT_OMP_SRC_FETCH=0 sh "$VERDICT" --repo "$2" --commit HEAD \
		--cache-dir "$TMP/$1.cache") >"$TMP/$1.out" 2>&1 || rc=$?
}

run relative .
! grep -Fq 'kitlib-tmp.sh: No such file or directory' "$TMP/relative.out" && [ "$rc" = 0 ] \
	&& grep -q '^FULL-SUITE: VERDICT PASS .* python=1 ' "$TMP/relative.out"
ok $? "relative-repo-runs-suite: rc=$rc out=$(cat "$TMP/relative.out")"

run absolute "$repo"
[ "$rc" = 0 ] && grep -q '^FULL-SUITE: VERDICT PASS .* python=1 ' "$TMP/absolute.out"
ok $? "absolute-repo-unchanged: rc=$rc out=$(cat "$TMP/absolute.out")"

run missing "$TMP/no-such-repo"
[ "$rc" != 0 ] && grep -Fq -- "--repo $TMP/no-such-repo is not a directory" "$TMP/missing.out"
ok $? "missing-repo-refused: rc=$rc out=$(cat "$TMP/missing.out")"

kitlib_tmp_cleanup "$TMP" 2>/dev/null || :
printf 'full-suite-verdict-repo-path: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = 0 ]
