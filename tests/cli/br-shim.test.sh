#!/bin/sh
# br-shim.test.sh — ID1 and CREATEBUDGET1 shim contract.
# A fake `br` records its argv; the shim under test sits ahead of it on PATH.
# Follows ~/AGENTS.md producer truth: every verdict comes from the recorded
# argv file plus the shim's exit code, never from a filtered excerpt.
set -u

SHIM=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/br-shim.sh
REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$SHIM")/.." && pwd)
REPO_TMP="$REPO_ROOT/var/agent-tmp"
# shellcheck source=scripts/kitlib-tmp.sh
. "$REPO_ROOT/scripts/kitlib-tmp.sh"
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP br-shim-test || exit 1
export XDG_STATE_HOME="$TMP/state"

mkdir -p "$TMP/realbin" "$TMP/shimbindir" "$TMP/sendbin"
cat > "$TMP/realbin/br" <<'EOF'
#!/bin/sh
# SYNC1 box 4: answer `show` with canned bead JSON for the close gate;
# the creation guard reads a complete issue envelope before dispatch.
if [ "$1" = "show" ] || { [ "$1" = "--db" ] && [ "$3" = "show" ]; }; then
	cat "$BR_GUARD_JSON_FILE"
	exit 0
fi
if [ "$1" = "list" ] || { [ "$1" = "--db" ] && [ "$3" = "list" ]; }; then
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
ORIGINAL_PATH="$PATH"
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
CREATE_DESCRIPTION='WHAT: (a) a widget. WHY: needed.'
BACKTICK=$(printf '\140')
CREATE_ACCEPTANCE="- [ ] [a] [build] the widget builds; planted negative: bad input is refused ${BACKTICK}true${BACKTICK} -> rc 0"
br_create_valid() {
	br create "$@" -t task -l gate --description "$CREATE_DESCRIPTION" --acceptance "$CREATE_ACCEPTANCE"
}
printf '{"issues":[],"total":0,"offset":0,"has_more":false}\n' > "$BR_CREATE_FIXTURE"
BUN_BIN=$(command -v bun || true)
export BUN_BIN REPO_ROOT
cat > "$TMP/sendbin/omp-kit" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "preflight" ]; then
	exec "$BUN_BIN" --no-env-file --config=/dev/null "$REPO_ROOT/src/cli.ts" "$@"
