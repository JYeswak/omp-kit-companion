#!/bin/sh
# cc14-daemon-kind e2e: daemon job kind boundary through the real CLI.
#
# NOTE (CC14 .18.1): the bead names scripts/cc/e2e/cc14-daemon-kind.sh, but
# omp-kit scripts/ is a frozen snapshot, so this lives at the companion
# tests/e2e path instead (.18.2's e2e has the same constraint).
#
# Fixture: owned HOME + fleet root holding scripts/cc/cc.py, test label
# namespace (never production labels). Cases:
#   1. daemon plist render has KeepAlive, RunAtLoad true, no StartInterval
#   2. PLANTED: KeepAlive stripped from the installed plist -> service doctor
#      must report contract-daemon-keepalive FAIL (miss = harness failure)
#   3. lock held by another process -> second `service run cc` exits 75
#   4. no fleet root -> `service install cc --plan` refuses FLEET_ADAPTER_ABSENT
#
# Usage: sh tests/e2e/cc14-daemon-kind.sh --work-dir ABS [--kit ARGV]
#   --kit: argv prefix for the kit under test, e.g. "bun src/cli.ts"
#          (default, run from the companion repo root).
#
# Steps log one JSON line each to WORK/steps.jsonl with
# {bead_id, step, process, fixture_sha, as_of_ms, expected, actual, ok, exit};
# the final stdout line is {"passed":N,"failed":N,"failed_steps":[...]}.
# Exit: 0 every step matched (planted failure detected); 1 mismatch; 2 usage.

set -u

WORK=""
KIT="bun src/cli.ts"
BEAD="ompkit-fp72.120.16.18.1"

while [ $# -gt 0 ]; do
	case "$1" in
		--work-dir) WORK="${2:?--work-dir needs a value}"; shift 2 ;;
		--kit) KIT="${2:?--kit needs a value}"; shift 2 ;;
		*) echo "usage: $0 --work-dir ABS [--kit ARGV]" >&2; exit 2 ;;
	esac
done

