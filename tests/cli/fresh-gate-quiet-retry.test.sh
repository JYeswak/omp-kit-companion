#!/bin/sh
# fresh-gate-quiet-retry.test.sh — QUIETRETRY1. scripts/fresh-gate.sh reruns itself when it ends UNQUALIFIED (exit 76),
# waiting for a quiet window, and passes every other verdict through. The real retry block is cut out of the real script
# (from its QUIETRETRY1 marker to its closing `esac`) and put in front of a stub gate body that returns a scripted
# sequence of exit codes, so the test exercises the shipped text without running a gate. Planted: the retry block is absent
# (the stub's 76 stays 76 with the wait on). Controls: a scripted 76 then 0 ends 0 after two runs; a gate that is never
# quiet ends 76 and says no window came; exit 1 and exit 0 pass through once; with the wait off nothing reruns.
set -u
KITROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
GATE=${FRESH_GATE_UNDER_TEST:-"$KITROOT_DIR/scripts/fresh-gate.sh"}
REPO_TMP="$KITROOT_DIR/var/agent-tmp"
mkdir -p "$REPO_TMP"
# shellcheck source=scripts/kitlib-tmp.sh
. "$KITROOT_DIR/scripts/kitlib-tmp.sh"
# shellcheck disable=SC2034 # read by kitlib_tmp
KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP fresh-gate-quiet-retry-test || exit 1
TMP=$(cd "$TMP" && pwd -P)
pass=0
fail=0
ok() { if [ "$1" = 0 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s\n' "$2"; fi; }

block="$TMP/block.sh"
awk '/^# QUIETRETRY1:/ { on = 1 } on { print } on && /^esac$/ { exit }' "$GATE" >"$block"
is=0; { [ -s "$block" ] && grep -qF 'QUIETRETRY1' "$block" && tail -1 "$block" | grep -qx 'esac'; } || is=1
ok "$is" "the QUIETRETRY1 block was found in the real gate script"

# stub GATEFILE WITH_BLOCK: a gate whose body returns the next code of $STUB_RCS and counts its runs in $STUB_COUNT.
make_stub() {
	{
		printf '#!/bin/sh\nset -eu\n'
		[ "$2" = 1 ] && cat "$block"
		cat <<'BODY'
read -r n <"$STUB_COUNT"
n=$((n + 1))
printf '%s\n' "$n" >"$STUB_COUNT"
# shellcheck disable=SC2086
set -- $STUB_RCS
eval "rc=\${$n:-0}"
exit "$rc"
BODY
	} >"$1"
}
make_stub "$TMP/gate.sh" 1
make_stub "$TMP/gate-no-block.sh" 0

# run_gate LABEL GATEFILE RCS [ENV=VALUE ...]: rc in $rc, output in $TMP/LABEL.out, stub runs in $runs.
run_gate() {
	label=$1 file=$2 codes=$3
	shift 3
	printf '0\n' >"$TMP/$label.count"
	rc=0
	env STUB_COUNT="$TMP/$label.count" STUB_RCS="$codes" "$@" /bin/sh "$file" --commit HEAD >"$TMP/$label.out" 2>&1 || rc=$?
	read -r runs <"$TMP/$label.count"
}

run_gate off "$TMP/gate.sh" "76 0" FRESH_GATE_QUIET_WAIT_S=0
is=0; { [ "$rc" = 76 ] && [ "$runs" = 1 ]; } || is=1
ok "$is" "wait-off-reruns-nothing: rc=$rc runs=$runs"

run_gate retry "$TMP/gate.sh" "76 0" FRESH_GATE_QUIET_WAIT_S=60 FRESH_GATE_QUIET_POLL_S=1 FRESH_GATE_QUIET_MAX_LOAD=999999
[ "$rc" = 0 ] && [ "$runs" = 2 ] && grep -Fq 'rerunning the UNQUALIFIED gate' "$TMP/retry.out"
ok $? "unqualified-then-green-ends-green-after-two-runs: rc=$rc runs=$runs out=$(cat "$TMP/retry.out")"

run_gate never "$TMP/gate.sh" "76 76 76" FRESH_GATE_QUIET_WAIT_S=2 FRESH_GATE_QUIET_POLL_S=1 FRESH_GATE_QUIET_MAX_LOAD=0
[ "$rc" = 76 ] && [ "$runs" = 1 ] && grep -Fq 'no quiet window came' "$TMP/never.out"
ok $? "never-quiet-ends-unqualified-and-says-so: rc=$rc runs=$runs out=$(cat "$TMP/never.out")"

run_gate red "$TMP/gate.sh" "1 0" FRESH_GATE_QUIET_WAIT_S=60 FRESH_GATE_QUIET_POLL_S=1 FRESH_GATE_QUIET_MAX_LOAD=999999
is=0; { [ "$rc" = 1 ] && [ "$runs" = 1 ]; } || is=1
ok "$is" "red-passes-through-without-a-rerun: rc=$rc runs=$runs"

run_gate green "$TMP/gate.sh" "0" FRESH_GATE_QUIET_WAIT_S=60 FRESH_GATE_QUIET_POLL_S=1 FRESH_GATE_QUIET_MAX_LOAD=999999
is=0; { [ "$rc" = 0 ] && [ "$runs" = 1 ]; } || is=1
ok "$is" "green-passes-through-without-a-rerun: rc=$rc runs=$runs"

run_gate absent "$TMP/gate-no-block.sh" "76 0" FRESH_GATE_QUIET_WAIT_S=60 FRESH_GATE_QUIET_POLL_S=1 FRESH_GATE_QUIET_MAX_LOAD=999999
is=0; { [ "$rc" = 76 ] && [ "$runs" = 1 ]; } || is=1
ok "$is" "planted-negative-without-the-block-the-76-stays-76: rc=$rc runs=$runs"

kitlib_tmp_cleanup "$TMP" 2>/dev/null || :
printf 'fresh-gate-quiet-retry: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = 0 ]
