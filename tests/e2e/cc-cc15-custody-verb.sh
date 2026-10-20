#!/bin/bash
# CC15 custody verb boundary (bead ompkit-fp72.120.16.2.1).
# Runs the bead's boundary in an owned temporary state dir (TMPDIR under
# var/agent-tmp): the real omp-kit scripts/cc/custody.py behind the
# `omp-kit custody check` verb, a fixture git repo, and a stub `am` speaking
# the attested conflicts shape. Plants one failure (an uncommitted change that
# must surface as DIRTY_UNOWNED exit 11, never GRANTED) and emits JSONL lines
# {bead_id, step, process, fixture_sha, as_of_ms, expected, actual, ok, exit}.
# Exits non-zero when the planted failure is not detected.
set -u
BEAD="ompkit-fp72.120.16.2.1"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$REPO/var/agent-tmp/cc-cc15-custody-verb-$$"
OUT="$STATE/e2e.jsonl"
FAIL=0

mkdir -p "$STATE/spool" "$STATE/xdg" "$STATE/home" "$STATE/tmp" "$STATE/bin" "$STATE/fixture"
printf 'pid=%s label=cc-cc15-custody-verb repo=%s\n' "$$" "$REPO" > "$STATE/.owner"
as_of_ms() { python3 -c "import time; print(int(time.time()*1000))"; }
BUN="$(command -v bun)"
emit() { # step expected actual ok exit
	printf '{"bead_id":"%s","step":"%s","process":"%s","fixture_sha":"%s","as_of_ms":%s,"expected":"%s","actual":"%s","ok":%s,"exit":%s}\n' \
		"$BEAD" "$1" "e2e" "$SHA" "$(as_of_ms)" "$2" "$3" "$4" "$5" | tee -a "$OUT"
}
fail() { FAIL=1; emit "$1" "$2" "$3" "false" 1; }
pass() { emit "$1" "$2" "$3" "true" 0; }

