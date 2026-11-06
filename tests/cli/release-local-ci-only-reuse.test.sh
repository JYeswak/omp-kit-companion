#!/bin/sh
# CIONLY1 (J-2026-11-03-34/35): release-local requires the push-time ci-only PASS for the exact source tree, in its
# source stage, and never runs package-release.test.ts or kit-update.test.ts itself; with no record, or a FAIL
# record, it refuses at once (exit 4) naming the producer command. The check is cut out of release-local.sh (from its
# `# CIONLY1` comment to the `say "ci-only verdict` line) and run with that script's own die, say and bounded,
# against a real export and verdict store; `bun` and `timeout` are stubs that log any test launch. CIO_RELEASE_LOCAL
# names another release-local.sh (the planted negative: the script before this change runs both files instead).
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
set -u
KITREPO=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
REPO_TMP="$KITREPO/var/agent-tmp"
mkdir -p "$REPO_TMP"
# shellcheck source=scripts/kitlib-tmp.sh
. "$KITREPO/scripts/kitlib-tmp.sh"
# shellcheck source=tests/cli/ci-only-verdict-fixtures.sh
. "$KITREPO/tests/cli/ci-only-verdict-fixtures.sh"
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP release-local-ci-only-reuse-test || exit 1
TMP=$(cd "$TMP" && pwd -P)
pass=0
fail=0
ok() { if [ "$1" = 0 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s\n' "$2"; fi; }

RELEASE_LOCAL=${CIO_RELEASE_LOCAL:-$KITREPO/scripts/release-local.sh}
harness="$TMP/stage.sh"
{
	printf 'set -euo pipefail\n'
	grep -E '^(die|say)\(\) \{.*\}$' "$RELEASE_LOCAL"
	awk '/^bounded\(\) \{$/ { on = 1 } on { print } on && /^\}$/ { exit }' "$RELEASE_LOCAL"
	# shellcheck disable=SC2016 # the harness's own $1..$5, expanded when it runs
	printf 'stage() { say "stage $1"; }\nCHILD=""\nCI_PIDS=""\nROOT=$1 SRC=$2 SOURCE=$3 source_tree=$4 WORK=$5\n'
	awk '/^# CIONLY1 / { on = 1 } on { print } on && /^say "ci-only verdict / { exit }' "$RELEASE_LOCAL"
} >"$harness"
grep -q 'require-ci-only-pass' "$harness" && grep -q '^bounded() {$' "$harness" && grep -q '^die() {' "$harness"
ok $? "check-extracted: $(cat "$harness")"

repo="$TMP/repo"
cio_fixture "$repo" || exit 1
cio_stub_bin "$TMP/bin" || exit 1
export CIO_LOG="$TMP/bun.log" PATH="$TMP/bin:$PATH" TMPDIR="$TMP"
c1=$(git -C "$repo" rev-parse HEAD)
t1=$(git -C "$repo" rev-parse 'HEAD^{tree}')
n=0
# run_stage STORE: run the stage on a fresh export of c1, as release-local's source stage leaves it.
run_stage() {
	n=$((n + 1))
	src="$TMP/src.$n" work="$TMP/work.$n"
	mkdir -p "$src" "$work"
	git -C "$repo" archive "$c1" | tar -xf - -C "$src"
	: >"$CIO_LOG"
	stage_rc=0
	FULL_SUITE_VERDICT_CACHE_DIR=$1 bash "$harness" "$repo" "$src" "$c1" "$t1" "$work" >"$TMP/stage.$n.out" 2>&1 || stage_rc=$?
	stage_out=$(cat "$TMP/stage.$n.out")
	test_runs=$(grep -c '^test --timeout=120000 tests/cli/' "$CIO_LOG")
}
# record STORE [FAILING FILES]: the push-time verdict's record for c1, from its own export.
record() {
	export_dir="$TMP/judge.$1"
	mkdir -p "$export_dir"
	git -C "$repo" archive "$c1" | tar -xf - -C "$export_dir"
	printf '%s\n' "${2:-}" >"$TMP/bin/cio-fail"
	(cd "$export_dir" && python3 -B scripts/full-suite-verdict-store.py run-ci-only --repo "$repo" \
		--commit "$c1" --cache-dir "$TMP/$1") >"$TMP/record.$1.out" 2>&1
	rm -f "$TMP/bin/cio-fail"
}

# 1. A push-time PASS for the exact tree: reused, neither file runs, the export is not even git-initialized.
record store-pass
ok $? "push-time-pass-recorded: $(cat "$TMP/record.store-pass.out")"
run_stage "$TMP/store-pass"
[ "$stage_rc" = 0 ] && [ "$test_runs" = 0 ] && [ ! -e "$src/.git" ] \
	&& printf '%s\n' "$stage_out" | grep -Fxq "== ci-only verdict $t1: PASS (push time)"
ok $? "pass-record-proceeds-without-runs: rc=$stage_rc runs=$test_runs out=$stage_out"

# 2. No record: refused at once, naming the producer command; neither file runs here.
mkdir -p "$TMP/store-empty"
run_stage "$TMP/store-empty"
[ "$stage_rc" = 4 ] && [ "$test_runs" = 0 ] \
	&& printf '%s\n' "$stage_out" | grep -Fq "has no push-time ci-only PASS (MISS" \
	&& printf '%s\n' "$stage_out" | grep -Fq "produce it with: sh scripts/release-verdict.sh --commit $c1"
ok $? "no-record-refuses-without-runs: rc=$stage_rc runs=$test_runs out=$stage_out"

# 3. A push-time FAIL is never reused and never re-run here: refused at once.
record store-fail "package-release.test.ts"
run_stage "$TMP/store-fail"
[ "$stage_rc" = 4 ] && [ "$test_runs" = 0 ] && grep -Fq "CI-ONLY: VERDICT FAIL" "$TMP/record.store-fail.out" \
	&& printf '%s\n' "$stage_out" | grep -Fq "has no push-time ci-only PASS (FAIL"
ok $? "fail-record-refuses-without-runs: rc=$stage_rc runs=$test_runs out=$stage_out"

printf 'release-local-ci-only-reuse: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = 0 ]
