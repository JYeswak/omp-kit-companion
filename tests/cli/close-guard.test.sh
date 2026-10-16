#!/bin/sh
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
# close-guard.test.sh — ID1 close guard contract
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.108).
# A stub br serves canned bead JSON; a fixture git repo carries commit
# trailers. Every verdict comes from exit codes plus complete output.
set -u

REPO=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
# CLOSE_GUARD_CHECK runs the suite against another guard copy (planted negative).
CHECK="${CLOSE_GUARD_CHECK:-$REPO/scripts/close-guard.sh}"
REPO_TMP="$REPO/var/agent-tmp"
mkdir -p "$REPO_TMP" || exit 1
TMP="$REPO_TMP/close-guard-test.$$"
mkdir -m 700 "$TMP" || exit 1
printf 'pid=%s label=close-guard-test repo=%s created=%s\n' "$$" "$REPO" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$TMP/.owner"

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

# 3. a fresh-context marker never bypasses a same-pane claim
set_bead '{"id":"bead-1","status":"in_progress","assignee":"GuardTest","labels":["reviewer-fresh-context:muse"]}'
if sh "$CHECK" "$BEAD" --db "$TMP/db" > "$TMP/out" 2>&1; then
	fail=$((fail + 1)); printf 'FAIL fresh-same-pane: rc=0\n'
