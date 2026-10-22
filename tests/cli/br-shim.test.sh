#!/bin/sh
# br-shim.test.sh — ID1 and CREATEBUDGET1 shim contract.
# A fake `br` records its argv; the shim under test sits ahead of it on PATH.
# Follows ~/AGENTS.md producer truth: every verdict comes from the recorded
# argv file plus the shim's exit code, never from a filtered excerpt.
set -u

SHIM=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/br-shim.sh
REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$SHIM")/.." && pwd)
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
. "$REPO_ROOT/scripts/kitlib-tmp.sh"
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP br-shim-test || exit 1

mkdir -p "$TMP/realbin" "$TMP/shimbindir" "$TMP/sendbin"
cat > "$TMP/realbin/br" <<'EOF'
#!/bin/sh
# SYNC1 box 4: answer `show` with canned bead JSON for the close gate;
# the creation guard reads a complete issue envelope before dispatch.
if [ "$1" = "show" ]; then
	cat "$BR_GUARD_JSON_FILE"
	exit 0
fi
if [ "$1" = "list" ]; then
	cat "$BR_CREATE_FIXTURE"
	exit 0
fi
if [ "$1" = "create" ] && printf '%s\n' "$@" | grep -Fqx -- "--help"; then
	printf 'Usage: br create [OPTIONS] [TITLE]\n'
	exit 0
fi
printf '%s\n' "$@" > "$BR_SHIM_TEST_ARGV"
if [ -n "${BR_CREATE_LOG:-}" ]; then
	printf '<%s>' "$@" >> "$BR_CREATE_LOG"
	printf '\n' >> "$BR_CREATE_LOG"
fi
if [ "$1" = "create" ]; then
	create_id=${BR_CREATE_ID:-new-p0}
	create_title=${BR_CREATE_TITLE:-new issue}
	create_priority=${BR_CREATE_PRIORITY:-2}
	if [ -n "${BR_CREATE_CREATED:-}" ]; then printf '%s\n' "$create_id" >> "$BR_CREATE_CREATED"; fi
	if { [ "$create_priority" = "0" ] || [ "$create_priority" = "P0" ]; } && [ -n "${BR_CREATE_P0_STATE:-}" ]; then
		printf '%s\n' "$create_id" >> "$BR_CREATE_P0_STATE"
	fi
	if [ -n "${BR_CREATE_GATE_DIR:-}" ]; then
		: > "$BR_CREATE_GATE_DIR/entered-$create_id"
		while [ ! -f "$BR_CREATE_GATE_DIR/release" ]; do sleep 0.01; done
	fi
	if [ "${BR_CREATE_MUTATE_FIXTURE:-0}" = "1" ]; then
		python3 - "$BR_CREATE_FIXTURE" "$create_id" "$create_title" "$create_priority" "${AGENT_NAME:-}" <<'PY'
import datetime, json, sys
path, issue_id, title, priority, actor = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    payload = json.load(handle)
rows = payload["issues"] if isinstance(payload, dict) else payload
rows.append({"id": issue_id, "title": title, "status": "open", "priority": int(priority.removeprefix("P")),
             "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
             "created_by": actor})
if isinstance(payload, dict):
    payload["total"] = len(rows)
with open(path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle)
PY
	fi
	if printf '%s\n' "$@" | grep -Fqx -- "--json"; then
		printf '{"id":"%s","title":"%s","status":"open","priority":%s}\n' "$create_id" "$create_title" "$create_priority"
	fi