case "$WORK" in
	/*) ;;
	*) echo "e2e needs an absolute --work-dir" >&2; exit 2 ;;
esac

mkdir -p "$WORK/home" "$WORK/fleet/scripts/cc" || exit 2
STEPS="$WORK/steps.jsonl"
: > "$STEPS"
PASS=0
FAIL=0
FAILED=""

mkdir -p "$WORK/home/.local/state/omp-kit/jobs"
chmod 0700 "$WORK/home/.local/state" "$WORK/home/.local/state/omp-kit" "$WORK/home/.local/state/omp-kit/jobs"
FIXTURE_SHA="$(shasum -a 256 "$0" 2>/dev/null | cut -d' ' -f1)"
[ -n "$FIXTURE_SHA" ] || FIXTURE_SHA="unavailable"
step() {
	# step NAME EXPECTED ACTUAL OK EXIT
	_ms="$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s000)"
	_ok="$4"; _exit="$5"
	if [ "$_ok" = "true" ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); FAILED="$FAILED $1"; fi
	printf '{"bead_id":"%s","step":"%s","process":"e2e","fixture_sha":"%s","as_of_ms":%s,"expected":"%s","actual":"%s","ok":%s,"exit":%s}\n' \
		"$BEAD" "$1" "$FIXTURE_SHA" "$_ms" "$2" "$3" "$_ok" "$_exit" >> "$STEPS"
}

export HOME="$WORK/home"
export XDG_STATE_HOME="$WORK/home/.local/state"
export OMP_KIT_TEST_LABEL_NAMESPACE="com.omp-kit.test.cc14e2e"
export OMP_KIT_FLEET_ROOT="$WORK/fleet"
unset OMP_KIT_FLEET_WATCH_CONFIG
printf '#!/usr/bin/env python3\n' > "$WORK/fleet/scripts/cc/cc.py"
printf '#!/bin/sh\nexit 0\n' > "$WORK/launcher-stub"
mkdir -p "$WORK/home/.local/bin"
cp "$WORK/launcher-stub" "$WORK/home/.local/bin/omp-kit"
chmod 755 "$WORK/home/.local/bin/omp-kit" "$WORK/fleet/scripts/cc/cc.py"

# 1. daemon plist render shape
PLAN_OUT="$WORK/plan.json"
# shellcheck disable=SC2086
$KIT service install cc --plan --json > "$PLAN_OUT" 2>"$WORK/plan.err"; PLAN_EXIT=$?
PLIST="$(python3 -c 'import json;print(json.load(open("'"$PLAN_OUT"'"))["data"].get("plist",""))' 2>/dev/null)"
case "$PLIST" in
	*"<key>KeepAlive</key>"*"<key>SuccessfulExit</key>"*"<false/>"*"<key>RunAtLoad</key>"*"<true/>"*)
		if printf '%s' "$PLIST" | grep -q "StartInterval"; then
			step "render_daemon_plist" "KeepAlive+RunAtLoad, no StartInterval" "StartInterval present" "false" "$PLAN_EXIT"
		else
			step "render_daemon_plist" "KeepAlive+RunAtLoad, no StartInterval" "shape ok" "true" "$PLAN_EXIT"
		fi ;;
	*) step "render_daemon_plist" "KeepAlive+RunAtLoad, no StartInterval" "missing KeepAlive block" "false" "$PLAN_EXIT" ;;
esac

# 2. PLANTED: strip KeepAlive from the installed plist; doctor must flag it.
LABEL="com.omp-kit.test.cc14e2e.cc"
mkdir -p "$WORK/home/Library/LaunchAgents"
python3 - "$PLAN_OUT" "$WORK/home/Library/LaunchAgents/$LABEL.plist" <<'EOF'
import json, sys
plist = json.load(open(sys.argv[1]))["data"]["plist"]
block = "\t<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>\n"
assert block in plist, "planted-edit precondition: KeepAlive block present"
open(sys.argv[2], "w").write(plist.replace(block, "", 1))
EOF
# shellcheck disable=SC2086
$KIT service doctor cc --json > "$WORK/doctor.json" 2>/dev/null; DOCTOR_EXIT=$?
KEEPALIVE="$(python3 -c 'import json;rows=json.load(open("'"$WORK/doctor.json"'"))["data"]["checks"];print([r["status"] for r in rows if r["id"]=="contract-daemon-keepalive"][0])' 2>/dev/null)"
if [ "$KEEPALIVE" = "FAIL" ]; then
	step "planted_missing_keepalive" "contract-daemon-keepalive FAIL" "FAIL" "true" "$DOCTOR_EXIT"
else
	step "planted_missing_keepalive" "contract-daemon-keepalive FAIL" "${KEEPALIVE:-no-check}" "false" "$DOCTOR_EXIT"
fi
# 3. one-instance lock: hold <state>/jobs/cc.lock from an out-of-band process
# (the serve body lands in .18.2, so no CLI run parks yet); the second
# `service run cc` must exit 75 ALREADY_RUNNING.
cat > "$WORK/hold_lock.py" <<'EOF'
import os, sqlite3, sys, time
d = sys.argv[1]
os.makedirs(d, mode=0o700, exist_ok=True)
p = os.path.join(d, "cc.lock")
fd = os.open(p, os.O_CREAT | os.O_RDWR, 0o600)
os.close(fd)
con = sqlite3.connect(p, isolation_level=None, timeout=0)
con.execute("BEGIN IMMEDIATE")
print("HOLDER-READY", flush=True)
time.sleep(600)
EOF
python3 "$WORK/hold_lock.py" "$WORK/home/.local/state/omp-kit/jobs" > "$WORK/hold.out" 2>&1 &
HOLDER_PID=$!
for _ in $(seq 1 50); do grep -q HOLDER-READY "$WORK/hold.out" 2>/dev/null && break; sleep 0.2; done
# shellcheck disable=SC2086
$KIT service run cc --json > "$WORK/run75.json" 2>/dev/null; RUN_EXIT=$?
RUN_STATUS="$(python3 -c 'import json;print(json.load(open("'"$WORK/run75.json"'"))["data"].get("status",""))' 2>/dev/null)"
kill -9 "$HOLDER_PID" 2>/dev/null; wait 2>/dev/null
if [ "$RUN_EXIT" = "75" ] && [ "$RUN_STATUS" = "ALREADY_RUNNING" ]; then
	step "single_instance_lock" "exit 75 ALREADY_RUNNING" "exit $RUN_EXIT $RUN_STATUS" "true" "$RUN_EXIT"
else
	step "single_instance_lock" "exit 75 ALREADY_RUNNING" "exit $RUN_EXIT $RUN_STATUS" "false" "$RUN_EXIT"
fi

# 4. adapter absent -> FLEET_ADAPTER_ABSENT.
unset OMP_KIT_FLEET_ROOT
# shellcheck disable=SC2086
$KIT service install cc --plan --json > "$WORK/absent.json" 2>/dev/null; ABSENT_EXIT=$?
ABSENT_CODE="$(python3 -c 'import json;print(json.load(open("'"$WORK/absent.json"'"))["errors"][0]["code"])' 2>/dev/null)"
if [ "$ABSENT_CODE" = "FLEET_ADAPTER_ABSENT" ]; then
	step "install_refuses_without_fleet" "FLEET_ADAPTER_ABSENT" "$ABSENT_CODE" "true" "$ABSENT_EXIT"
else
	step "install_refuses_without_fleet" "FLEET_ADAPTER_ABSENT" "${ABSENT_CODE:-no-code}" "false" "$ABSENT_EXIT"
fi

printf '{"passed":%s,"failed":%s,"failed_steps":[%s]}\n' "$PASS" "$FAIL" "$(printf '%s' "$FAILED" | tr ' ' '\n' | grep -v '^$' | sed 's/.*/"&"/' | paste -sd, -)"
[ "$FAIL" -eq 0 ]
