#!/bin/bash
# CC7b TS spool adapter boundary (bead ompkit-fp72.120.16.11.3).
# Runs the bead's boundary in an owned temporary state dir, plants failures
# (credential line + unterminated tail fragment), and emits JSONL lines
# {bead_id, step, process, fixture_sha, as_of_ms, expected, actual, ok, exit}.
# Exits non-zero when a planted failure is not detected.
#
# Planted credential shapes are minted at runtime (never literals in this file).
set -u
BEAD="ompkit-fp72.120.16.11.3"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$REPO/var/agent-tmp/cc-cc7b-$$"
GOLDEN="$REPO/tests/fixtures/cc-spool-golden.jsonl"
OUT="$STATE/e2e.jsonl"
FAIL=0

mkdir -p "$STATE/spool"
as_of_ms() { python3 -c "import time; print(int(time.time()*1000))"; }
emit() { # step expected actual ok exit
	printf '{"bead_id":"%s","step":"%s","process":"%s","fixture_sha":"%s","as_of_ms":%s,"expected":"%s","actual":"%s","ok":%s,"exit":%s}\n' \
		"$BEAD" "$1" "e2e" "$SHA" "$(as_of_ms)" "$2" "$3" "$4" "$5" | tee -a "$OUT"
}
fail() { FAIL=1; emit "$1" "$2" "$3" "false" 1; }
pass() { emit "$1" "$2" "$3" "true" 0; }

SHA="$(python3 -c "import hashlib; print(hashlib.sha256(open('$GOLDEN','rb').read()).hexdigest())")"

# 1. parity: TS rebuilds every golden envelope byte-identically and appends them.
cat > "$STATE/parity.ts" <<'EOF'
import { readFileSync } from "node:fs";
const { ccSpool, canonical } = await import(process.env.SPOOL_SRC!);
const [golden, state] = process.argv.slice(2);
const rows = readFileSync(golden, "utf8").trim().split("\n").map((l) => JSON.parse(l));
let bad = 0;
for (const r of rows) {
	const a = ccSpool(r.producer, { stateDir: state, clock: () => r.observed_ms })!;
	const line = canonical(a.envelope(r.type, r.data, { key: r.key, timeMs: r.time_ms, observedMs: r.observed_ms }));
	if (line !== r.line) { console.error(`MISMATCH ${r.key}`); bad++;
	} else if (a.append([JSON.parse(line)]) !== 1) { console.error(`APPEND ${r.key}`); bad++; }
}
if (bad > 0) process.exit(1);
console.log(`parity ${rows.length}/${rows.length}`);
EOF
if SPOOL_SRC="$REPO/src/cc-spool.ts" nice -n 10 bun "$STATE/parity.ts" "$GOLDEN" "$STATE" > "$STATE/parity.log" 2>&1; then
	pass "parity" "5/5 byte-identical" "$(cat "$STATE/parity.log")"
else
	fail "parity" "5/5 byte-identical" "$(cat "$STATE/parity.log")"
fi

# 2. planted credential: a minted token-shaped target must become a U-redaction
# line, and the minted value must never reach the disk.
cat > "$STATE/redact.ts" <<'EOF'
import { readFileSync } from "node:fs";
import { join } from "node:path";
const { ccSpool, isoMs } = await import(process.env.SPOOL_SRC!);
const [state, token, nowS] = process.argv.slice(2);
const now = Number(nowS);
const a = ccSpool("kit", { stateDir: state, clock: () => now })!;
const env = a.envelope("action.attempt",
	{ action_id: "evil", surface: "cli", target: `leak ${token}`, idempotency_key: null },
	{ key: "verb:evil:e2e", timeMs: now });
if (a.append([env]) !== 1) { console.error("append refused"); process.exit(1); }
const day = isoMs(now).slice(0, 10);
const body = readFileSync(join(state, "spool", "kit", `${day}.jsonl`), "utf8");
if (body.includes(token)) { console.error("TOKEN ON DISK"); process.exit(1); }
const mine = body.trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.position === "verb:evil:e2e" || String(e.position).startsWith("redaction:"));
if (mine.length !== 1 || mine[0].type !== "cc.unknown" || mine[0].data.class !== "U-redaction") {
	console.error(`no single redaction line: ${JSON.stringify(mine)}`); process.exit(1);
}
console.log("redaction detected");
EOF
TOKEN="ghp_$(printf 'z%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36)"
NOW="$(as_of_ms)"
if SPOOL_SRC="$REPO/src/cc-spool.ts" nice -n 10 bun "$STATE/redact.ts" "$STATE" "$TOKEN" "$NOW" > "$STATE/redact.log" 2>&1; then
	pass "planted_credential_redacted" "U-redaction, token absent" "$(cat "$STATE/redact.log")"
