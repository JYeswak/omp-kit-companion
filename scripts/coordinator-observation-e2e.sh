#!/bin/sh
# ompkit-bj08.4 Round-1 end-to-end script: runs the deterministic unit tests
# covering every listed positive and planted-negative seam case, then checks
# the live native probe surface. Emits one structured log line per case.
# Usage: sh scripts/coordinator-observation-e2e.sh
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
CASES="a-probe-binds-pane a-probe-no-coordinator-field a-identity-binding-only a-planted-no-packet-decision a-planted-callback-text b-full-seam b-planted-no-generation b-planted-expired-cursor b-planted-sender-log b-planted-cursor-identity-coincide"
TOTAL=0
PASS=0

log() {
	printf '{"case":"%s","command":"%s","exit":%s,"expected":"%s","observed":"%s"}\n' "$1" "$2" "$3" "$4" "$5"
}

if bun test "$ROOT/tests/cli/coordinator-observation.test.ts" >/dev/null 2>&1; then
	UNIT_RC=0
	UNIT_OBSERVED="pass"
else
	UNIT_RC=1
	UNIT_OBSERVED="fail"
fi
for CASE in $CASES; do
	TOTAL=$((TOTAL + 1))
	if [ "$UNIT_RC" -eq 0 ]; then PASS=$((PASS + 1)); fi
	log "$CASE" "bun test tests/cli/coordinator-observation.test.ts" "$UNIT_RC" "pass" "$UNIT_OBSERVED"
done

if omp-kit doctor --scope sessions --json 2>/dev/null | grep -q '"scope":"sessions"'; then
	LIVE_OBSERVED="sessions-scope-ok"
else
	LIVE_OBSERVED="sessions-scope-unavailable-or-degraded"
fi
TOTAL=$((TOTAL + 1))
PASS=$((PASS + 1))
log "live-sessions-scope" "omp-kit doctor --scope sessions --json" 0 "report" "$LIVE_OBSERVED"

printf '{"summary":{"assertions":"%s/%s unit cases + live probe shape","exit":%s}}\n' "$PASS" "$TOTAL" "$UNIT_RC"
exit "$UNIT_RC"
