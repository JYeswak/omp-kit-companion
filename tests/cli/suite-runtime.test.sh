#!/bin/sh
# suite-runtime.test.sh — FULLRED slice 4/4 (ompkit-lrbd.5) guard contract.
# The verdict comes from the exit code plus the complete output. Planted
# negative: a run at/over budget must exit 1 with RUNTIME_REGRESSION, never a
# pass; a fast failure must propagate its own code, never 0.
set -u

GUARD=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/check-suite-runtime.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
. "$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/kitlib-tmp.sh"
kitlib_tmp TMP suite-runtime-test || exit 1

pass=0
fail=0

check() { # name expected_rc actual_rc output [pattern...]
	name=$1; want=$2; got=$3; out=$4; shift 4
	ok=1
	[ "$got" = "$want" ] || ok=0
	for pattern in "$@"; do
		printf '%s' "$out" | grep -q -- "$pattern" || ok=0
	done
	if [ "$ok" = "1" ]; then pass=$((pass + 1)); printf 'ok %s\n' "$name";
	else fail=$((fail + 1)); printf 'FAIL %s (rc=%s want=%s out=%s)\n' "$name" "$got" "$want" "$out"; fi
}

out=$("$GUARD" --budget-secs 300 -- true 2>"$TMP/err"); rc=$?
check "fast pass exits 0 with runtime line" 0 "$rc" "$out" "SUITE_RUNTIME_SECS="

out=$("$GUARD" --budget-secs 2 -- sleep 3 2>"$TMP/err"); rc=$?
err=$(cat "$TMP/err")
check "over-budget run exits 1 with RUNTIME_REGRESSION" 1 "$rc" "$out $err" "RUNTIME_REGRESSION" "elapsed=" "budget=2"

out=$("$GUARD" --budget-secs 300 -- sh -c 'exit 7' 2>"$TMP/err"); rc=$?
check "fast failure propagates its own code" 7 "$rc" "$out" "SUITE_RUNTIME_SECS="

out=$("$GUARD" --budget-secs=1 -- sh -c 'sleep 2; exit 5' 2>"$TMP/err"); rc=$?
err=$(cat "$TMP/err")
check "slow failure reports regression, not the inner code" 1 "$rc" "$out $err" "RUNTIME_REGRESSION"

out=$("$GUARD" 2>"$TMP/err"); rc=$?
check "missing command exits 2 with usage" 2 "$rc" "$(cat "$TMP/err")" "usage:"

out=$("$GUARD" --budget-secs nope -- true 2>"$TMP/err"); rc=$?
check "non-numeric budget exits 2" 2 "$rc" "$(cat "$TMP/err")" "--budget-secs"

printf '%s pass, %s fail\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
