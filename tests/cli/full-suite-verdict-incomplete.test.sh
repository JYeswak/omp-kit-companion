#!/bin/sh
# shellcheck disable=SC1091
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
# full-suite-verdict-incomplete.test.sh — FULLSUITELOG1 (ompkit-lrbd.6).
# A suite run that ends without complete evidence is non-pass, caches no verdict, and keeps its
# output at the printed <tree>.incomplete.log path. A complete run still records <tree>.log plus
# the <tree>.json verdict.
set -u

KITROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
# FULL_SUITE_VERDICT_UNDER_TEST lets a planted-negative run point at a scratch copy of the judge.
VERDICT=${FULL_SUITE_VERDICT_UNDER_TEST:-"$KITROOT_DIR/scripts/full-suite-verdict.sh"}
REPO_TMP="$KITROOT_DIR/var/agent-tmp"
mkdir -p "$REPO_TMP"
# shellcheck source=scripts/kitlib-tmp.sh
. "$KITROOT_DIR/scripts/kitlib-tmp.sh"
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP full-suite-verdict-incomplete-test || exit 1

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }
not_ok() { fail=$((fail + 1)); echo "not ok - $1"; }

# mkrepo_begin NAME: empty fixture tree; addfile REL BODY adds files; mkrepo_commit commits them.
mkrepo_begin() {
	repo="$TMP/$1"
	rm -rf "$repo" "$repo.cache"
	mkdir -p "$repo/scripts" "$repo/tests/cli"
	cp "$KITROOT_DIR/scripts/kitlib-tmp.sh" "$repo/scripts/kitlib-tmp.sh"
}
addfile() { mkdir -p "$(dirname "$repo/$1")"; printf '%s\n' "$2" >"$repo/$1"; }
mkrepo_commit() {
	git -C "$repo" init -q
	git -C "$repo" config user.name "FULLSUITELOG1 test"
	git -C "$repo" config user.email "fullsuitelog1@example.invalid"
	git -C "$repo" add -A
	git -C "$repo" commit -q -m "[test] FULLSUITELOG1 fixture"
}
# mkrepo NAME PY_BODY: fixture repo whose candidate commit holds one python suite.
mkrepo() {
	mkrepo_begin "$1"
	addfile tests/cli/fixture_test.py "$2"
	mkrepo_commit
}

run_verdict() {
	out="$TMP/$1.out"
	KITROOT=$KITROOT_DIR OMP_KIT_OMP_SRC_FETCH=0 sh "$VERDICT" --repo "$repo" --commit HEAD --cache-dir "$repo.cache" >"$out" 2>&1
	rc=$?
	tree=$(git -C "$repo" rev-parse 'HEAD^{tree}')
}

# Incomplete: the python suite prints a marker, then SIGKILLs the runner loop that would print
# its GREEN/RED line, so the run never accounts for it.
mkrepo incomplete 'import os, signal
print("FULLSUITELOG1-MARKER before runner death", flush=True)
os.kill(os.getppid(), signal.SIGKILL)'
run_verdict incomplete
cache="$repo.cache"
if [ "$rc" -ne 0 ]; then ok "incomplete run exits non-pass (rc=$rc)"; else not_ok "incomplete run exited 0"; fi
if [ ! -e "$cache/$tree.json" ]; then ok "incomplete run caches no verdict"; else not_ok "incomplete run cached $cache/$tree.json"; fi
if [ ! -e "$cache/$tree.log" ]; then ok "incomplete run writes no reusable <tree>.log"; else not_ok "incomplete run left $cache/$tree.log"; fi
if [ ! -e "$cache/$tree.running.log" ]; then ok "incomplete run leaves no running log"; else not_ok "running log left behind"; fi
inc="$cache/$tree.incomplete.log"
if grep -F "partial log: $inc" "$out" >/dev/null; then ok "RED line prints the incomplete log path"; else not_ok "RED line lacks the incomplete log path"; cat "$out"; fi
if [ -f "$inc" ] && grep -F 'FULLSUITELOG1-MARKER before runner death' "$inc" >/dev/null; then
	ok "incomplete log holds the suite output"
else
	not_ok "incomplete log missing or lacks suite output"
fi

# Control: a complete run records <tree>.log plus the cached verdict.
mkrepo complete 'print("FULLSUITELOG1-CONTROL ok")'
run_verdict complete
cache="$repo.cache"
if [ "$rc" -eq 0 ]; then ok "complete run passes"; else not_ok "complete run rc=$rc"; cat "$out"; fi
if [ -f "$cache/$tree.json" ] && grep -F '"verdict": "PASS"' "$cache/$tree.json" >/dev/null; then ok "complete run caches PASS verdict"; else not_ok "complete run cached no PASS verdict"; fi
if grep -F 'FULLSUITELOG1-CONTROL ok' "$cache/$tree.log" >/dev/null 2>&1; then ok "complete run keeps <tree>.log"; else not_ok "complete run has no <tree>.log"; fi
if [ ! -e "$cache/$tree.incomplete.log" ]; then ok "complete run writes no incomplete log"; else not_ok "complete run wrote an incomplete log"; fi

