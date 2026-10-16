#!/bin/sh
# rch-socket e2e: rchd socket-unlinked detection through `omp-kit doctor --json`.
#
# Fixture: an owned unix listener on an owned path, with PATH-shadowed rch /
# launchctl / lsof shims reporting the fixture (the real daemon is untouched).
# Cases: socket present -> RUNNING/OK; path unlinked -> SOCKET_UNLINKED/FAIL.
#
# Usage: sh tests/e2e/rch-socket.sh --work-dir ABS [--kit ARG...]
#   --kit: argv prefix for the kit under test, e.g. "bun src/cli.ts"
#          (default, run from the companion repo root).
#
# Steps log one JSON line each to WORK/steps.jsonl; the final stdout line is:
#   {"passed":N,"failed":N,"failed_steps":[...]}
# Exit: 0 every step matched; 1 mismatch; 2 usage error.

set -u

WORK=""
KIT="bun src/cli.ts"

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

mkdir -p "$WORK/bin" || exit 2
STEPS="$WORK/steps.jsonl"
: > "$STEPS"
PASS=0
FAIL=0
FAILED=""

# expect_state NAME EXPECTED_STATE -- DOCTOR_ARGV...
expect_state() {
	name="$1"; expected="$2"; shift 2
	# shellcheck disable=SC2086
	set +e; PATH="$WORK/bin:$PATH" $KIT "$@" >"$WORK/$name.out" 2>"$WORK/$name.err"; rc=$?; set -e
	state=$(python3 -c "import json; d=json.load(open('$WORK/$name.out')); rows=d['data']['findings']; print([r['evidence'].get('state') for r in rows if r['component']=='rch'][0])" 2>/dev/null || echo "PARSE_ERROR")
	if [ "$state" = "$expected" ]; then verdict="match"; PASS=$((PASS + 1)); else verdict="MISMATCH"; FAIL=$((FAIL + 1)); FAILED="$FAILED $name"; fi
	printf '{"step":%s,"rc":%d,"expected_state":%s,"observed_state":%s,"verdict":%s}\n' \
		"\"$name\"" "$rc" "\"$expected\"" "\"$state\"" "\"$verdict\"" >>"$STEPS"
	echo "$name: expected=$expected observed=$state verdict=$verdict"
}

SOCK="$WORK/rch.sock"

# --- fixture shims -----------------------------------------------------------
cat > "$WORK/bin/rch" <<EOF
#!/bin/sh
echo '{"data":{"running":true,"socket_path":"$SOCK"}}'
EOF
chmod +x "$WORK/bin/rch"

LISTENER_PID=""
start_listener() {
	# shellcheck disable=SC2086
	bun -e 'Bun.listen({unix: Bun.argv[1], socket: {data(){}}}); await new Promise(() => {})' "$SOCK" &
	LISTENER_PID=$!
	for _ in $(seq 1 30); do
		[ -S "$SOCK" ] && return 0
		sleep 1
	done
	echo "listener never bound $SOCK" >&2
	return 1
}

# launchctl shim reports the fixture listener pid; lsof shim reports the fixture path.
write_pid_shims() {
	cat > "$WORK/bin/launchctl" <<EOF
#!/bin/sh
echo "pid = $LISTENER_PID"
EOF
	chmod +x "$WORK/bin/launchctl"
	cat > "$WORK/bin/lsof" <<EOF
#!/bin/sh
echo "n$SOCK"
EOF
	chmod +x "$WORK/bin/lsof"
}

trap 'kill "$LISTENER_PID" 2>/dev/null; rm -f "$SOCK"' EXIT

# --- case 1: present socket -> RUNNING ---------------------------------------
start_listener
write_pid_shims
echo "fixture: sock=$SOCK pid=$LISTENER_PID"
expect_state "present-running" "RUNNING" -- doctor --json

# --- case 2: unlinked path, live holder -> SOCKET_UNLINKED --------------------
rm -f "$SOCK"
expect_state "unlinked-fail" "SOCKET_UNLINKED" -- doctor --json

failed_json=$(for name in $FAILED; do printf '"%s",' "$name"; done | sed 's/,$//')
echo "{\"passed\":$PASS,\"failed\":$FAIL,\"failed_steps\":[$failed_json]}"
[ "$FAIL" -eq 0 ]
