#!/bin/sh
# dispatch-check.test.sh — DISPATCH1 fail-closed comparator contract
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.100).
# A stub `bv` serves canned robot-next / robot-triage payloads; every verdict
# comes from the script's exit code plus its complete stdout/stderr.
set -u

CHECK=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/dispatch-check.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/dispatch-check-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0

stub_bv() {
	mkdir -p "$TMP/bin"
	cat > "$TMP/bin/bv" <<EOF
#!/bin/sh
if [ "\$1" = "--robot-next" ]; then
	printf '%s' '$BV_NEXT'
elif [ "\$1" = "--robot-triage" ]; then
	printf '%s' '$BV_TRIAGE'
else
	exit 9
fi
EOF
	chmod +x "$TMP/bin/bv"
	export PATH="$TMP/bin:/usr/bin:/bin"
}

run_case() {
	name=$1
	"$CHECK" --db "$TMP/db" --bv bv > "$TMP/stdout" 2> "$TMP/stderr"
	got_rc=$?
	stdout=$(cat "$TMP/stdout")
	stderr=$(cat "$TMP/stderr")
	case "$name" in
		match)
			if [ "$got_rc" = "0" ] && [ "$stdout" = "CLAIM_TOP=bead-a" ]; then pass=$((pass + 1));
			else fail=$((fail + 1)); printf 'FAIL %s: rc=%s out<<<%s>>> err<<<%s>>>\n' "$name" "$got_rc" "$stdout" "$stderr"; fi ;;
		*)
			if [ "$got_rc" = "3" ] && [ -z "$stdout" ] && printf '%s' "$stderr" | grep -q "BV_TOP_MISMATCH"; then pass=$((pass + 1));
			else fail=$((fail + 1)); printf 'FAIL %s: rc=%s out<<<%s>>> err<<<%s>>>\n' "$name" "$got_rc" "$stdout" "$stderr"; fi ;;
	esac
}

# 1. agreement prints the claimable top
BV_NEXT='{"id":"bead-a","title":"A"}'
BV_TRIAGE='{"triage":{"quick_ref":{"top_picks":[{"id":"bead-a"}]}}}'
stub_bv
run_case match 0

# 2. planted admissible mismatch fails closed with no CLAIM_TOP
BV_NEXT='{"id":"bead-a","title":"A"}'
BV_TRIAGE='{"triage":{"quick_ref":{"top_picks":[{"id":"bead-b"}]}}}'
stub_bv
run_case mismatch 3

# 3. unreadable robot-next fails closed
BV_NEXT='not json'
BV_TRIAGE='{"triage":{"quick_ref":{"top_picks":[{"id":"bead-a"}]}}}'
stub_bv
run_case bad-next 3

# 4. empty triage top fails closed
BV_NEXT='{"id":"bead-a","title":"A"}'
BV_TRIAGE='{"triage":{"quick_ref":{"top_picks":[]}}}'
stub_bv
run_case empty-triage 3

# 5. missing --db fails closed
if "$CHECK" > "$TMP/stdout" 2> "$TMP/stderr"; then
	fail=$((fail + 1)); printf 'FAIL no-db: rc=0\n'
else
	got_rc=$?
	if [ "$got_rc" = "3" ] && grep -q "BV_TOP_MISMATCH" "$TMP/stderr"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL no-db: rc=%s\n' "$got_rc"; fi
fi

printf 'dispatch-check: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
