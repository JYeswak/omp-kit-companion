#!/bin/sh
# tern-ref e2e: build -> query -> validate -> drift against a hermetic local
# fixture site, plus the three mutant kills from ompkit-fp72.120.8.
#
# Usage: sh tests/e2e/tern-ref.e2e.sh --work-dir ABS [--kit ARG...]
#   --work-dir: scratch root (created if absent); everything stays beneath it.
#   --kit: argv prefix for the kit under test, e.g. "bun src/cli.ts"
#          (default, run from the companion repo root).
#
# Steps log one JSON line each to WORK/steps.jsonl:
#   {step, argv, rc, expected_rc, verdict}
# and the final stdout line is a JSON summary:
#   {"passed":N,"failed":N,"failed_steps":[...]}
#
# Exit: 0 every step matched; 1 at least one mismatch; 2 usage error.

set -u

WORK=""
KIT="bun src/cli.ts"
PORT=18391

while [ $# -gt 0 ]; do
	case "$1" in
		--work-dir) WORK="${2:?--work-dir needs a value}"; shift 2 ;;
		--kit) KIT="${2:?--kit needs a value}"; shift 2 ;;
		*) echo "usage: $0 --work-dir ABS [--kit ARGV]" >&2; exit 2 ;;
	esac
done

case "$WORK" in
	/*) ;;
	*) echo "e2e needs an absolute --work-dir" >&2; exit 2 ;;
esac

mkdir -p "$WORK" || exit 2
STEPS="$WORK/steps.jsonl"
: > "$STEPS"
PASS=0
FAIL=0
FAILED=""

# step NAME EXPECTED_RC -- ARGV...
step() {
	name="$1"; expected="$2"; shift 2
	# shellcheck disable=SC2086
	set +e; $KIT "$@" >"$WORK/$name.out" 2>"$WORK/$name.err"; rc=$?; set -e
	if [ "$rc" = "$expected" ]; then verdict="match"; PASS=$((PASS + 1)); else verdict="MISMATCH"; FAIL=$((FAIL + 1)); FAILED="$FAILED $name"; fi
	printf '{"step":%s,"argv":%s,"rc":%d,"expected_rc":%d,"verdict":%s}\n' \
		"\"$name\"" "\"$KIT $*\"" "$rc" "$expected" "\"$verdict\"" >>"$STEPS"
}

need_file() {
	if [ ! -f "$1" ]; then echo "missing fixture: $1" >&2; exit 2; fi
}

REPO="$(pwd)"
need_file "$REPO/tests/cli/fixtures/tern-ref-checks.jsonl"

# --- fixture site -----------------------------------------------------------
# Pages live under /tern/ so the build's --prefix /tern/ crawl scope matches,
# exactly like the real docs site. Links stay relative.
SITE="$WORK/site"
mkdir -p "$SITE/tern"
cat >"$SITE/tern/index.html" <<'EOF'
<html><head><title>Tern test docs</title></head><body><main>
<h1>Test plugin SDK</h1>
<p>Register an export with carly export.</p>
<a href="run.html">run</a> <a href="serve.html">serve</a>
</main></body></html>
EOF
cat >"$SITE/tern/run.html" <<'EOF'
<html><head><title>run</title></head><body><main>
<h1>run</h1><p>Types a command line and Enter into the focused pane.</p>
<a href="index.html">index</a>
</main></body></html>
EOF
cat >"$SITE/tern/serve.html" <<'EOF'
<html><head><title>serve</title></head><body><main>
<h1>serve</h1><p>A headless session on a control endpoint, until quit.</p>
<a href="index.html">index</a>
</main></body></html>
EOF
cat >"$WORK/queries.jsonl" <<'EOF'
{"qid":"e1","query":"how do I register an export","intent":"export"}
{"qid":"e2","query":"headless session until quit","intent":"serve"}
EOF

python3 -m http.server "$PORT" --directory "$SITE" >"$WORK/server.out" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT INT TERM
sleep 1

REF="$WORK/ref"
SITE_URL="http://127.0.0.1:$PORT/tern/index.html"
VER="$(tern --version | sed -n 's/^tern \([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p')"
case "$VER" in
	[0-9]*.[0-9]*.[0-9]*) ;;
	*) echo "cannot parse installed tern version" >&2; exit 2 ;;
esac

# --- 1. build ---------------------------------------------------------------
step build 0 tern-ref build --root "$REF" --site "$SITE_URL" --json
MANIFEST="$REF/$VER/manifest.json"
if [ -f "$MANIFEST" ]; then verdict_note="manifest present"; else verdict_note="manifest MISSING"; fi

# --- 2. query both backends --------------------------------------------------
step query-nomic 0 tern-ref query --root "$REF" --query "register an export" --backend nomic --k 3 --json
step query-qwen 0 tern-ref query --root "$REF" --query "headless session" --backend qwen --k 3 --json

# --- 3. validate runtime checks (planted false claim must fail inside) -------
LIVE_SOCK="/tmp/tern.sock" # tempsafe: live tern socket path, only stat-checked
if [ -S "$LIVE_SOCK" ]; then
	LIVE_BEFORE="$(stat -f '%m %z' "$LIVE_SOCK" 2>/dev/null || stat -c '%Y %s' "$LIVE_SOCK")"
else
	LIVE_BEFORE="absent"
fi
step validate 0 tern-ref validate --root "$REF" --checks "$REPO/tests/cli/fixtures/tern-ref-checks.jsonl" --json
if [ -S "$LIVE_SOCK" ]; then
	LIVE_AFTER="$(stat -f '%m %z' "$LIVE_SOCK" 2>/dev/null || stat -c '%Y %s' "$LIVE_SOCK")"
else
	LIVE_AFTER="absent"
fi

# --- 4. drift clean, then mutated --------------------------------------------
step drift-clean 0 tern-ref drift --root "$REF" --site "$SITE_URL" --json
printf '<!-- drift -->\n' >>"$SITE/tern/serve.html"
step drift-dirty 0 tern-ref drift --root "$REF" --site "$SITE_URL" --json

# --- 5. mutant kills ----------------------------------------------------------
# M1: planted false claim reported as pass must refuse with PLANTED_PASSED.
cat >"$WORK/mutant-checks.jsonl" <<'EOF'
{"id":"mutant-planted-pass","run":["state"],"expect":["\"ok\":true"],"planted":true}
EOF
step mutant-planted 3 tern-ref validate --root "$REF" --checks "$WORK/mutant-checks.jsonl" --json
# M2: drift with a version-mismatched manifest must reindex, never clean.
python3 -c "
import json
p = '$MANIFEST'
m = json.load(open(p))
m['tern_version'] = '0.0.0-mutant'
json.dump(m, open(p, 'w'), indent=1)
"
step mutant-version 0 tern-ref drift --root "$REF" --site "$SITE_URL" --json

# --- assertions on artifacts --------------------------------------------------
assert() {
	name="$1"; shift
	set +e; "$@" >"$WORK/$name.out" 2>&1; rc=$?; set -e
	if [ "$rc" = 0 ]; then verdict="match"; PASS=$((PASS + 1)); else verdict="MISMATCH"; FAIL=$((FAIL + 1)); FAILED="$FAILED $name"; fi
	printf '{"step":%s,"argv":%s,"rc":%d,"expected_rc":%d,"verdict":%s}\n' \
		"\"$name\"" "\"$*\"" "$rc" 0 "\"$verdict\"" >>"$STEPS"
}

assert manifest-present test -f "$MANIFEST"
assert socket-under-work grep -q -F "$WORK/ref/validate-scratch/ctl.sock" "$WORK/validate.out"
assert config-under-work grep -q -F "$WORK/ref/validate-scratch/config" "$WORK/validate.out"
assert nomic-index test -d "$REF/$VER/idx-nomic"
assert qwen-index test -d "$REF/$VER/idx-qwen"
assert scratch-dir test -d "$REF/validate-scratch"
assert drift-saw-mutation grep -q "serve.html" "$WORK/drift-dirty.out"
assert mutant-planted-code grep -q "PLANTED_PASSED" "$WORK/mutant-planted.out"
assert version-forced-reindex grep -q "reindexed" "$WORK/mutant-version.out"
assert drift-kept-site grep -q "127.0.0.1" "$MANIFEST"
if [ "$LIVE_BEFORE" = "$LIVE_AFTER" ]; then
	assert live-socket-untouched true
else
	assert live-socket-untouched false
fi

kill $SERVER_PID 2>/dev/null
trap - EXIT INT TERM

# shellcheck disable=SC2086 # FAILED is space-joined by construction.
printf '{"passed":%d,"failed":%d,"failed_steps":[%s],"note":%s}\n' \
	"$PASS" "$FAIL" "$(printf '"%s",' $FAILED | sed 's/,$//')" "\"$verdict_note\""
