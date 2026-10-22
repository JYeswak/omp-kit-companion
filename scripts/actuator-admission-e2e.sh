#!/bin/sh
# ompkit-bj08.5 Round-1 end-to-end (criterion [e]): one row per admission
# case, each with its own command, exit code and matched-test/assertion
# count, plus the two live native probe rows. No aggregate result is ever
# repeated across rows; a probe row passes only on an *-ok observation.
#
# Usage: sh scripts/actuator-admission-e2e.sh [case-id ...]
#   No args runs all unit cases plus both live probes. Explicit args run
#   only those rows: a misspelled case id matches zero tests and yields a
#   NON-PASS row (it never passes silently).
# Env: BUN (default bun), OMP_KIT_BIN (default omp-kit from PATH).
#
# Row dispositions: "pass" or "NON-PASS". Probe rows that cannot observe an
# *-ok surface read UNAVAILABLE: they stay required rows, are excluded from
# PASS, and the denominator is not shrunk. Unit, probe and overall totals
# are reported separately. Exit 0 only when every row passes.
#
# Zero effects: the unit rows run the in-tree test file; the probe rows run
# the native doctor scopes read-only (--json, no mutation flags).
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
UNIT_FILE="$ROOT/tests/cli/actuator-admission.test.ts"
BUN="${BUN:-bun}"
OMP_KIT_BIN="${OMP_KIT_BIN:-omp-kit}"

# case-id|bun -t selector (exact test-name substrings; each must match
# exactly one test in tests/cli/actuator-admission.test.ts).
CASES="a-admit-one-action|admits exactly its one owned action
a-unrelated-allow|passes through as ALLOW
a-planted-keeper-excess|launcher set exceeding keeper claim refuses
a-planted-no-keeper|absent keeper claim with live launchers refuses
b-state-refusals|paused, off, protected, unconfirmed and stale states refuse
b-planted-paused-packet|inherited packet during pause refuses with zero effects
b-planted-dead-recovery|dead-owner recovery refuses
b-planted-send-not-custody|send permission without recovery custody refuses
b-planted-started-no-spinner|STARTED without spinner authorizes no resend
b-recovery-custody-admits|recovery with its own live custody admits one action
a-mode-none-recorded|mode none admits with the missing keeper surface recorded
a-mode-none-paused|mode none still refuses a paused authority
a-mode-none-stale|mode none still refuses a stale generation"

UNIT_PASS=0
UNIT_TOTAL=0
PROBE_PASS=0
PROBE_TOTAL=0

log_unit() {
	printf '{"case":"%s","selector":"%s","command":"%s","exit":%s,"ran":%s,"failed":%s,"assertions":%s,"expected":"%s","observed":"%s"}\n' \
		"$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9"
}

log_probe() {
	printf '{"case":"%s","command":"%s","exit":%s,"expected":"%s","observed":"%s"}\n' \
		"$1" "$2" "$3" "$4" "$5"
}

number_or_zero() {
	case "$1" in
		''|*[!0-9]*) printf '0' ;;
		*) printf '%s' "$1" ;;
	esac
}

run_unit_case() {
	case_id="$1"
	selector="$2"
	command="bun test -t $selector tests/cli/actuator-admission.test.ts"
	if out=$(cd "$ROOT" && "$BUN" test -t "$selector" "$UNIT_FILE" 2>&1); then
		rc=0
	else
		rc=1
	fi
	ran=$(printf '%s\n' "$out" | sed -n 's/^Ran \([0-9][0-9]*\) test.*/\1/p' | head -n 1)
	failed=$(printf '%s\n' "$out" | sed -n 's/^ \([0-9][0-9]*\) fail$/\1/p; s/^ \([0-9][0-9]*\) fail .*$/\1/p' | head -n 1)
	assertions=$(printf '%s\n' "$out" | sed -n 's/^ \([0-9][0-9]*\) expect() calls.*/\1/p' | head -n 1)
	ran=$(number_or_zero "$ran")
	failed=$(number_or_zero "$failed")
	assertions=$(number_or_zero "$assertions")
	# A nonexistent selector, or zero matched tests exiting 0, is a
	# NON-PASS: only rc 0 with a nonzero matched count and assertions
	# passes.
	if [ "$rc" -eq 0 ] && [ "$ran" -gt 0 ] && [ "$failed" -eq 0 ] && [ "$assertions" -gt 0 ]; then
		observed="pass"
		UNIT_PASS=$((UNIT_PASS + 1))
	else
		observed="NON-PASS"
	fi
	UNIT_TOTAL=$((UNIT_TOTAL + 1))
	log_unit "$case_id" "$selector" "$command" "$rc" "$ran" "$failed" "$assertions" "pass" "$observed"
}

wanted="$*"
if [ -z "$wanted" ]; then
	while IFS='|' read -r case_id selector; do
		[ -n "$case_id" ] || continue
		run_unit_case "$case_id" "$selector"
	done <<EOF
$CASES
EOF
else
	for case_id in $wanted; do
		selector=$(printf '%s\n' "$CASES" | sed -n "s/^${case_id}|//p" | head -n 1)
		if [ -z "$selector" ]; then
			# Misspelled selector: run it literally so the zero-match is
			# observed, not assumed.
			selector="$case_id"
		fi
		run_unit_case "$case_id" "$selector"
	done
fi

run_probe() {
	case_id="$1"
	scope="$2"
	marker1="$3"
	command="$OMP_KIT_BIN doctor --scope $scope --json"
	if out=$("$OMP_KIT_BIN" doctor --scope "$scope" --json 2>/dev/null); then
		rc=0
	else
		rc=1
	fi
	PROBE_TOTAL=$((PROBE_TOTAL + 1))
	# Pass only on an *-ok observation: exit 0 plus the scope marker and
	# the native admission block naming launcher members. Anything else
	# (fake binary output, degraded surface, missing binary) reads
	# UNAVAILABLE and stays a required non-pass row.
	if [ "$rc" -eq 0 ] \
		&& printf '%s' "$out" | grep -q "$marker1" \
		&& printf '%s' "$out" | grep -q '"admission"' \
		&& printf '%s' "$out" | grep -q '"launchers"'; then
		observed="${scope}-scope-ok"
		PROBE_PASS=$((PROBE_PASS + 1))
	else
		observed="${scope}-scope-UNAVAILABLE"
	fi
	log_probe "$case_id" "$command" "$rc" "${scope}-scope-ok" "$observed"
}

if [ -z "$wanted" ] || printf '%s' "$wanted" | grep -q "live-sessions-scope"; then
	run_probe "live-sessions-scope" "sessions" '"scope":"sessions"'
fi
if [ -z "$wanted" ] || printf '%s' "$wanted" | grep -q "live-services-scope"; then
	run_probe "live-services-scope" "services" '"component":"services"'
fi

TOTAL=$((UNIT_TOTAL + PROBE_TOTAL))
PASS=$((UNIT_PASS + PROBE_PASS))
if [ "$PASS" -eq "$TOTAL" ] && [ "$TOTAL" -gt 0 ]; then
	exit_code=0
else
	exit_code=1
fi
printf '{"summary":{"unit":{"pass":%s,"total":%s},"probes":{"pass":%s,"total":%s},"overall":{"pass":%s,"total":%s},"exit":%s}}\n' \
	"$UNIT_PASS" "$UNIT_TOTAL" "$PROBE_PASS" "$PROBE_TOTAL" "$PASS" "$TOTAL" "$exit_code"
exit "$exit_code"