else
	if grep -q "holds the claim" "$TMP/out"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL fresh-same-pane: wrong refusal\n'; fi
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
 
 # 6. LESSON1: close without a lesson is refused
 set_bead '{"id":"bead-1","status":"in_progress","assignee":"","labels":[]}'
 if (cd -- "$repo" && sh "$CHECK" "$BEAD" --db "$TMP/db" --sub close --reason "done, all green" > "$TMP/out" 2>&1); then
 	fail=$((fail + 1)); printf 'FAIL no-lesson: rc=0\n'
 elif grep -q "no Lesson" "$TMP/out"; then
 	pass=$((pass + 1))
 else
 	fail=$((fail + 1)); printf 'FAIL no-lesson: wrong refusal\n'
 fi
 # 7. LESSON1: close with explicit none passes
 if (cd -- "$repo" && sh "$CHECK" "$BEAD" --db "$TMP/db" --sub close --reason "done, all green
 none" > "$TMP/out" 2>&1); then
 	pass=$((pass + 1))
 else
 	fail=$((fail + 1)); printf 'FAIL explicit-none: rc!=0\n'
 fi
 # 8. LESSON1: close with a real lesson passes
 if (cd -- "$repo" && sh "$CHECK" "$BEAD" --db "$TMP/db" --sub close --reason "done, all green
 Lesson: plant the negative case first" > "$TMP/out" 2>&1); then
 	pass=$((pass + 1))
 else
 	fail=$((fail + 1)); printf 'FAIL real-lesson: rc!=0\n'
 fi
 # 9. LESSON1: review entries carry no lesson requirement
 if (cd -- "$repo" && sh "$CHECK" "$BEAD" --db "$TMP/db" --sub update > "$TMP/out" 2>&1); then
 	pass=$((pass + 1))
 else
 	fail=$((fail + 1)); printf 'FAIL review-ungated: rc!=0\n'
 fi

# 10-12 (ompkit-fp72.98): every historical implementer is refused, not only the
# first Agent trailer. Two commits: Alice then Bob; the claim moved to Carol.
repo2="$TMP/repo2"
mkdir -p "$repo2"
git -C "$repo2" init -q
git -C "$repo2" config user.email "test@example.invalid"
git -C "$repo2" config user.name "worker-2"
printf 'a\n' > "$repo2/f.txt"; git -C "$repo2" add f.txt
git -C "$repo2" commit -qm "[test] first pass fx-1.1" -m "Agent: Alice" --no-verify 2>/dev/null
printf 'b\n' > "$repo2/f.txt"; git -C "$repo2" add f.txt
git -C "$repo2" commit -qm "[test] second pass fx-1.1" -m "Agent: Bob" --no-verify 2>/dev/null
# an unrelated bead whose id extends fx-1.1 as a prefix
printf 'c\n' > "$repo2/f.txt"; git -C "$repo2" add f.txt
git -C "$repo2" commit -qm "[test] other bead fx-1.112" -m "Agent: Dave" --no-verify 2>/dev/null
set_bead '{"id":"fx-1.1","status":"in_progress","assignee":"Carol","labels":[]}'
for who in Bob Alice; do
	if (cd -- "$repo2" && AGENT_NAME=$who sh "$CHECK" fx-1.1 --db "$TMP/db" > "$TMP/out" 2>&1); then
		fail=$((fail + 1)); printf 'FAIL all-trailers %s: rc=0 out<<<%s>>>\n' "$who" "$(cat "$TMP/out")"
	else
		rc=$?
		if [ "$rc" = 4 ] && grep -q "Agent trailer" "$TMP/out"; then pass=$((pass + 1));
		else fail=$((fail + 1)); printf 'FAIL all-trailers %s: rc=%s out<<<%s>>>\n' "$who" "$rc" "$(cat "$TMP/out")"; fi
	fi
done
# 12. Dave implemented only fx-1.112; he may close fx-1.1 (exact id token)
if (cd -- "$repo2" && AGENT_NAME=Dave sh "$CHECK" fx-1.1 --db "$TMP/db" > "$TMP/out" 2>&1); then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL exact-id Dave: rc=%s out<<<%s>>>\n' "$?" "$(cat "$TMP/out")"
fi
# 13. Dave is still refused for his own bead fx-1.112
set_bead '{"id":"fx-1.112","status":"in_progress","assignee":"","labels":[]}'
if (cd -- "$repo2" && AGENT_NAME=dave sh "$CHECK" fx-1.112 --db "$TMP/db" > "$TMP/out" 2>&1); then
	fail=$((fail + 1)); printf 'FAIL own-bead Dave: rc=0\n'
else
	pass=$((pass + 1))
fi

# 14-15 (ompkit-fp72.98): a claim revision that moves between the first read
# and the decision is refused. This stub br serves bead.json on its first call
# and bead2.json afterwards, counting calls in $TMP/br.count.
mkdir -p "$TMP/bin2"
cat > "$TMP/bin2/br" <<'EOF'
#!/bin/sh
n=$(cat "$BR_GUARD_COUNT" 2>/dev/null || echo 0)
n=$((n + 1))
printf '%s\n' "$n" > "$BR_GUARD_COUNT"
if [ "$n" -gt 1 ]; then cat "$BR_GUARD_JSON_FILE2"; else cat "$BR_GUARD_JSON_FILE"; fi
EOF
chmod +x "$TMP/bin2/br"
set_bead '{"id":"fx-1.1","status":"in_progress","assignee":"Carol","updated_at":"2026-10-16T10:00:00Z","labels":[]}'
printf '%s' '{"id":"fx-1.1","status":"in_progress","assignee":"Erin","updated_at":"2026-10-16T10:00:05Z","labels":[]}' > "$TMP/bead2.json"
rm -f "$TMP/br.count"
if (cd -- "$repo2" && PATH="$TMP/bin2:$PATH" BR_GUARD_COUNT="$TMP/br.count" BR_GUARD_JSON_FILE2="$TMP/bead2.json" AGENT_NAME=Dave sh "$CHECK" fx-1.1 --db "$TMP/db" > "$TMP/out" 2>&1); then
	fail=$((fail + 1)); printf 'FAIL claim-moved: rc=0 out<<<%s>>>\n' "$(cat "$TMP/out")"
else
	rc=$?
	if [ "$rc" = 4 ] && grep -q "changed during the check (assignee Carol->Erin" "$TMP/out"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL claim-moved: rc=%s out<<<%s>>>\n' "$rc" "$(cat "$TMP/out")"; fi
fi
# 15. an unchanged second read proceeds
cp "$TMP/bead.json" "$TMP/bead2.json"
rm -f "$TMP/br.count"
if (cd -- "$repo2" && PATH="$TMP/bin2:$PATH" BR_GUARD_COUNT="$TMP/br.count" BR_GUARD_JSON_FILE2="$TMP/bead2.json" AGENT_NAME=Dave sh "$CHECK" fx-1.1 --db "$TMP/db" > "$TMP/out" 2>&1); then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL claim-stable: out<<<%s>>>\n' "$(cat "$TMP/out")"
fi
 
 printf 'close-guard: %s pass %s fail\n' "$pass" "$fail"
 [ "$fail" = "0" ]
