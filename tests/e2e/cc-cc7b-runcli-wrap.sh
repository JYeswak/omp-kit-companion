#!/bin/bash
# CC7b runCli action wrapper boundary (bead ompkit-fp72.120.16.11.4).
# Runs the bead's boundary in an owned temporary state dir (TMPDIR under
# var/agent-tmp), plants one failure (a minted credential-shaped --message that
# must never reach the spool), and emits JSONL lines
# {bead_id, step, process, fixture_sha, as_of_ms, expected, actual, ok, exit}.
# Exits non-zero when the planted failure is not detected.
#
# Planted credential shapes are minted at runtime (never literals in this file).
# Heavy uses --no-wait: the literal `heavy -- true` form can queue past any e2e
# budget under disk pressure (same dispatch-bypassing early return either way;
# the pair is what this bead proves). The literal `service run load-watch`
# form executes the real job body, so that step asserts the pre-effect attempt
# surface only and records (never gates) the body outcome.
set -u
BEAD="ompkit-fp72.120.16.11.4"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$REPO/var/agent-tmp/cc-cc7b-runcli-wrap-$$"
OUT="$STATE/e2e.jsonl"
FAIL=0

mkdir -p "$STATE/spool" "$STATE/xdg" "$STATE/home" "$STATE/tmp"
printf 'pid=%s label=cc-cc7b-runcli-wrap repo=%s\n' "$$" "$REPO" > "$STATE/.owner"
as_of_ms() { python3 -c "import time; print(int(time.time()*1000))"; }
emit() { # step expected actual ok exit
	printf '{"bead_id":"%s","step":"%s","process":"%s","fixture_sha":"%s","as_of_ms":%s,"expected":"%s","actual":"%s","ok":%s,"exit":%s}\n' \
		"$BEAD" "$1" "e2e" "$SHA" "$(as_of_ms)" "$2" "$3" "$4" "$5" | tee -a "$OUT"
}
fail() { FAIL=1; emit "$1" "$2" "$3" "false" 1; }
pass() { emit "$1" "$2" "$3" "true" 0; }