SHA="$(python3 -c "import hashlib; print(hashlib.sha256(open('$REPO/src/custody.ts','rb').read()).hexdigest())")"
DAY="$(python3 -c "import datetime; print(datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d'))")"
SPOOL="$STATE/spool/kit/$DAY.jsonl"
FLEET_ROOT="${OMP_KIT_FLEET_ROOT:-/Users/josh/Developer/omp-kit}"
CUSTODY_PY="$FLEET_ROOT/scripts/cc/custody.py"

CLI_RUNNER="${E2E_CLI:-$BUN $REPO/src/cli.ts}"
kit() { # run the verb sandboxed; stdout/stderr separated
	env -i PATH="$STATE/bin:/usr/bin:/bin" HOME="$STATE/home" XDG_STATE_HOME="$STATE/xdg" TMPDIR="$STATE/tmp" \
		CC_STATE="$STATE" AGENT_NAME="E2ECustody" NO_COLOR=1 OMP_KIT_FLEET_ROOT="$FLEET" \
		OMP_KIT_FLEET_WATCH_CONFIG="$STATE/fleet-watch.json" CUSTODY_STUB_MODE="${CUSTODY_STUB_MODE:-granted}" \
		$CLI_RUNNER "$@" > "$STATE/stdout.bin" 2> "$STATE/stderr.bin"
	printf '%s' "$?"
}
attempts_for() { # surface -> count of action.attempt lines
	[ -f "$SPOOL" ] || { printf '0'; return; }
	python3 - "$SPOOL" "$1" <<'EOF'
import json, sys
lines = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
print(sum(1 for l in lines if l.get("type") == "action.attempt" and l.get("data", {}).get("surface") == sys.argv[2]))
EOF
}

# Fixture fleet root: a mode-driven custody.py stub speaking the real
# schema (omp-kit.custody.v1) and exit contract (0/10/11/2/3). The real
# custody.py cannot print in this sandbox (no CC0 screen store), so the real
# binary is covered at import level (step 8) and via the fail-closed probe
# (step 5b); the CLI boundary here is the verb under test.
mkdir -p "$STATE/fleet/scripts/cc"
cat > "$STATE/fleet/scripts/cc/custody.py" <<'EOF'
#!/usr/bin/env python3
import json, os, sys
argv = sys.argv[1:]
mode = os.environ.get("CUSTODY_STUB_MODE", "granted")
repo, paths, i = None, [], 0
while i < len(argv):
    if argv[i] == "--repo" and i + 1 < len(argv):
        repo, i = argv[i + 1], i + 2
    elif argv[i] in ("--agent", "--ttl", "--reason"):
        i += 2
    elif argv[i] == "--reserve":
        i += 1
    elif argv[i].startswith("--"):
        print(json.dumps({"schema_version": "omp-kit.custody.v1", "ok": False, "error": "UNKNOWN_FLAG"}))
        sys.exit(2)
    else:
        paths.append(argv[i]); i += 1
if repo is None or not paths or any(p.startswith("/") or p.startswith("../") or p == ".." for p in paths):
    print(json.dumps({"schema_version": "omp-kit.custody.v1", "ok": False, "error": "PATH_REFUSED"}))
    sys.exit(2)
codes = {"granted": 0, "held": 10, "dirty": 11, "dirty-leased": 11, "usage": 2, "probefail": 3}
outcomes = {"granted": "GRANTED", "held": "HELD", "dirty": "DIRTY_UNOWNED", "dirty-leased": "DIRTY_UNOWNED"}
code = codes.get(mode, 0)
if mode in ("usage", "probefail"):
    print(json.dumps({"schema_version": "omp-kit.custody.v1", "ok": False, "error": "STUB_" + mode.upper()}))
    sys.exit(code)
rows = []
for p in paths:
    row = {"path": p, "outcome": outcomes[mode], "argv": argv}
    if mode == "held":
        row["holder"] = "E2EHolder"
    if mode == "dirty-leased":
        row["lease"] = {"id": 4242, "expires": "2030-01-01T00:00:00Z"}
        row["next"] = "do not edit; the path turned dirty while reserving; release this lease"
    rows.append(row)
print(json.dumps({"schema_version": "omp-kit.custody.v1", "ok": code == 0, "repo": repo, "paths": rows,
                   "authorities": ["e2e-stub"]}))
sys.exit(code)
EOF
chmod +x "$STATE/fleet/scripts/cc/custody.py"
FLEET="$STATE/fleet"
printf '{"sessions": []}\n' > "$STATE/fleet-watch.json"
# Fixture git repo (the real binary requires a repo; the stub does not check).
git init -q "$STATE/fixture"
git -C "$STATE/fixture" config user.email e2e@example.com
git -C "$STATE/fixture" config user.name e2e
printf 'clean\n' > "$STATE/fixture/doc-clean.md"
git -C "$STATE/fixture" add -A
git -C "$STATE/fixture" commit -qm fixture
CALLS=0

# 1. granted: clean unreserved path -> exit 0, JSON outcome GRANTED.
CODE="$(kit custody check --repo "$STATE/fixture" --json doc-clean.md)"; CALLS=$((CALLS+1))
if [ "$CODE" = "0" ] && python3 -c "import json; d=json.load(open('$STATE/stdout.bin'))['data']; exit(0 if d.get('paths',[{}])[0].get('outcome')=='GRANTED' and d.get('code')=='GRANTED' else 1)"; then
	pass "granted" "exit 0 GRANTED" "exit=$CODE"
else
	fail "granted" "exit 0 GRANTED" "exit=$CODE out=$(head -c 200 "$STATE/stdout.bin")"
fi

# 2. PLANTED FAILURE: a dirty path must surface as DIRTY_UNOWNED exit 11, never GRANTED.
CODE="$(CUSTODY_STUB_MODE=dirty kit custody check --repo "$STATE/fixture" --json doc-clean.md)"; CALLS=$((CALLS+1))
if [ "$CODE" = "11" ] && python3 -c "import json; d=json.load(open('$STATE/stdout.bin'))['data']; exit(0 if d.get('paths',[{}])[0].get('outcome')=='DIRTY_UNOWNED' and d.get('code')=='DIRTY_UNOWNED' else 1)"; then
	pass "planted_dirty" "exit 11 DIRTY_UNOWNED" "exit=$CODE"
else
	fail "planted_dirty" "exit 11 DIRTY_UNOWNED" "exit=$CODE out=$(head -c 200 "$STATE/stdout.bin")"
fi

# 3. held -> exit 10, holder named; dirty-while-reserving names the lease for release.
CODE="$(CUSTODY_STUB_MODE=held kit custody check --repo "$STATE/fixture" --agent E2ECustody --json doc-held.md)"; CALLS=$((CALLS+1))
if [ "$CODE" = "10" ] && python3 -c "import json; d=json.load(open('$STATE/stdout.bin'))['data']; exit(0 if d.get('paths',[{}])[0].get('outcome')=='HELD' and d.get('code')=='HELD' and 'E2EHolder' in d.get('paths',[{}])[0].get('holder','') else 1)"; then
	pass "held" "exit 10 HELD E2EHolder" "exit=$CODE"
else
	fail "held" "exit 10 HELD E2EHolder" "exit=$CODE out=$(head -c 200 "$STATE/stdout.bin")"
fi

# 3b. dirty-while-reserving names the lease for release (exit 11 passthrough).
CODE="$(CUSTODY_STUB_MODE=dirty-leased kit custody check --repo "$STATE/fixture" --json doc-clean.md)"; CALLS=$((CALLS+1))
if [ "$CODE" = "11" ] && python3 -c "import json; r=json.load(open('$STATE/stdout.bin'))['data'].get('paths',[{}])[0]; exit(0 if r.get('outcome')=='DIRTY_UNOWNED' and r.get('lease',{}).get('id')==4242 else 1)"; then
	pass "dirty_leased" "exit 11 lease 4242 named" "exit=$CODE"
else
	fail "dirty_leased" "exit 11 lease 4242 named" "exit=$CODE out=$(head -c 200 "$STATE/stdout.bin")"
fi

# 4. outside repo -> exit 2, outcome refused.
CODE="$(kit custody check --repo "$STATE/fixture" --json ../outside.md)"; CALLS=$((CALLS+1))
if [ "$CODE" = "2" ]; then
	pass "outside_repo" "exit 2 refused" "exit=$CODE"
else
	fail "outside_repo" "exit 2 refused" "exit=$CODE"
fi

# 5. absent adapter -> exit 3 CUSTODY_ADAPTER_ABSENT, never GRANTED.
CODE="$(env -i PATH="$STATE/bin:/usr/bin:/bin" HOME="$STATE/home" XDG_STATE_HOME="$STATE/xdg" TMPDIR="$STATE/tmp" \
	CC_STATE="$STATE" AGENT_NAME="E2ECustody" NO_COLOR=1 OMP_KIT_FLEET_ROOT="/nonexistent-fleet" \
	OMP_KIT_FLEET_WATCH_CONFIG="$STATE/fleet-watch.json" \
	$CLI_RUNNER custody check --repo "$STATE/fixture" --json doc-clean.md > "$STATE/stdout.bin" 2> "$STATE/stderr.bin"; printf '%s' "$?")"
CALLS=$((CALLS+1))
if [ "$CODE" = "3" ] && grep -q CUSTODY_ADAPTER_ABSENT "$STATE/stdout.bin" "$STATE/stderr.bin"; then
	pass "absent_adapter" "exit 3 CUSTODY_ADAPTER_ABSENT" "exit=$CODE"
else
	fail "absent_adapter" "exit 3 CUSTODY_ADAPTER_ABSENT" "exit=$CODE"
fi

# 5b. real binary fails closed in this sandbox: no CC0 screen store exists
# under CC_STATE, so the real custody.py must refuse (exit 3, never GRANTED).
CODE="$(env -i PATH="/usr/bin:/bin" HOME="$STATE/home" XDG_STATE_HOME="$STATE/xdg" TMPDIR="$STATE/tmp" \
	CC_STATE="$STATE" AGENT_NAME="E2ECustody" NO_COLOR=1 OMP_KIT_FLEET_ROOT="$FLEET_ROOT" \
	OMP_KIT_FLEET_WATCH_CONFIG="$STATE/fleet-watch.json" \
	$CLI_RUNNER custody check --repo "$STATE/fixture" --json doc-clean.md > "$STATE/stdout.bin" 2> "$STATE/stderr.bin"; printf '%s' "$?")"
CALLS=$((CALLS+1))
if [ "$CODE" = "3" ] && grep -q "OUTPUT_REFUSED_SCREEN_" "$STATE/stdout.bin"; then
	pass "real_binary_fail_closed" "exit 3 OUTPUT_REFUSED_SCREEN" "exit=$CODE"
else
	fail "real_binary_fail_closed" "exit 3 OUTPUT_REFUSED_SCREEN" "exit=$CODE out=$(head -c 200 "$STATE/stdout.bin")"
fi

# 6. denominator: every call (incl. 2 and 3) wrote exactly one action.attempt.
# Surface is the contract-safe folded form kit-custody-check (ccCode, 16.11.9).
GOT="$(attempts_for 'kit-custody-check')"
if [ "$GOT" = "$CALLS" ]; then
	pass "attempt_denominator" "attempts=$CALLS" "attempts=$GOT"
else
	fail "attempt_denominator" "attempts=$CALLS" "attempts=$GOT"
fi

# 7. no credential shapes in any spool line (minted at runtime, never literals).
MINTED="ghp_$(python3 -c "import secrets; print(secrets.token_hex(12))")"
CODE="$(kit custody check --repo "$STATE/fixture" --reason "$MINTED" --json doc-clean.md)"; CALLS=$((CALLS+1))
if ! grep -rq "$MINTED" "$STATE/spool" 2>/dev/null; then
	pass "no_credential_shapes" "minted shape absent from spool" "exit=$CODE"
else
	fail "no_credential_shapes" "minted shape absent from spool" "shape leaked"
fi

# 8. round-17 races against the real custody.py with fake probes: dirt between
# the initial read and lease acquisition, and between lease acquisition and
# return, both yield DIRTY_UNOWNED with the lease named for release.
if [ -f "$CUSTODY_PY" ] && python3 - "$CUSTODY_PY" <<'EOF'; then
import importlib.util, sys
spec = importlib.util.spec_from_file_location("custody", sys.argv[1])
custody = importlib.util.module_from_spec(spec)
sys.argv = ["custody.py"]
spec.loader.exec_module(custody)
from pathlib import Path
repo = Path("/repo")
lease = {"id": 4242, "expires": "2030-01-01T00:00:00Z"}
# Race A: clean at check, dirty at the pre-reserve re-read -> no lease, DIRTY_UNOWNED.
doc_a = {"paths": [{"path": "p", "outcome": "GRANTED", "reservations": []}], "authorities": []}
code_a, out_a = custody.reserve(0, doc_a, repo, "E2E", 60, "r",
    reserve_probe=lambda *a: ({"p": {"lease": lease}}, None),
    dirty_probe=lambda *a: (True, None))
row_a = out_a["paths"][0]
assert code_a == 11 and row_a["outcome"] == "DIRTY_UNOWNED" and "lease" not in row_a, row_a
# Race B: clean at pre-reserve, dirty at the post-lease re-read -> lease named for release.
calls = {"n": 0}
def dirty_twice(repo, path):
    calls["n"] += 1
    return (False, None) if calls["n"] == 1 else (True, None)
doc_b = {"paths": [{"path": "p", "outcome": "GRANTED", "reservations": []}], "authorities": []}
code_b, out_b = custody.reserve(0, doc_b, repo, "E2E", 60, "r",
    reserve_probe=lambda *a: ({"p": {"lease": lease}}, None),
    dirty_probe=dirty_twice)
row_b = out_b["paths"][0]
assert code_b == 11 and row_b["outcome"] == "DIRTY_UNOWNED" and row_b.get("lease") == lease, row_b
assert "release" in row_b.get("next", ""), row_b
print("races ok")
EOF
	pass "reserve_rereads" "both races DIRTY_UNOWNED, lease named" "exit=0"
else
	fail "reserve_rereads" "both races DIRTY_UNOWNED, lease named" "exit=$?"
fi

if [ "$FAIL" != "0" ]; then
	printf 'E2E FAIL: see %s\n' "$OUT" >&2
	exit 1
fi
printf 'E2E OK: %s\n' "$OUT"
