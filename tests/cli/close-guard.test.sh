#!/bin/sh
# close-guard.test.sh — ID1 close guard contract
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.108).
# A stub br serves canned bead JSON; a fixture git repo carries commit
# trailers. Every verdict comes from exit codes plus complete output.
set -u

CHECK=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/close-guard.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/close-guard-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0
mkdir -p "$TMP/bin"
cat > "$TMP/bin/br" <<'EOF'
#!/bin/sh
cat "$BR_GUARD_JSON_FILE"
EOF
chmod +x "$TMP/bin/br"
export PATH="$TMP/bin:/usr/bin:/bin"
export BR_GUARD_JSON_FILE="$TMP/bead.json"
set_bead() {
	printf '%s' "$1" > "$TMP/bead.json"
}

export AGENT_NAME="GuardTest"
BEAD=bead-1

# 1. caller holds the claim -> refused
set_bead '{"id":"bead-1","status":"in_progress","assignee":"GuardTest","labels":[]}'
if sh "$CHECK" "$BEAD" --db "$TMP/db" > "$TMP/out" 2>&1; then
	fail=$((fail + 1)); printf 'FAIL claim: rc=0\n'
elif grep -q "holds the claim" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL claim: wrong refusal\n'
fi
# 2. another holder -> passes
set_bead '{"id":"bead-1","status":"in_progress","assignee":"OtherWorker","labels":[]}'
if sh "$CHECK" "$BEAD" --db "$TMP/db" > "$TMP/out" 2>&1; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL other: rc!=0\n'
fi

# 3. fresh-context label passes even for the claimant
set_bead '{"id":"bead-1","status":"in_progress","assignee":"GuardTest","labels":["reviewer-fresh-context:muse"]}'
if sh "$CHECK" "$BEAD" --db "$TMP/db" > "$TMP/out" 2>&1; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL fresh: rc!=0\n'
fi

# 4. unclaimed bead but caller trailer on a naming commit -> refused
repo="$TMP/repo"
mkdir -p "$repo"
git -C "$repo" init -q
git -C "$repo" config user.email "test@example.invalid"
git -C "$repo" config user.name "worker-1"
printf 'work\n' > "$repo/f.txt"
git -C "$repo" add f.txt
git -C "$repo" commit -qm "[test] work bead-1" --no-verify 2>/dev/null
git -C "$repo" commit -q --amend -m "[test] work bead-1" -m "Agent: GuardTest" --no-verify 2>/dev/null
set_bead '{"id":"bead-1","status":"in_progress","assignee":"","labels":[]}'
if (cd -- "$repo" && sh "$CHECK" "$BEAD" --db "$TMP/db" > "$TMP/out" 2>&1); then
	fail=$((fail + 1)); printf 'FAIL trailer: rc=0\n'
else
	if grep -q "Agent trailer" "$TMP/out"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL trailer: wrong refusal\n'; fi
fi

# 5. same repo, different caller -> passes
AGENT_NAME=SomebodyElse
export AGENT_NAME
if (cd -- "$repo" && sh "$CHECK" "$BEAD" --db "$TMP/db" > "$TMP/out" 2>&1); then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL other-caller: rc!=0 out<<<%s>>>\n' "$(cat "$TMP/out")"
fi

printf 'close-guard: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
