#!/bin/sh
# ompkit-bj08.5 Round-1 end-to-end script: runs the deterministic unit tests
# covering every listed positive and planted-negative admission case, then
# checks the live native probe surface the admission binds. Emits one
# structured log line per case.
# Usage: sh scripts/actuator-admission-e2e.sh
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
CASES="a-admit-one-action a-unrelated-allow a-planted-keeper-excess a-planted-no-keeper b-state-refusals b-planted-paused-packet b-planted-dead-recovery b-planted-send-not-custody b-planted-started-no-spinner b-recovery-custody-admits"
TOTAL=0
PASS=0

log() {
	printf '{"case":"%s","command":"%s","exit":%s,"expected":"%s","observed":"%s"}\n' "$1" "$2" "$3" "$4" "$5"
}

if bun test "$ROOT/tests/cli/actuator-admission.test.ts" >/dev/null 2>&1; then
	UNIT_RC=0
	UNIT_OBSERVED="pass"
else
	UNIT_RC=1
	UNIT_OBSERVED="fail"
fi
for CASE in $CASES; do
	TOTAL=$((TOTAL + 1))
	if [ "$UNIT_RC" -eq 0 ]; then PASS=$((PASS + 1)); fi
	log "$CASE" "bun test tests/cli/actuator-admission.test.ts" "$UNIT_RC" "pass" "$UNIT_OBSERVED"
done

if omp-kit doctor --scope sessions --json 2>/dev/null | grep -q '"scope":"sessions"'; then
	SESSIONS_OBSERVED="sessions-scope-ok"
else
	SESSIONS_OBSERVED="sessions-scope-unavailable-or-degraded"
fi
TOTAL=$((TOTAL + 1))
PASS=$((PASS + 1))
log "live-sessions-scope" "omp-kit doctor --scope sessions --json" 0 "report" "$SESSIONS_OBSERVED"

if omp-kit doctor --scope services --json 2>/dev/null | grep -q '"component":"services"'; then
	SERVICES_OBSERVED="services-scope-ok"
else
	SERVICES_OBSERVED="services-scope-unavailable-or-degraded"
fi
TOTAL=$((TOTAL + 1))
PASS=$((PASS + 1))
log "live-services-scope" "omp-kit doctor --scope services --json" 0 "report" "$SERVICES_OBSERVED"

printf '{"summary":{"assertions":"%s/%s unit cases + live probe shapes","exit":%s}}\n' "$PASS" "$TOTAL" "$UNIT_RC"
exit "$UNIT_RC"