fi
exit 0
EOF
cat > "$TMP/realbin/am" <<'EOF'
#!/bin/sh
printf '<%s>' "${AM_FAKE_MODE:-clear}" >> "$AM_LOG"
for arg do printf ' <%s>' "$arg" >> "$AM_LOG"; done
printf '\n' >> "$AM_LOG"
mode=${AM_FAKE_MODE:-clear}
case "$mode:$1:$2" in
	unregistered:agents:show) printf 'AGENT_NOT_FOUND\n' >&2; exit 1 ;;
	unreachable:agents:show) printf 'AM_UNAVAILABLE\n' >&2; exit 7 ;;
	*:agents:show) printf '{"id":1,"name":"%s"}\n' "${AGENT_NAME:-}"; exit 0 ;;
	query-fail:file_reservations:conflicts) printf 'AM_UNAVAILABLE\n' >&2; exit 7 ;;
	foreign:file_reservations:conflicts)
		[ "$3" = "$AM_EXPECTED_PROJECT" ] || { printf 'wrong project\n' >&2; exit 9; }
		printf '1 conflict(s) found:\nPATH HOLDER PATTERN EXPIRES\n.beads/issues.jsonl OtherWorker .beads/issues.jsonl 2099-12-31T23:59:59Z\n'
		exit 0 ;;
	own:file_reservations:conflicts)
		[ "$3" = "$AM_EXPECTED_PROJECT" ] || { printf 'wrong project\n' >&2; exit 9; }
		printf '1 conflict(s) found:\nPATH HOLDER PATTERN EXPIRES\n.beads/issues.jsonl TestShim .beads/issues.jsonl 2099-12-31T23:59:59Z\n'
		exit 0 ;;
	foreign:file_reservations:list)
		[ "$3" = "$AM_EXPECTED_PROJECT" ] || { printf 'wrong project\n' >&2; exit 9; }
		printf 'ID PATTERN AGENT EXPIRES REASON\n42 .beads/issues.jsonl OtherWorker 2099-12-31T23:59:59Z fixture\n'
		exit 0 ;;
	*:file_reservations:conflicts)
		[ "$3" = "$AM_EXPECTED_PROJECT" ] || { printf 'wrong project\n' >&2; exit 9; }
		printf 'No conflicts detected.\n'
		exit 0 ;;
	*:file_reservations:list)
		printf 'ID PATTERN AGENT EXPIRES REASON\n'
		exit 0 ;;
	*) printf 'unexpected Agent Mail command\n' >&2; exit 99 ;;
esac
EOF
chmod +x "$TMP/realbin/am"
chmod +x "$TMP/realbin/br"
ln -s "$SHIM" "$TMP/shimbindir/br"
printf '{"id":"X","status":"in_progress","assignee":"OtherWorker","labels":[]}' > "$TMP/bead.json"
export BR_GUARD_JSON_FILE="$TMP/bead.json"
pass=0
fail=0
check() {
	name=$1
	want_rc=$2
	recorded=$(tr '\n' ' ' < "$TMP/argv" | sed 's/ $//')
	if [ "$got_rc" = "$want_rc" ] && [ "$recorded" = "$3" ]; then
		pass=$((pass + 1))
	else
		fail=$((fail + 1))
		printf 'FAIL %s: rc=%s argv<<<%s>>> want<<<%s>>>\n' "$name" "$got_rc" "$recorded" "$3"
	fi
}

export BR_CREATE_FIXTURE="$TMP/create-fixture.json"
export BR_CREATE_LOG="$TMP/create.log"
export BR_CREATE_ID="new-p0"
export BR_CREATE_TITLE="new issue"
printf '{"issues":[],"total":0,"offset":0,"has_more":false}\n' > "$BR_CREATE_FIXTURE"
cat > "$TMP/sendbin/omp-kit" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" >> "$OMP_KIT_SEND_LOG"
printf '{"status":"OK","overall":"OK"}\n'
EOF
chmod +x "$TMP/sendbin/omp-kit"
export OMP_KIT_SEND_LOG="$TMP/send.log"
export OMP_KIT_FLEET_WATCH_CONFIG="$TMP/fleet-watch.json"
printf '{"sessions":[{"repo":"%s","coordinatorSession":"fixture-director","coordinatorPane":"%%57","p0Cap":1}]}\n' "$REPO_ROOT" > "$OMP_KIT_FLEET_WATCH_CONFIG"
export BR_SHIM_TEST_ARGV="$TMP/argv"
export AM_LOG="$TMP/am.log"
export AM_EXPECTED_PROJECT="$REPO_ROOT"
export AM_FAKE_MODE=clear
# The shim resolves the Agent Mail project from the tracker path; without BEADS_DB it falls back
# to `git rev-parse --show-toplevel`, which fails in the pre-push gate's git-less archive (every
# write case refused BR_SHIM_RESERVATION_UNKNOWN there while passing in a checkout). The archive
# also lacks the untracked .beads directory the path branch resolves through.
mkdir -p "$REPO_ROOT/.beads"
export BEADS_DB="$REPO_ROOT/.beads/beads.db"
: > "$AM_LOG"
export PATH="$TMP/shimbindir:$TMP/sendbin:$TMP/realbin:$PATH"
export AGENT_NAME="TestShim"