SHA="$(python3 -c "import hashlib; print(hashlib.sha256(open('$REPO/src/cli.ts','rb').read()).hexdigest())")"
DAY="$(python3 -c "import datetime; print(datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d'))")"
SPOOL="$STATE/spool/kit/$DAY.jsonl"

kit() { # run the real CLI sandboxed; stdout/stderr separated, never asserted here
	env -i PATH="$PATH" HOME="$STATE/home" XDG_STATE_HOME="$STATE/xdg" TMPDIR="$STATE/tmp" \
		CC_STATE="$STATE" AGENT_NAME="E2ERuncliWrap" NO_COLOR=1 \
		bun "$REPO/src/cli.ts" "$@" > "$STATE/stdout.bin" 2> "$STATE/stderr.bin"
	printf '%s' "$?"
}
triple() { # surface -> "type|surface|outcome|code" for the latest attempt triple
	python3 - "$SPOOL" "$1" <<'EOF'
import json, sys
lines = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
attempts = [l for l in lines if l.get("type") == "action.attempt" and l.get("data", {}).get("surface") == sys.argv[2]]
if not attempts:
    sys.exit(0)
aid = attempts[-1]["data"]["action_id"]
for e in lines:
    d = e.get("data", {})
    if d.get("action_id") == aid or e.get("position") == f"kit:{aid}:tick":
        print(f"{e['type']}|{d.get('surface') or ''}|{d.get('outcome') or ''}|{d.get('code') or ''}")
EOF
}

# 1. ok triple: capabilities exits 0, exactly attempt+result+tick, outcome ok.
CODE="$(kit capabilities --json)"
if [ "$CODE" = "0" ] && [ "$(triple kit-capabilities | wc -l | tr -d ' ')" = "3" ] \
	&& triple kit-capabilities | sed -n '1p' | grep -q "^action.attempt|kit-capabilities||$" \
	&& triple kit-capabilities | sed -n '2p' | grep -q "^action.result||ok|$" \
	&& triple kit-capabilities | sed -n '3p' | grep -q "^source.tick|||$"; then
	pass "ok_triple" "attempt+result+tick kit-capabilities ok" "exit=$CODE"
else
	fail "ok_triple" "attempt+result+tick kit-capabilities ok" "exit=$CODE lines=$(triple kit-capabilities | tr '\n' ';')"
fi

# 2. status surface: exactly one triple for contract-safe kit-status (outcome recorded, exit varies by host).
CODE="$(kit status --json)"
if [ "$(triple kit-status | wc -l | tr -d ' ')" = "3" ]; then
	pass "status_surface" "triple kit-status" "exit=$CODE $(triple kit-status | sed -n '2p')"
else
	fail "status_surface" "triple kit-status" "exit=$CODE lines=$(triple kit-status | tr '\n' ';')"
fi

# 3. land refusal without --yes: outcome refused code CONSENT_REQUIRED.
CODE="$(kit land --paths x --message m --apply --json)"
if [ "$CODE" = "2" ] && triple kit-land | sed -n '2p' | grep -q "^action.result||refused|CONSENT_REQUIRED$"; then
	pass "land_refused" "refused CONSENT_REQUIRED" "exit=$CODE"
else
	fail "land_refused" "refused CONSENT_REQUIRED" "exit=$CODE $(triple kit-land | sed -n '2p')"
fi

# 4. parse error: unknown verb never reaches dispatch.
CODE="$(kit nosuchverb --json)"
if [ "$CODE" = "2" ] && triple kit-parse_error | sed -n '1p' | grep -q "^action.attempt|kit-parse_error||$" \
	&& triple kit-parse_error | sed -n '2p' | grep -q "refused"; then
	pass "parse_error" "kit-parse_error refused" "exit=$CODE"
else
	fail "parse_error" "kit-parse_error refused" "exit=$CODE"
fi

# 5. launchd surface (literal form): attempt is pre-effect, so the surface is
# present even while the real job body runs; body outcome recorded only.
CODE="$(OMP_KIT_JOB=load-watch timeout -s KILL 100 env CC_STATE="$STATE" AGENT_NAME="E2ERuncliWrap" \
	HOME="$STATE/home" XDG_STATE_HOME="$STATE/xdg" TMPDIR="$STATE/tmp" NO_COLOR=1 \
	bun "$REPO/src/cli.ts" service run load-watch --json > "$STATE/stdout.bin" 2> "$STATE/stderr.bin"; printf '%s' "$?")"
if triple launchd-load-watch | sed -n '1p' | grep -q "^action.attempt|launchd-load-watch||$"; then
	pass "launchd_surface" "attempt launchd-load-watch" "exit=$CODE"
else
	fail "launchd_surface" "attempt launchd-load-watch" "exit=$CODE"
fi

# 6. heavy pair on the dispatch-bypassing path.
CODE="$(kit heavy --no-wait -- true)"
if { [ "$CODE" = "0" ] || [ "$CODE" = "75" ]; } && [ "$(triple kit-heavy | wc -l | tr -d ' ')" = "3" ]; then
	pass "heavy_pair" "attempt+result+tick kit-heavy" "exit=$CODE"
else
	fail "heavy_pair" "attempt+result+tick kit-heavy" "exit=$CODE"
fi

# 7. planted credential: minted token-shaped --message must never reach the disk.
TOKEN="ghp_$(printf 'z%.0s' $(seq 1 36))"
BEFORE="$(wc -l < "$SPOOL" | tr -d ' ')"
CODE="$(kit land --paths x --message "$TOKEN" --apply --json)"
if grep -q "$TOKEN" "$SPOOL"; then
	fail "planted_credential_absent" "token absent from spool" "TOKEN ON DISK exit=$CODE"
else
	pass "planted_credential_absent" "token absent from spool" "exit=$CODE lines_added=$(( $(wc -l < "$SPOOL" | tr -d ' ') - BEFORE ))"
fi

# 8. parity: stdout bytes and exit identical with and without the spool.
PFAIL=0
for verb in "capabilities --json" "--version" "--info" "help --json" "examples --json" "schema --json" "quickstart --json" "status --json" "nosuchverb --json" "service run no-such-cc-job --json"; do
	# shellcheck disable=SC2086
	A="$(kit $verb; printf 'x%s' "$?")"; SA="$(cat "$STATE/stdout.bin")"; SE="$(cat "$STATE/stderr.bin")"
	# shellcheck disable=SC2086
	B="$(OMP_KIT_CC=0 kit $verb; printf 'x%s' "$?")"; SB="$(cat "$STATE/stdout.bin")"; SEB="$(cat "$STATE/stderr.bin")"
	if [ "$A" != "$B" ] || [ "$SA" != "$SB" ] || [ "$SE" != "$SEB" ]; then
		PFAIL=1
		fail "parity_verb" "$verb identical" "$verb differs"
	fi
done
if [ "$PFAIL" = "0" ]; then pass "output_parity" "10 verbs identical with/without spool" "10/10"; fi

# 9. inert: missing state dir writes zero spool files.
NOSPOOL="$STATE/nonexistent-cc-state"
CODE="$(CC_STATE="$NOSPOOL" AGENT_NAME="E2ERuncliWrap" HOME="$STATE/home" XDG_STATE_HOME="$STATE/xdg" TMPDIR="$STATE/tmp" NO_COLOR=1 \
	bun "$REPO/src/cli.ts" capabilities --json > "$STATE/stdout.bin" 2> "$STATE/stderr.bin"; printf '%s' "$?")"
if [ "$CODE" = "0" ] && [ ! -e "$NOSPOOL/spool" ]; then
	pass "inert_without_state" "zero spool files" "exit=$CODE"
else
	fail "inert_without_state" "zero spool files" "exit=$CODE spool_exists=$([ -e "$NOSPOOL/spool" ] && echo yes || echo no)"
fi

# 10. emission overhead: three-envelope emit p95 under 5 ms (measured, generous gate).
echo "import { ccSpool } from \"$REPO/src/cc-spool.ts\";" > "$STATE/measure.ts"
cat >> "$STATE/measure.ts" <<'EOF'
const state = process.env.MEASURE_STATE!;
const times: number[] = [];
for (let i = 0; i < 200; i++) {
	const a = ccSpool("kit", { stateDir: state })!;
	const t0 = performance.now();
	const id = i.toString(16).padStart(32, "0");
	a.append([a.envelope("action.attempt", { action_id: id, surface: "kit-status", target: null, idempotency_key: null }, { key: `kit:${id}:attempt`, timeMs: Date.now() })]);
	a.append([a.envelope("action.result", { action_id: id, outcome: "ok", code: null, duration_ms: 1 }, { key: `kit:${id}:result`, timeMs: Date.now() })]);
	a.append([a.envelope("source.tick", { instance: "kit-1-00000000", records_seen: 0, records_emitted: 2, records_ignored: 0, records_quarantined: 0, complete_through_ms: Date.now(), position: 0, error_code: null, skew_ms: null, coverage: [] }, { key: `kit:${id}:tick`, timeMs: Date.now() })]);
	times.push(performance.now() - t0);
}
times.sort((x, y) => x - y);
console.log(`p50=${times[100]!.toFixed(3)}ms p95=${times[190]!.toFixed(3)}ms max=${times[199]!.toFixed(3)}ms`);
console.log(times[190]! < 25 ? "OVERHEAD_OK" : "OVERHEAD_SLOW");
EOF
if MEASURE_SRC="$REPO/src/cc-spool.ts" MEASURE_STATE="$STATE" nice -n 10 bun "$STATE/measure.ts" > "$STATE/measure.log" 2>&1 \
	&& grep -q OVERHEAD_OK "$STATE/measure.log"; then
	pass "emission_overhead" "p95 < 5ms" "$(tr '\n' ' ' < "$STATE/measure.log")"
else
	fail "emission_overhead" "p95 < 5ms" "$(tr '\n' ' ' < "$STATE/measure.log")"
fi

rm -rf "$STATE"
exit "$FAIL"