# (a) Nested markers: a shell suite that itself prints the runner's marker lines (as a nested
# fresh-gate or bun fixture inside a test does) and exits 0. They must not count: complete PASS.
mkrepo_begin nested
addfile tests/cli/nested.test.sh 'echo "GREEN script-suite tests/cli/not-a-suite.test.sh"
echo "GREEN python-suite tests/cli/not_a_suite_test.py"
echo " 0 fail"
exit 0'
addfile tests/cli/fixture_test.py 'print("FULLSUITELOG1-NESTED ok")'
mkrepo_commit
run_verdict nested
cache="$repo.cache"
if [ "$rc" -eq 0 ] && grep -F 'VERDICT PASS' "$out" >/dev/null && grep -F 'shell=1 python=1' "$out" >/dev/null; then
	ok "nested marker lines are not counted: complete PASS"
else
	not_ok "nested markers corrupted the verdict (rc=$rc)"; cat "$out"
fi
if [ -f "$cache/$tree.json" ] && grep -F '"verdict": "PASS"' "$cache/$tree.json" >/dev/null; then ok "nested-marker run caches PASS"; else not_ok "nested-marker run cached no PASS"; fi
if [ ! -e "$cache/$tree.running.log.status" ] && [ ! -e "$cache/$tree.running.log.bun" ]; then ok "runner side files removed"; else not_ok "runner side files left in cache"; fi

# (b) Masking: the bun phase has a real failing test; a later shell suite prints a nested bun
# summary claiming ' 0 fail'. The verdict must be FAIL, taken from the bun phase's own output.
if command -v bun >/dev/null 2>&1; then
	mkrepo_begin masked
	addfile tests/cli/real.test.ts 'import { expect, test } from "bun:test";
test("FULLSUITELOG1 real failure", () => { expect(1).toBe(2); });'
	addfile tests/cli/later.test.sh 'echo " 1 pass"
echo " 0 fail"
echo "Ran 1 test across 1 file. [5.00ms]"
exit 0'
	mkrepo_commit
	run_verdict masked
	cache="$repo.cache"
	if [ "$rc" -ne 0 ] && grep -F 'VERDICT FAIL' "$out" >/dev/null && grep -F 'bun_fail=1' "$out" >/dev/null; then
		ok "a real bun failure is not masked by a later nested ' 0 fail' (rc=$rc)"
	else
		not_ok "nested bun summary masked the real failure (rc=$rc)"; cat "$out"
	fi
	if [ -f "$cache/$tree.json" ] && grep -F '"verdict": "FAIL"' "$cache/$tree.json" >/dev/null; then ok "masked run caches FAIL"; else not_ok "masked run cached no FAIL"; fi

	# (c) A bun phase cut off by the suite deadline still leaves its partial output in the kept
	# incomplete log: the dying runner copies it, or finish_logs appends it when the runner was
	# killed before it could.
	mkrepo_begin bunslow
	addfile tests/cli/slow.test.ts 'import { test } from "bun:test";
test("FULLSUITELOG1 slow", async () => { console.log("FULLSUITELOG1-BUNPARTIAL"); await Bun.sleep(60000); }, 120000);'
	mkrepo_commit
	FULL_SUITE_TIMEOUT_SECS=4; export FULL_SUITE_TIMEOUT_SECS
	run_verdict bunslow
	unset FULL_SUITE_TIMEOUT_SECS
	cache="$repo.cache"
	inc="$cache/$tree.incomplete.log"
	if [ "$rc" -ne 0 ] && grep -F 'timed out' "$out" >/dev/null && [ ! -e "$cache/$tree.json" ] \
		&& grep -F 'FULLSUITELOG1-BUNPARTIAL' "$inc" >/dev/null 2>&1; then
		ok "a timed-out bun phase leaves its partial output in the incomplete log"
	else
		not_ok "timed-out bun partial output missing from the incomplete log (rc=$rc)"; cat "$out"; [ -f "$inc" ] && cat "$inc"
	fi
	if [ ! -e "$cache/$tree.running.log.status" ] && [ ! -e "$cache/$tree.running.log.bun" ]; then ok "timed-out run removes runner side files"; else not_ok "timed-out run left runner side files"; fi
else
	not_ok "bun is unavailable; the masking case cannot run"
fi

echo "full-suite-verdict-incomplete: pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
