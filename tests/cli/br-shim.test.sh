#!/bin/sh
# br-shim.test.sh — ID1 shim contract (ompkit-rc-epic-land-fix-release-dogfood-rz5.108).
# A fake `br` records its argv; the shim under test sits ahead of it on PATH.
# Follows ~/AGENTS.md producer truth: every verdict comes from the recorded
# argv file plus the shim's exit code, never from a filtered excerpt.
set -u

SHIM=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/br-shim.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/br-shim-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

mkdir -p "$TMP/realbin" "$TMP/shimbindir"
cat > "$TMP/realbin/br" <<'EOF'
#!/bin/sh
# SYNC1 box 4: answer `show` with canned bead JSON for the close gate;
# record every other invocation for argv assertions.
if [ "$1" = "show" ]; then
	cat "$BR_GUARD_JSON_FILE"
else
	printf '%s\n' "$@" > "$BR_SHIM_TEST_ARGV"
fi
exit 0
EOF
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

export BR_SHIM_TEST_ARGV="$TMP/argv"
export PATH="$TMP/shimbindir:$TMP/realbin:$PATH"
export AGENT_NAME="TestShim"

# 1. every write kind gets --actor appended when absent
for kind in "create --title t" "update X --status open" "comments add --message m X" "close X" "dep add X Y" "label add X y" "q quick" "delete X"; do
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
 
 printf 'br-shim: %s pass %s fail\n' "$pass" "$fail"
 [ "$fail" = "0" ]
