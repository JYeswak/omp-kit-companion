#!/bin/sh
# ompkit-bj08.5 Round-1 end-to-end script for the wired admission: runs every
# branch admission test file covering every listed positive and planted-negative
# case. Live installed-kit scope checks are informational only (see below).
# Usage: sh scripts/actuator-wiring-e2e.sh
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
FILES="tests/cli/actuator-admission.test.ts tests/cli/send-admission.test.ts tests/cli/fleet-watch-admission.test.ts tests/cli/flush-admission.test.ts tests/cli/service-run-admission.test.ts tests/cli/tracker-recovery-admission.test.ts tests/cli/scope-admission.test.ts"
TOTAL=0
PASS=0

log() {
	printf '{"case":"%s","command":"%s","exit":%s,"expected":"%s","observed":"%s"}\n' "$1" "$2" "$3" "$4" "$5"
}

for FILE in $FILES; do
	if bun test "$ROOT/$FILE" >/dev/null 2>&1; then
		RC=0
		OBSERVED="pass"
	else
		RC=1
		OBSERVED="fail"
	fi
	TOTAL=$((TOTAL + 1))
	if [ "$RC" -eq 0 ]; then PASS=$((PASS + 1)); fi
	log "$FILE" "bun test $FILE" "$RC" "pass" "$OBSERVED"
done

# Informational only: the installed kit predates this change until the next
# release, so these lines report but never gate. Scope shapes are covered by
# tests/cli/scope-admission.test.ts against the source tree.
if omp-kit doctor --scope sessions --json 2>/dev/null | grep -q '"launchers"'; then
	SESSIONS_OBSERVED="sessions-admission-launchers-ok"
else
	SESSIONS_OBSERVED="sessions-admission-launchers-missing-installed-kit-predates-change"
fi
log "live-sessions-admission" "omp-kit doctor --scope sessions --json" 0 "informational" "$SESSIONS_OBSERVED"

if omp-kit doctor --scope services --json 2>/dev/null | grep -q '"launchers"'; then
	SERVICES_OBSERVED="services-admission-launchers-ok"
else
	SERVICES_OBSERVED="services-admission-launchers-missing-installed-kit-predates-change"
fi
log "live-services-admission" "omp-kit doctor --scope services --json" 0 "informational" "$SERVICES_OBSERVED"

UNIT_RC=0
for FILE in $FILES; do
	bun test "$ROOT/$FILE" >/dev/null 2>&1 || UNIT_RC=1
done
printf '{"summary":{"assertions":"%s/%s files","exit":%s}}\n' "$PASS" "$TOTAL" "$UNIT_RC"
exit "$UNIT_RC"
