#!/usr/bin/env bash
# fp72.24: compare-and-swap proof on an owned fixture tracker.
# Proves: current updated_at token writes; stale token refused (update, exit 6);
# close on a current token applies; close on a stale base is the known upstream
# gap (beads_rust#573) until `br close` gains --if-unchanged.
# Every br call carries an explicit --db inside the owned state dir; the real
# tracker is never touched (BEADS_DB/cwd auto-discovery is not trusted).
set -u
set -o pipefail

BEAD="ompkit-fp72.24"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$REPO/var/agent-tmp/fp7224-cas.$$"
LOG="$STATE/proof.jsonl"
FAIL=0

mkdir -p "$STATE"
printf 'pid=%s label=fp7224-cas repo=omp-kit-companion\n' "$$" > "$STATE/.owner"
DB="$STATE/tracker.db"

log() { # name expected actual ok exit
	printf '{"bead_id":"%s","step":"%s","expected":"%s","actual":"%s","ok":%s,"exit":%s}\n' \
		"$BEAD" "$1" "$2" "$3" "$4" "$5" >> "$LOG"
	[ "$4" = "true" ] || FAIL=1
}

token_of() { # id -> updated_at
	br show "$1" --json --db "$DB" --lock-timeout 10000 2>/dev/null | \
		python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["updated_at"])'
}

# 1. update with the current token applies.
A="$(br create "cas current" --json --db "$DB" --lock-timeout 10000 2>/dev/null | \
	python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
TA="$(token_of "$A")"
br update "$A" --if-unchanged "$TA" --title "cas current v2" --db "$DB" --lock-timeout 10000 >/dev/null 2>&1
RC=$?
log "update_current_applies" "exit-0" "exit-$RC" "$([ "$RC" = "0" ] && echo true || echo false)" "$RC"

# 2. update with a stale token is refused (exit 6, both timestamps named).
br update "$A" --if-unchanged "$TA" --title "cas stale" --db "$DB" --lock-timeout 10000 > "$STATE/stale.err" 2>&1
RC=$?
NAMES=false
grep -q "$TA" "$STATE/stale.err" 2>/dev/null && \
grep -q "$(token_of "$A")" "$STATE/stale.err" 2>/dev/null && NAMES=true
OK=false; [ "$RC" = "6" ] && [ "$NAMES" = "true" ] && OK=true
log "update_stale_refused" "exit-6-both-timestamps" "exit-$RC-names-$NAMES" "$OK" "$RC"

close_with_policy() { # id token step -> sets RC and ST
	br gate report "$1" --gate min_reviewers --provider reviewer:CC115 --status pass --to closed \
		--db "$DB" --lock-timeout 10000 >/dev/null 2>&1
	br close "$1" --reason "fp72.24 proof $3: token $2 observed via br show $1 --json -> $2" \
		--transition-comment "fp72.24 proof $3 cites token $2" \
		--db "$DB" --lock-timeout 10000 >/dev/null 2>&1
	RC=$?
	ST="$(br show "$1" --json --db "$DB" --lock-timeout 10000 2>/dev/null | \
		python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["status"])')"
}

# 3. close with a current token applies.
B="$(br create "cas close current" --json --db "$DB" --lock-timeout 10000 2>/dev/null | \
	python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
TB="$(token_of "$B")"
close_with_policy "$B" "$TB" "close_current_applies"
OK=false; [ "$RC" = "0" ] && [ "$ST" = "closed" ] && OK=true
log "close_current_applies" "exit-0-closed" "exit-$RC-$ST" "$OK" "$RC"

# 4. planted negative: close on a stale base.
C="$(br create "cas close stale" --json --db "$DB" --lock-timeout 10000 2>/dev/null | \
	python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
TS="$(token_of "$C")"
br update "$C" --title "concurrent writer moved it" --db "$DB" --lock-timeout 10000 >/dev/null 2>&1
if br close --help 2>&1 | grep -q "if-unchanged"; then
	# Upstream shipped it: stale close must refuse.
	br gate report "$C" --gate min_reviewers --provider reviewer:CC115 --status pass --to closed \
		--db "$DB" --lock-timeout 10000 >/dev/null 2>&1
	TC="$(token_of "$C")"
	br close "$C" --if-unchanged "$TS" --reason "fp72.24 proof close_stale_refused: stale $TS vs current $TC -> expect refusal" \
		--transition-comment "fp72.24 proof close_stale_refused cites stale $TS" \
		--db "$DB" --lock-timeout 10000 >/dev/null 2>&1
	RC=$?
	ST="$(br show "$C" --json --db "$DB" --lock-timeout 10000 2>/dev/null | \
		python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["status"])')"
	OK=false; [ "$RC" != "0" ] && [ "$ST" = "open" ] && OK=true
	log "close_stale_refused" "refused-stays-open" "exit-$RC-$ST" "$OK" "$RC"
else
	# Known gap beads_rust#573: stale close applies. Detect it (fail if not detected).
	close_with_policy "$C" "$(token_of "$C")" "close_stale_gap"
	OK=false; [ "$RC" = "0" ] && [ "$ST" = "closed" ] && OK=true
	log "close_stale_gap_detected" "KNOWN_GAP-beads_rust#573-applies" "exit-$RC-$ST" "$OK" "$RC"
fi

echo "fp72.24 proof: $(grep -c '"ok":true' "$LOG")/4 steps ok; log $LOG"
exit "$FAIL"