# 1. every write kind gets --actor appended when absent
for kind in "create --title t" "update X --status open" "comments add --message m X" "close X" "reopen X" "dep add X Y" "dep remove X Y" "label add X y" "label remove X y" "sync --flush-only" "q quick" "delete X"; do
	: > "$TMP/argv"
	# shellcheck disable=SC2086
	br $kind > "$TMP/out" 2>&1
	got_rc=$?
	case " $kind " in
		*" --actor "*) want="SHOULD NOT HAPPEN" ;;
		*) want="$kind --actor TestShim" ;;
	esac
	# normalize: recorded argv lines back to one line
	recorded=$(tr '\n' ' ' < "$TMP/argv" | sed 's/ $//')
	if [ "$got_rc" = "0" ] && [ "$recorded" = "$want" ]; then
		pass=$((pass + 1))
	else
		fail=$((fail + 1))
		printf 'FAIL inject [%s]: rc=%s argv<<<%s>>> want<<<%s>>>\n' "$kind" "$got_rc" "$recorded" "$want"
	fi
done

# 2. own name passes through unchanged (both spellings)
: > "$TMP/argv"
br close X --actor TestShim > "$TMP/out" 2>&1
got_rc=$?
check "own-name-space" 0 "close X --actor TestShim"
: > "$TMP/argv"
br close X --actor=TestShim > "$TMP/out" 2>&1
got_rc=$?
check "own-name-equals" 0 "close X --actor=TestShim"

