#!/bin/sh
# dispatch-check.sh — DISPATCH1 fail-closed dispatch comparator
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.100).
# Compares `bv --robot-next` (what a new claimer should take) against the top
# of `bv --robot-triage` over the claim-admissible set. On agreement prints
# CLAIM_TOP=<id> (exit 0). On ANY disagreement or tool failure prints
# BV_TOP_MISMATCH and exits 3: no claim may be made from robot-next's pick
# until the rankings agree or the cause is recorded.
# Reads nothing but bv's JSON; never writes to the tracker.
# Usage: dispatch-check.sh --db PATH [--bv BIN]
set -u

fail() {
	printf 'dispatch-check: %s\n' "$1" >&2
	exit 3
}

DB=""
BV="bv"
while [ $# -gt 0 ]; do
	case "$1" in
		--db) DB=${2:-}; shift 2 ;;
		--bv) BV=${2:-}; shift 2 ;;
		--) shift; break ;;
		*) fail "BV_TOP_MISMATCH unknown argument $1 (usage: dispatch-check.sh --db PATH [--bv BIN])" ;;
	esac
done
if [ -z "$DB" ]; then
	fail "BV_TOP_MISMATCH --db PATH is required"
fi

next_json=$("$BV" --robot-next --db "$DB" -f json 2>/dev/null) || fail "BV_TOP_MISMATCH robot-next failed"
triage_json=$("$BV" --robot-triage --db "$DB" -f json 2>/dev/null) || fail "BV_TOP_MISMATCH robot-triage failed"
claim_top=$(printf '%s' "$next_json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id') or '')" 2>/dev/null) || fail "BV_TOP_MISMATCH robot-next JSON unreadable"
triage_top=$(printf '%s' "$triage_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('triage') or {}).get('quick_ref', {}).get('top_picks', [{}])[0].get('id') or '')" 2>/dev/null) || fail "BV_TOP_MISMATCH robot-triage JSON unreadable"
if [ -z "$claim_top" ]; then
	fail "BV_TOP_MISMATCH robot-next named no id"
fi
if [ -z "$triage_top" ]; then
	fail "BV_TOP_MISMATCH robot-triage named no top pick"
fi
if [ "$claim_top" != "$triage_top" ]; then
	fail "BV_TOP_MISMATCH next=$claim_top triage=$triage_top (no claim from robot-next until the rankings agree)"
fi
printf 'CLAIM_TOP=%s\n' "$claim_top"