else
	fail "planted_credential_redacted" "U-redaction, token absent" "$(cat "$STATE/redact.log")"
fi

# 3. ingest phase A: everything written so far ingests with 0 dead letters.
cat > "$STATE/ingest.py" <<'EOF'
import sys
from pathlib import Path
sys.path.insert(0, "/Users/josh/Developer/omp-kit/scripts/cc")
import cclib
state = Path(sys.argv[1])
con = cclib.open_store(state)
ing = cclib.Ingester(con, cclib.Registry(), state)
stats = ing.run_once(check_sources=False)
con.commit()
print(f"stored={stats['stored']} dead={stats['dead']}")
EOF
if OUT_A="$(cd /Users/josh/Developer/omp-kit && nice -n 10 python3 "$STATE/ingest.py" "$STATE" 2> "$STATE/ingestA.err")"; then
	DEAD_A="$(printf '%s' "$OUT_A" | sed -n 's/.*dead=\([0-9]*\).*/\1/p')"
	if [ "$DEAD_A" = "0" ]; then pass "ingest_clean" "dead=0" "$OUT_A"; else fail "ingest_clean" "dead=0" "$OUT_A"; fi
else
	fail "ingest_clean" "dead=0" "$(cat "$STATE/ingestA.err")"
fi

# 4. planted unterminated tail: fragment stands alone; ingester dead-letters only the fragment.
DAY="$(python3 -c "import datetime; print(datetime.datetime.fromtimestamp($NOW/1000, datetime.timezone.utc).strftime('%Y-%m-%d'))")"
mkdir -p "$STATE/spool/jobs"
printf '{"fragment": tru' >> "$STATE/spool/jobs/$DAY.jsonl"
cat > "$STATE/tail.ts" <<'EOF'
import { readFileSync } from "node:fs";
import { join } from "node:path";
const { ccSpool } = await import(process.env.SPOOL_SRC!);
const [state, day, nowS] = process.argv.slice(2);
const now = Number(nowS);
const a = ccSpool("jobs", { stateDir: state, clock: () => now })!;
const env = a.envelope("action.attempt",
	{ action_id: "t", surface: "cli", target: null, idempotency_key: null },
	{ key: "verb:tail:e2e", timeMs: now });
if (a.append([env]) !== 1) { console.error("append failed"); process.exit(1); }
const lines = readFileSync(join(state, "spool", "jobs", `${day}.jsonl`), "utf8").split("\n");
if (lines[0] !== '{"fragment": tru' || JSON.parse(lines[1]).id !== env.id) {
	console.error(`tail merge: ${JSON.stringify(lines)}`); process.exit(1);
}
console.log("tail terminated");
EOF
if SPOOL_SRC="$REPO/src/cc-spool.ts" nice -n 10 bun "$STATE/tail.ts" "$STATE" "$DAY" "$NOW" > "$STATE/tail.log" 2>&1; then
	pass "planted_tail_terminated" "fragment stands alone" "$(cat "$STATE/tail.log")"
else
	fail "planted_tail_terminated" "fragment stands alone" "$(cat "$STATE/tail.log")"
fi

# 5. ingest phase B: exactly one new dead letter (the fragment), valid tail line stored.
if OUT_B="$(cd /Users/josh/Developer/omp-kit && nice -n 10 python3 "$STATE/ingest.py" "$STATE" 2> "$STATE/ingestB.err")"; then
	DEAD_B="$(printf '%s' "$OUT_B" | sed -n 's/.*dead=\([0-9]*\).*/\1/p')"
	if [ "$DEAD_B" = "1" ]; then pass "ingest_fragment_dead" "dead=1" "$OUT_B"; else fail "ingest_fragment_dead" "dead=1" "$OUT_B"; fi
else
	fail "ingest_fragment_dead" "dead=1" "$(cat "$STATE/ingestB.err")"
fi

rm -rf "$STATE"
exit "$FAIL"
