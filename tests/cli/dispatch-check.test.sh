#!/bin/sh
# dispatch-check.test.sh — DISPATCH1 fail-closed comparator contract
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.100).
# Stubs serve canned robot-next and br scheduler payloads; every verdict
# comes from the script's exit code plus its complete stdout/stderr.
set -u

CHECK=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/dispatch-check.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
# shellcheck source=scripts/kitlib-tmp.sh
. "$(dirname -- "$CHECK")/kitlib-tmp.sh"
[ -n "$(printenv TMPDIR)" ] || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP dispatch-check-test || exit 1

pass=0
fail=0

stub_bv() {
	mkdir -p "$TMP/bin"
	cat > "$TMP/bin/bv" <<EOF
#!/bin/sh
if [ "\$1" = "--robot-next" ]; then
	printf '%s' '$BV_NEXT'
else
	exit 9
fi
EOF
	cat > "$TMP/bin/br" <<EOF
#!/bin/sh
case " \$* " in
	*" scheduler "*) printf '%s' '$BR_SCHEDULER' ;;
	*) exit 9 ;;
esac
EOF
	chmod +x "$TMP/bin/bv" "$TMP/bin/br"
	export PATH="$TMP/bin:/usr/bin:/bin"
}

run_case() {
	name=$1
	"$CHECK" --db "$TMP/db" --bv bv > "$TMP/stdout" 2> "$TMP/stderr"
	got_rc=$?
	stdout=$(cat "$TMP/stdout")
	stderr=$(cat "$TMP/stderr")
	case "$name" in
		match|claimed-top-skipped|not-ready-labels-skipped)
			if [ "$got_rc" = "0" ] && {
				[ "$stdout" = "CLAIM_TOP=bead-a" ] ||
					[ "$stdout" = "CLAIM_TOP=bead-a
CLAIM_SOURCE: BV_ROBOT_NEXT bead-a" ];
			}; then pass=$((pass + 1));
			else fail=$((fail + 1)); printf 'FAIL %s: rc=%s out<<<%s>>> err<<<%s>>>\n' "$name" "$got_rc" "$stdout" "$stderr"; fi ;;
		*)
			if [ "$got_rc" = "3" ] && [ -z "$stdout" ] && printf '%s' "$stderr" | grep -q "BV_TOP_MISMATCH"; then pass=$((pass + 1));
			else fail=$((fail + 1)); printf 'FAIL %s: rc=%s out<<<%s>>> err<<<%s>>>\n' "$name" "$got_rc" "$stdout" "$stderr"; fi ;;
	esac
}

# 1. agreement prints the claimable top
BV_NEXT='{"id":"bead-a","title":"A"}'
BR_SCHEDULER='{"recommendations":[{"issue":{"id":"bead-a","status":"open","assignee":null,"labels":[]}}]}'
stub_bv
run_case match 0
# 2. a claimed global top is ignored in favor of the next admissible candidate
BV_NEXT='{"id":"bead-a","title":"A"}'
BR_SCHEDULER='{"recommendations":[{"issue":{"id":"bead-claimed","status":"open","assignee":"owner","labels":[]}},{"issue":{"id":"bead-a","status":"open","assignee":null,"labels":[]}}]}'
stub_bv
run_case claimed-top-skipped 0

# 3. each configured not-ready label is excluded from the scheduler top
BV_NEXT='{"id":"bead-a","title":"A"}'
BR_SCHEDULER='{"recommendations":[{"issue":{"id":"human-gate-bead","status":"open","assignee":null,"labels":["human-gate"]}},{"issue":{"id":"owner-decision-bead","status":"open","assignee":null,"labels":["owner-decision"]}},{"issue":{"id":"process-bead","status":"open","assignee":null,"labels":["kind:process"]}},{"issue":{"id":"bead-a","status":"open","assignee":null,"labels":[]}}]}'
stub_bv
run_case not-ready-labels-skipped 0

# 4. planted admissible mismatch fails closed with no CLAIM_TOP
BV_NEXT='{"id":"bead-a","title":"A"}'
BR_SCHEDULER='{"recommendations":[{"issue":{"id":"bead-b","status":"open","assignee":null,"labels":[]}}]}'
stub_bv
run_case mismatch 3

# 5. unreadable robot-next fails closed
BV_NEXT='not json'
BR_SCHEDULER='{"recommendations":[{"issue":{"id":"bead-a","status":"open","assignee":null,"labels":[]}}]}'
stub_bv
run_case bad-next 3

# 6. empty scheduler top fails closed
BV_NEXT='{"id":"bead-a","title":"A"}'
BR_SCHEDULER='{"recommendations":[]}'
stub_bv
run_case empty-scheduler 3

# 7. dry queue (no next id, empty scheduler) fails closed naming the cause
BV_NEXT='{"message":"No proven actionable item available"}'
BR_SCHEDULER='{"recommendations":[]}'
stub_bv
run_case dry-queue 3

# 8. missing --db fails closed
if "$CHECK" > "$TMP/stdout" 2> "$TMP/stderr"; then
	fail=$((fail + 1)); printf 'FAIL no-db: rc=0\n'
else
	got_rc=$?
	if [ "$got_rc" = "3" ] && grep -q "BV_TOP_MISMATCH" "$TMP/stderr"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL no-db: rc=%s\n' "$got_rc"; fi
fi

printf 'dispatch-check: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