# 3. another agent's name is refused and the real br never runs
: > "$TMP/argv"
br close X --actor YellowSalmon > "$TMP/out" 2>&1
got_rc=$?
if [ "$got_rc" = "4" ] && [ ! -s "$TMP/argv" ] && grep -q "BR_SHIM_ACTOR_MISMATCH" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL wrong-actor: rc=%s out<<<%s>>>\n' "$got_rc" "$(cat "$TMP/out")"
fi
: > "$TMP/argv"
br close X --actor=YellowSalmon > "$TMP/out" 2>&1
got_rc=$?
if [ "$got_rc" = "4" ] && [ ! -s "$TMP/argv" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL wrong-actor-equals: rc=%s\n' "$got_rc"
fi

# 4. no AGENT_NAME refuses
: > "$TMP/argv"
env -u AGENT_NAME br close X > "$TMP/out" 2>&1
got_rc=$?
if [ "$got_rc" = "4" ] && [ ! -s "$TMP/argv" ] && grep -q "BR_SHIM_IDENTITY_REQUIRED" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL no-identity: rc=%s out<<<%s>>>\n' "$got_rc" "$(cat "$TMP/out")"
fi

# 5. without the shim on PATH the wrong actor passes through (enforcement lives in the shim)
export PATH="$TMP/realbin:/usr/bin:/bin"
: > "$TMP/argv"
br close X --actor YellowSalmon > "$TMP/out" 2>&1
got_rc=$?
check "no-shim-passthrough" 0 "close X --actor YellowSalmon"

# 6. BR_REAL is honored over PATH resolution
export PATH="$TMP/shimbindir:$TMP/realbin:$PATH"
mkdir -p "$TMP/otherbin"
cp "$TMP/realbin/br" "$TMP/otherbin/br"
: > "$TMP/argv"
BR_REAL="$TMP/otherbin/br" br close X > "$TMP/out" 2>&1
got_rc=$?
check "br-real-honored" 0 "close X --actor TestShim"

# 7. a real binary that resolves to the shim itself is refused, never exec-looped
: > "$TMP/argv"
BR_REAL="$SHIM" br close X > "$TMP/out" 2>&1 & shim_pid=$!
waited=0
while kill -0 "$shim_pid" 2>/dev/null; do
	sleep 1
	waited=$((waited + 1))
	if [ "$waited" -ge 5 ]; then
		kill -9 "$shim_pid" 2>/dev/null
		fail=$((fail + 1))
		printf 'FAIL self-loop: exec loop, killed after 5s\n'
		break
	fi
done
wait "$shim_pid" 2>/dev/null
got_rc=$?
if [ "$got_rc" = "4" ] && grep -q "BR_SHIM_LOOP" "$TMP/out"; then
	pass=$((pass + 1))
elif [ "$waited" -lt 5 ]; then
	fail=$((fail + 1))
	printf 'FAIL self-loop: rc=%s out<<<%s>>>\n' "$got_rc" "$(cat "$TMP/out")"
fi

# 8. SYNC1 box 4: the close gate runs at review/grading entry.
# The claimant is refused before the real br sees the transition;
# anyone else passes through; non-review statuses are ungated.
export PATH="$TMP/shimbindir:$TMP/realbin:/usr/bin:/bin"
printf '{"id":"X","status":"in_progress","assignee":"TestShim","labels":[]}' > "$TMP/bead.json"
: > "$TMP/argv"
br update X --status in_review > "$TMP/out" 2>&1
got_rc=$?
if [ "$got_rc" = "4" ] && [ ! -s "$TMP/argv" ] && grep -q "holds the claim" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL review-entry-refused: rc=%s out<<<%s>>>\n' "$got_rc" "$(cat "$TMP/out")"
fi
: > "$TMP/argv"
br close X > "$TMP/out" 2>&1
got_rc=$?
if [ "$got_rc" = "4" ] && [ ! -s "$TMP/argv" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL close-refused: rc=%s\n' "$got_rc"
fi
printf '{"id":"X","status":"in_progress","assignee":"OtherWorker","labels":[]}' > "$TMP/bead.json"
: > "$TMP/argv"
br update X --status in_review > "$TMP/out" 2>&1
got_rc=$?
check "review-entry-passes" 0 "update X --status in_review --actor TestShim"
: > "$TMP/argv"
br update X --status open > "$TMP/out" 2>&1
got_rc=$?
check "non-review-ungated" 0 "update X --status open --actor TestShim"
printf '{"id":"X","status":"in_progress","assignee":"TestShim","labels":["reviewer-fresh-context:muse"]}' > "$TMP/bead.json"
: > "$TMP/argv"
br close X > "$TMP/out" 2>&1
got_rc=$?
check "fresh-context-label-refused" 4 ""
 
 printf '{"id":"X","status":"in_progress","assignee":"OtherWorker","labels":[]}' > "$TMP/bead.json"
 # LESSON1: a close whose reason carries no lesson is refused before the real br runs
 : > "$TMP/argv"
 br close X --reason "done, all green" > "$TMP/out" 2>&1
 got_rc=$?
 if [ "$got_rc" = "4" ] && [ ! -s "$TMP/argv" ] && grep -q "no Lesson" "$TMP/out"; then
 	pass=$((pass + 1))
 else
 	fail=$((fail + 1))
 	printf 'FAIL close-lesson-refused: rc=%s out<<<%s>>>\n' "$got_rc" "$(cat "$TMP/out")"
 fi
 # LESSON1: Lesson: none passes through to the real br
 : > "$TMP/argv"
 br close X --reason "done, all green" --transition-comment "none" > "$TMP/out" 2>&1
 got_rc=$?
 check "close-lesson-none-passes" 0 "close X --reason done, all green --transition-comment none --actor TestShim"
 
# 9. a caller's own exclusive lease does not block its write
printf '{"id":"X","status":"in_progress","assignee":"OtherWorker","labels":[]}' > "$TMP/bead.json"
AM_FAKE_MODE=own
: > "$TMP/argv"
: > "$AM_LOG"
br update X --status open > "$TMP/out" 2>&1
got_rc=$?
recorded=$(tr '\n' ' ' < "$TMP/argv" | sed 's/ $//')
if [ "$got_rc" = "0" ] && [ "$recorded" = "update X --status open --actor TestShim" ] \
	&& grep -Fq '<file_reservations> <conflicts>' "$AM_LOG" \
	&& ! grep -Fq '<file_reservations> <list>' "$AM_LOG"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL own-lease-passes: rc=%s argv<<<%s>>> am<<<%s>>>\n' "$got_rc" "$recorded" "$(cat "$AM_LOG")"
fi

# 10. Agent Mail uses the explicit --db project over BEADS_DB
mkdir -p "$TMP/db-project/.beads"
AM_FAKE_MODE=clear
AM_EXPECTED_PROJECT="$TMP/db-project"
: > "$TMP/argv"
: > "$AM_LOG"
BEADS_DB="$TMP/ignored/.beads/beads.db" br --db "$TMP/db-project/.beads/beads.db" update X --status open > "$TMP/out" 2>&1
got_rc=$?
recorded=$(tr '\n' ' ' < "$TMP/argv" | sed 's/ $//')
if [ "$got_rc" = "0" ] && [ "$recorded" = "--db $TMP/db-project/.beads/beads.db update X --status open --actor TestShim" ] \
	&& grep -Fq "<$TMP/db-project>" "$AM_LOG" \
	&& grep -Fq "<.beads/issues.jsonl>" "$AM_LOG" && grep -Fq "<.beads/beads.db>" "$AM_LOG"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL db-project-and-target-paths: rc=%s argv<<<%s>>> am<<<%s>>>\n' "$got_rc" "$recorded" "$(cat "$AM_LOG")"
fi
AM_EXPECTED_PROJECT="$REPO_ROOT"

# 11. read-only commands never consult Agent Mail
AM_FAKE_MODE=unreachable
: > "$AM_LOG"
for kind in "show X" "list" "ready" "search token" "sync --status"; do
	: > "$TMP/argv"
	# shellcheck disable=SC2086
	br $kind > "$TMP/out" 2>&1
	got_rc=$?
	if [ "$got_rc" != "0" ]; then
		fail=$((fail + 1))
		printf 'FAIL read-only [%s]: rc=%s out<<<%s>>>\n' "$kind" "$got_rc" "$(cat "$TMP/out")"
	fi
done
if [ ! -s "$AM_LOG" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL readonly-called-am: %s\n' "$(cat "$AM_LOG")"; fi

# 12. every mutating command refuses a foreign exclusive lease before reaching real br
AM_FAKE_MODE=foreign
for kind in "create --title t" "update X --status open" "update X --status in_review" \
	"close X" "reopen X" "comments add --message m X" "dep add X Y" "dep remove X Y" \
	"label add X y" "label remove X y" "sync --flush-only" "delete X"; do
	: > "$TMP/argv"
	: > "$AM_LOG"
	# shellcheck disable=SC2086
	br $kind > "$TMP/out" 2>&1
	got_rc=$?
	if [ "$got_rc" = "4" ] && [ ! -s "$TMP/argv" ] \
		&& grep -Fq "OtherWorker" "$TMP/out" \
		&& grep -Fq "reservation=42" "$TMP/out" \
		&& grep -Fq "2099-12-31T23:59:59Z" "$TMP/out"; then
		pass=$((pass + 1))
	else
		fail=$((fail + 1))
		printf 'FAIL foreign-lease [%s]: rc=%s argv<<<%s>>> out<<<%s>>>\n' "$kind" "$got_rc" "$(cat "$TMP/argv")" "$(cat "$TMP/out")"
	fi
done

# 13. unknown identity, unreachable Agent Mail and failed conflict reads all refuse
for mode in unregistered unreachable query-fail; do
	AM_FAKE_MODE=$mode
	: > "$TMP/argv"
	: > "$AM_LOG"
	br update X --status open > "$TMP/out" 2>&1
	got_rc=$?
	if [ "$got_rc" = "4" ] && [ ! -s "$TMP/argv" ] && grep -Fq "BR_SHIM_RESERVATION_UNKNOWN" "$TMP/out"; then
		pass=$((pass + 1))
	else
		fail=$((fail + 1))
		printf 'FAIL fail-closed [%s]: rc=%s argv<<<%s>>> out<<<%s>>>\n' "$mode" "$got_rc" "$(cat "$TMP/argv")" "$(cat "$TMP/out")"
	fi
done
export BEADS_DB="$REPO_ROOT/.beads/beads.db"
export XDG_STATE_HOME="$TMP/state"
export PATH="$TMP/shimbindir:$TMP/sendbin:$TMP/realbin:$PATH"
# shellcheck source=lib/br-create-guard-tests.sh
. "$REPO_ROOT/tests/cli/lib/br-create-guard-tests.sh"

 printf 'br-shim: %s pass %s fail\n' "$pass" "$fail"
 [ "$fail" = "0" ]