fi
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
for kind in "update X --status open" "comments add --message m X" "close X" "reopen X" "dep add X Y" "dep remove X Y" "label add X y" "label remove X y" "sync --flush-only" "q quick" "delete X"; do
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
: > "$TMP/argv"
br_create_valid --title "Actor fixture" > "$TMP/out" 2>&1
got_rc=$?
want="create --title Actor fixture -t task -l gate --description $CREATE_DESCRIPTION --acceptance $CREATE_ACCEPTANCE --actor TestShim"
check "inject [create]" 0 "$want"

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
# The full in_review gate needs a complete fixture and an isolated tracker
# without the checkout's opt-in pregrade policy.
export PATH="$TMP/shimbindir:$TMP/realbin:$ORIGINAL_PATH"
REVIEW_DB="$TMP/review-project/.beads/beads.db"
mkdir -p "$TMP/review-project/.beads"
: > "$REVIEW_DB"
cat > "$TMP/review-testshim.json" <<'EOF'
{"id":"X","title":"Review admission fixture","type":"task","issue_type":"task","status":"in_progress","priority":2,"created_at":"2026-10-30T00:00:00Z","assignee":"TestShim","labels":["gate"],"description":"WHAT: (a) a widget. WHY: needed.","dependencies":[],"acceptance_criteria":"- [x] [a] [build] the widget builds; planted negative: bad input is refused `true` -> rc 0\n- [ ] [v] [live] verification note, never replayed"}
EOF
cat > "$TMP/review-other.json" <<'EOF'
{"id":"X","title":"Review admission fixture","type":"task","issue_type":"task","status":"in_progress","priority":2,"created_at":"2026-10-30T00:00:00Z","assignee":"OtherWorker","labels":["gate"],"description":"WHAT: (a) a widget. WHY: needed.","dependencies":[],"acceptance_criteria":"- [x] [a] [build] the widget builds; planted negative: bad input is refused `true` -> rc 0\n- [ ] [v] [live] verification note, never replayed"}
EOF
export AM_EXPECTED_PROJECT="$TMP/review-project"
export BR_GUARD_JSON_FILE="$TMP/review-testshim.json"
: > "$TMP/argv"
br --db "$REVIEW_DB" update X --status in_review > "$TMP/out" 2>&1
got_rc=$?
if [ "$got_rc" = "4" ] && [ ! -s "$TMP/argv" ] && grep -q "holds the claim" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL review-entry-refused: rc=%s out<<<%s>>>\n' "$got_rc" "$(cat "$TMP/out")"
fi
: > "$TMP/argv"
br --db "$REVIEW_DB" close X > "$TMP/out" 2>&1
got_rc=$?
if [ "$got_rc" = "4" ] && [ ! -s "$TMP/argv" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL close-refused: rc=%s\n' "$got_rc"
fi
export BR_GUARD_JSON_FILE="$TMP/review-other.json"
# Owned source checkout, separate from the metadata tracker. No operator hooks are installed here.
HANDOFF_CODE="$TMP/handoff-code"
mkdir -p "$HANDOFF_CODE"
git -C "$HANDOFF_CODE" init -q
git -C "$HANDOFF_CODE" -c core.hooksPath=/dev/null -c user.name=Fixture -c user.email=fixture@invalid commit --allow-empty -q -m 'handoff fixture [test]'
HANDOFF_SHA=$(git -C "$HANDOFF_CODE" rev-parse HEAD)
HANDOFF_MESSAGE="DONE $HANDOFF_CODE@$HANDOFF_SHA: fixture"
HANDOFF_LEDGER="$HANDOFF_CODE/.git/omp-kit/fresh-gate-runs.jsonl"
mkdir -p "$(dirname "$HANDOFF_LEDGER")"
handoff_row() {
	printf '{"version":2,"commit":"%s","rc":%s,"evidence":{"complete":%s}}\n' "$1" "$3" "$2" > "$HANDOFF_LEDGER"
}
handoff_row "$HANDOFF_SHA" true 0
: > "$TMP/argv"
br --db "$REVIEW_DB" update X --status in_review --transition-comment "$HANDOFF_MESSAGE" > "$TMP/out" 2>&1
got_rc=$?
check "review-entry-passes" 0 "--db $REVIEW_DB update X --status in_review --transition-comment $HANDOFF_MESSAGE --actor TestShim"
: > "$TMP/argv"
br --db "$REVIEW_DB" update X --status open > "$TMP/out" 2>&1
got_rc=$?
check "non-review-ungated" 0 "--db $REVIEW_DB update X --status open --actor TestShim"
printf '{"id":"X","status":"in_progress","assignee":"TestShim","labels":["reviewer-fresh-context:muse"]}' > "$TMP/bead.json"
export BR_GUARD_JSON_FILE="$TMP/bead.json"
: > "$TMP/argv"
br --db "$REVIEW_DB" close X > "$TMP/out" 2>&1
got_rc=$?
check "fresh-context-label-refused" 4 ""
export AM_EXPECTED_PROJECT="$REPO_ROOT"
 
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
# shellcheck source=tests/cli/lib/br-create-guard-tests.sh
. "$REPO_ROOT/tests/cli/lib/br-create-guard-tests.sh"

# 16. KL08: the kitlib admission lock is the persistent inode path the hand-rolled lock used:
# $XDG_STATE_HOME/omp-kit/create-admission/<sha256(realpath(db))>.lock, private, one link, never unlinked.
if python3 - "$XDG_STATE_HOME" "$BEADS_DB" > "$TMP/out" 2>&1 <<'PY'
import hashlib, os, stat, sys
state, db = sys.argv[1:]
lock_dir = os.path.join(state, "omp-kit", "create-admission")
want = hashlib.sha256(os.path.realpath(db).encode("utf-8")).hexdigest() + ".lock"
assert sorted(os.listdir(lock_dir)) == [want], (os.listdir(lock_dir), want)
info = os.lstat(os.path.join(lock_dir, want))
assert stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1, oct(info.st_mode)
for directory in (os.path.join(state, "omp-kit"), lock_dir):
    assert stat.S_IMODE(os.lstat(directory).st_mode) == 0o700, directory
PY
then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL create-admission-lock-path: %s\n' "$(cat "$TMP/out")"
fi

 # 17. NEEDSDIRCLAIM1 (ompkit-izpwd.1): a claim on a needs-director bead is
 # refused before the real br runs; an eligible claim passes through. The shim
 # relays the native claim-preflight verdict and adds no policy of its own.
 AM_FAKE_MODE=clear
AM_EXPECTED_PROJECT="$REPO_ROOT"
export PATH="$TMP/shimbindir:$TMP/sendbin:$TMP/realbin:$ORIGINAL_PATH"
# This scenario has no active claim; prior creation fixtures are unrelated inventory.
printf '{"issues":[],"total":0,"offset":0,"has_more":false}\n' > "$BR_CREATE_FIXTURE"
 if command -v bun >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 && [ -f "$REPO_ROOT/src/cli.ts" ]; then
 	printf '{"id":"X","status":"open","assignee":null,"labels":["needs-director"]}' > "$TMP/bead.json"
 	: > "$TMP/argv"
 	br update X --claim > "$TMP/out" 2>&1
 	got_rc=$?
 	if [ "$got_rc" = "4" ] && [ ! -s "$TMP/argv" ] && grep -q "BR_SHIM_NEEDS_DIRECTOR" "$TMP/out"; then
 		pass=$((pass + 1))
 	else
 		fail=$((fail + 1))
 		printf 'FAIL needs-director-claim-refused: rc=%s out<<<%s>>>\n' "$got_rc" "$(cat "$TMP/out")"
 	fi
	# shellcheck disable=SC2016 # literal backticks: fixture acceptance text, not a substitution
	printf '{"id":"X","status":"open","assignee":null,"labels":["pillar:proven"],"acceptance_criteria":"- [ ] [a] [build] claimable `true` -> rc 0"}' > "$TMP/bead.json"
	: > "$TMP/argv"
	br update X --claim > "$TMP/out" 2>&1
	got_rc=$?
	check "eligible-claim-passes" 0 "update X --claim --actor TestShim"
	# 18. REPLAYABLE1: the claim-only path remains independent of full lint;
	# review entry additionally proves the complete phase gate on an isolated,
	# pregrade-optional fixture tracker.
	export AM_EXPECTED_PROJECT="$TMP/review-project"
	for move in "--claim" "--status in_review"; do
		if [ "$move" = "--claim" ]; then
			printf '{"id":"X","status":"open","assignee":null,"labels":["pillar:proven"],"acceptance_criteria":"- [ ] [a] [build] the widget works; planted negative refused"}' > "$TMP/bead.json"
			export BR_GUARD_JSON_FILE="$TMP/bead.json"
			: > "$TMP/argv"
			br --db "$REVIEW_DB" update X --claim > "$TMP/out" 2>&1
		else
			cat > "$TMP/review-unreplayable.json" <<'EOF'
{"id":"X","title":"Review admission fixture","type":"task","issue_type":"task","status":"in_progress","priority":2,"created_at":"2026-10-30T00:00:00Z","assignee":"OtherWorker","labels":["gate"],"description":"WHAT: (a) a widget. WHY: needed.","dependencies":[],"acceptance_criteria":"- [x] [a] [build] the widget builds; planted negative refused"}
EOF
			export BR_GUARD_JSON_FILE="$TMP/review-unreplayable.json"
			: > "$TMP/argv"
			br --db "$REVIEW_DB" update X --status in_review > "$TMP/out" 2>&1
		fi
		got_rc=$?
		replayable_refusal=0
		if grep -Fq 'REFUSED_NOT_REPLAYABLE box 1 "- [ ] [a] [build] the widget works; planted negative refused" names no backticked command; corrected shape:' "$TMP/out" \
			|| { [ "$move" = "--status in_review" ] && grep -Fq "REFUSED_NOT_REPLAYABLE" "$TMP/out"; }; then
			replayable_refusal=1
		fi
		if [ "$got_rc" = "4" ] && [ ! -s "$TMP/argv" ] && [ "$replayable_refusal" = "1" ]; then
			pass=$((pass + 1))
		else
			fail=$((fail + 1))
			printf 'FAIL replayable-claim-refused [%s]: rc=%s argv<<<%s>>> out<<<%s>>>\n' "$move" "$got_rc" "$(cat "$TMP/argv")" "$(cat "$TMP/out")"
		fi
		if [ "$move" = "--claim" ]; then
			printf '{"id":"X","status":"open","assignee":null,"labels":["pillar:proven"],"acceptance_criteria":"- [ ] [a] [build] the widget works \u0060true\u0060 -> rc 0; planted negative refused"}' > "$TMP/bead.json"
			export BR_GUARD_JSON_FILE="$TMP/bead.json"
			: > "$TMP/argv"
			br --db "$REVIEW_DB" update X --claim > "$TMP/out" 2>&1
			got_rc=$?
			check "replayable-claim-admitted" 0 "--db $REVIEW_DB update X --claim --actor TestShim"
		else
			export BR_GUARD_JSON_FILE="$TMP/review-other.json"
			: > "$TMP/argv"
			br --db "$REVIEW_DB" update X --status in_review --transition-comment "$HANDOFF_MESSAGE" > "$TMP/out" 2>&1
			got_rc=$?
			check "replayable-review-admitted" 0 "--db $REVIEW_DB update X --status in_review --transition-comment $HANDOFF_MESSAGE --actor TestShim"
		fi
	done
	export AM_EXPECTED_PROJECT="$REPO_ROOT"
 else
 	printf 'SKIP needs-director-claim: no bun/python3/candidate cli.ts in this environment\n'
 fi

# LANESPLIT1b: real admission changes only with complete evidence for this exact source.
export AGENT_NAME=TestShim
export AM_EXPECTED_PROJECT="$TMP/review-project"
export BR_GUARD_JSON_FILE="$TMP/review-other.json"
handoff_case() {
	handoff_name=$1; handoff_want=$2
	handoff_target=${3:-$HANDOFF_SHA}
	: > "$TMP/argv"
	br --db "$REVIEW_DB" update X --status in_review --transition-comment "$HANDOFF_MESSAGE" > "$TMP/out" 2>&1
	handoff_rc=$?
	if [ "$handoff_want" = 4 ]; then
		if [ "$handoff_rc" = 4 ] && [ ! -s "$TMP/argv" ] \
			&& grep -Fq HANDOFF_UNGATED "$TMP/out" \
			&& grep -Fq "sh scripts/fresh-gate.sh --commit $handoff_target" "$TMP/out"; then
			pass=$((pass + 1))
		else
			fail=$((fail + 1)); printf 'FAIL %s: rc=%s backend=%s out<<<%s>>>\n' "$handoff_name" "$handoff_rc" "$(cat "$TMP/argv")" "$(cat "$TMP/out")"
		fi
	elif [ "$handoff_rc" = 0 ] && grep -Fqx in_review "$TMP/argv" && grep -Fqx "$HANDOFF_MESSAGE" "$TMP/argv"; then
		pass=$((pass + 1))
	else
		fail=$((fail + 1)); printf 'FAIL %s: rc=%s out<<<%s>>>\n' "$handoff_name" "$handoff_rc" "$(cat "$TMP/out")"
	fi
}
rm -f "$HANDOFF_LEDGER"
handoff_case handoff-missing-green-refused 4
git -C "$HANDOFF_CODE" -c core.hooksPath=/dev/null -c user.name=Fixture -c user.email=fixture@invalid commit --allow-empty -q -m 'other source [test]'
HANDOFF_OTHER=$(git -C "$HANDOFF_CODE" rev-parse HEAD)
handoff_row "$HANDOFF_OTHER" true 0
handoff_case handoff-other-sha-green-refused 4
handoff_row "$HANDOFF_SHA" false 0
handoff_case handoff-incomplete-evidence-refused 4
handoff_row "$HANDOFF_SHA" true 1
handoff_case handoff-red-exact-sha-refused 4
handoff_row "$HANDOFF_SHA" true 0
handoff_case handoff-exact-complete-green-admitted 0
handoff_row "$HANDOFF_SHA" true false
handoff_case handoff-boolean-rc-is-not-green 4
handoff_row "$HANDOFF_SHA" true 0
printf '{"commit":"%s"' "$HANDOFF_SHA" >> "$HANDOFF_LEDGER"
handoff_case handoff-partial-observation-refused 4
handoff_row "$HANDOFF_SHA" true 0
HANDOFF_MOVED="$TMP/handoff space@quoted'path"
mv "$HANDOFF_CODE" "$HANDOFF_MOVED"
HANDOFF_CODE=$HANDOFF_MOVED
HANDOFF_LEDGER="$HANDOFF_CODE/.git/omp-kit/fresh-gate-runs.jsonl"
HANDOFF_MESSAGE="DONE $HANDOFF_CODE@$HANDOFF_SHA: contact operator@deadbeef"
handoff_case handoff-decoded-path-and-explanation-admitted 0
HANDOFF_VALID_MESSAGE=$HANDOFF_MESSAGE
HANDOFF_MESSAGE="DONE $HANDOFF_CODE@${HANDOFF_SHA}junk"
handoff_case handoff-sha-prefix-plus-junk-refused 4 "<sha>"
HANDOFF_MESSAGE=$HANDOFF_VALID_MESSAGE
rm -f "$HANDOFF_LEDGER"
: > "$TMP/argv"
br --db "$REVIEW_DB" comments add X --message="$HANDOFF_MESSAGE" > "$TMP/out" 2>&1
handoff_rc=$?
if [ "$handoff_rc" = 4 ] && [ ! -s "$TMP/argv" ] && grep -Fq HANDOFF_UNGATED "$TMP/out"; then pass=$((pass + 1))
else fail=$((fail + 1)); printf 'FAIL handoff-DONE-comment-refused: rc=%s out<<<%s>>>\n' "$handoff_rc" "$(cat "$TMP/out")"; fi
handoff_row "$HANDOFF_SHA" true 0
: > "$TMP/argv"
br --db "$REVIEW_DB" comments add X --message="$HANDOFF_MESSAGE" > "$TMP/out" 2>&1
handoff_rc=$?
if [ "$handoff_rc" = 0 ] && grep -Fqx comments "$TMP/argv"; then pass=$((pass + 1))
else fail=$((fail + 1)); printf 'FAIL handoff-DONE-comment-admitted: rc=%s out<<<%s>>>\n' "$handoff_rc" "$(cat "$TMP/out")"; fi
: > "$TMP/argv"
ordinary_message="quoted 'DONE' and \$(touch $TMP/handoff-injection) are data, not a DONE subject"
br --db "$REVIEW_DB" comments add X --message="$ordinary_message" > "$TMP/out" 2>&1
handoff_rc=$?
if [ "$handoff_rc" = 0 ] && grep -Fqx comments "$TMP/argv" && [ ! -e "$TMP/handoff-injection" ]; then pass=$((pass + 1))
else fail=$((fail + 1)); printf 'FAIL handoff-nonsubject-data-admitted: rc=%s out<<<%s>>>\n' "$handoff_rc" "$(cat "$TMP/out")"; fi
printf '{"version":2,"commit":"%s","rc":0}\n' "$HANDOFF_SHA" > "$HANDOFF_LEDGER"
handoff_case handoff-missing-completeness-refused 4
handoff_row "$HANDOFF_SHA" true 0
HANDOFF_MESSAGE="review requested without a source claim"
handoff_case handoff-review-without-DONE-refused 4 "<sha>"
HANDOFF_MESSAGE=$(printf 'evidence follows\n%s' "$HANDOFF_VALID_MESSAGE")
: > "$TMP/argv"
br --db "$REVIEW_DB" comments add X --message="$HANDOFF_MESSAGE" > "$TMP/out" 2>&1
handoff_rc=$?
if [ "$handoff_rc" = 0 ] && grep -Fqx comments "$TMP/argv"; then pass=$((pass + 1))
else fail=$((fail + 1)); printf 'FAIL handoff-multiline-DONE-admitted: rc=%s out<<<%s>>>\n' "$handoff_rc" "$(cat "$TMP/out")"; fi
HANDOFF_MESSAGE=$HANDOFF_VALID_MESSAGE
rm -f "$HANDOFF_LEDGER"
: > "$TMP/argv"
br --db "$REVIEW_DB" comments add X "$HANDOFF_MESSAGE" > "$TMP/out" 2>&1
handoff_rc=$?
if [ "$handoff_rc" = 4 ] && [ ! -s "$TMP/argv" ] && grep -Fq HANDOFF_UNGATED "$TMP/out"; then pass=$((pass + 1))
else fail=$((fail + 1)); printf 'FAIL handoff-positional-DONE-refused: rc=%s out<<<%s>>>\n' "$handoff_rc" "$(cat "$TMP/out")"; fi
: > "$TMP/argv"
positional_message=$(printf '%s\n%s' '- literal data' "$HANDOFF_MESSAGE")
br --db "$REVIEW_DB" comments add -- X "$positional_message" > "$TMP/out" 2>&1
handoff_rc=$?
if [ "$handoff_rc" = 4 ] && [ ! -s "$TMP/argv" ] && grep -Fq HANDOFF_UNGATED "$TMP/out"; then pass=$((pass + 1))
else fail=$((fail + 1)); printf 'FAIL handoff-positional-end-options-refused: rc=%s out<<<%s>>>\n' "$handoff_rc" "$(cat "$TMP/out")"; fi
handoff_row "$HANDOFF_SHA" true 0
: > "$TMP/argv"
br --db "$REVIEW_DB" comments add X "$HANDOFF_MESSAGE" > "$TMP/out" 2>&1
handoff_rc=$?
if [ "$handoff_rc" = 0 ] && grep -Fqx comments "$TMP/argv"; then pass=$((pass + 1))
else fail=$((fail + 1)); printf 'FAIL handoff-positional-DONE-admitted: rc=%s out<<<%s>>>\n' "$handoff_rc" "$(cat "$TMP/out")"; fi
HANDOFF_ACTUAL_LEDGER=$HANDOFF_LEDGER
HANDOFF_PREFIX="$TMP/handoff-prefix"
git init -q "$HANDOFF_PREFIX"
git -C "$HANDOFF_PREFIX" -c core.hooksPath=/dev/null -c user.name=Fixture -c user.email=fixture@invalid commit --allow-empty -q -m 'qualified prefix source [test]'
HANDOFF_PREFIX_SHA=$(git -C "$HANDOFF_PREFIX" rev-parse HEAD)
mkdir -p "$HANDOFF_PREFIX/.git/omp-kit"
HANDOFF_LEDGER="$HANDOFF_PREFIX/.git/omp-kit/fresh-gate-runs.jsonl"
handoff_row "$HANDOFF_PREFIX_SHA" true 0
HANDOFF_LEDGER=$HANDOFF_ACTUAL_LEDGER
rm -f "$HANDOFF_LEDGER"
HANDOFF_AMBIGUOUS="$HANDOFF_PREFIX@$HANDOFF_PREFIX_SHA branch"
mv "$HANDOFF_CODE" "$HANDOFF_AMBIGUOUS"
HANDOFF_CODE=$HANDOFF_AMBIGUOUS
HANDOFF_LEDGER="$HANDOFF_CODE/.git/omp-kit/fresh-gate-runs.jsonl"
HANDOFF_MESSAGE="DONE $HANDOFF_CODE@$HANDOFF_SHA: not the qualified prefix"
handoff_case handoff-existing-prefix-cannot-qualify-other-checkout 4 "<sha>"
handoff_row "$HANDOFF_SHA" true 0
mv "$HANDOFF_PREFIX" "$HANDOFF_PREFIX-retired"
handoff_case handoff-sha-shaped-path-segment-admitted 0
handoff_carrier_case() {
	carrier_name=$1; carrier_want=$2
	shift 2
	: > "$TMP/argv"
	printf '%s' "$HANDOFF_MESSAGE" | br --db "$REVIEW_DB" comments add X "$@" > "$TMP/out" 2>&1
	carrier_rc=$?
	if [ "$carrier_want" = 4 ]; then
		if [ "$carrier_rc" = 4 ] && [ ! -s "$TMP/argv" ] && grep -Fq HANDOFF_UNGATED "$TMP/out"; then pass=$((pass + 1))
		else fail=$((fail + 1)); printf 'FAIL %s: rc=%s out<<<%s>>>\n' "$carrier_name" "$carrier_rc" "$(cat "$TMP/out")"; fi
	elif [ "$carrier_rc" = 0 ] && grep -Fqx comments "$TMP/argv"; then pass=$((pass + 1))
	else fail=$((fail + 1)); printf 'FAIL %s: rc=%s out<<<%s>>>\n' "$carrier_name" "$carrier_rc" "$(cat "$TMP/out")"; fi
}
printf '%s' "$HANDOFF_MESSAGE" > "$TMP/handoff-message"
rm -f "$HANDOFF_LEDGER"
handoff_carrier_case handoff-content-alias-refused 4 --content "$HANDOFF_MESSAGE"
handoff_carrier_case handoff-file-refused 4 --file="$TMP/handoff-message"
handoff_carrier_case handoff-stdin-refused 4 -f -
handoff_row "$HANDOFF_SHA" true 0
handoff_carrier_case handoff-content-alias-admitted 0 --content "$HANDOFF_MESSAGE"
handoff_carrier_case handoff-file-admitted 0 -f"$TMP/handoff-message"
handoff_carrier_case handoff-stdin-admitted 0 --file -

 printf 'br-shim: %s pass %s fail\n' "$pass" "$fail"
 [ "$fail" = "0" ]
