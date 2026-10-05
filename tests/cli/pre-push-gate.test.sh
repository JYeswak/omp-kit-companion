#!/bin/sh
# pre-push-gate.test.sh — GATE1 base-authoritative gate contract
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.88).
# Fixture git repos where HEAD rewrites the gate: the adapter must run the
# BASE archive's gate code, never HEAD's. Every verdict comes from the exit
# code plus the complete output.
set -u

ADAPTER=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/pre-push-gate.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/pre-push-gate-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0

mkrepo() {
	name=$1
	base_body=$2
	head_body=$3
	repo="$TMP/$name"
	rm -rf "$repo"
	mkdir -p "$repo/scripts" "$repo/var/agent-tmp"
	git -C "$repo" init -q
	git -C "$repo" config user.email "test@example.invalid"
	git -C "$repo" config user.name "worker-1"
	printf '#!/bin/sh\n%s\n' "$base_body" > "$repo/scripts/fresh-gate.sh"
	printf '#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n' > "$repo/scripts/regexploit-gate.py"
	git -C "$repo" add -A
	git -C "$repo" commit -qm "[test] base gate"
	printf '#!/bin/sh\n%s\n' "$head_body" > "$repo/scripts/fresh-gate.sh"
	git -C "$repo" add -A
	git -C "$repo" commit -qm "[test] head gate"
	printf '%s' "$repo"
}

run_adapter() {
	repo=$1
	base=$(git -C "$repo" rev-parse HEAD~1)
	head=$(git -C "$repo" rev-parse HEAD)
	printf 'refs/heads/main %s refs/heads/main %s\n' "$head" "$base" | (cd -- "$repo" && sh "$ADAPTER" > "$TMP/out" 2>&1)
	printf '%s' "$?"
}

# 1. planted: HEAD deletes the gate step; the BASE gate still judges
repo=$(mkrepo weakened 'echo BASE-GATE' 'echo HEAD-GATE; exit 1')
rc=$(run_adapter "$repo")
out=$(cat "$TMP/out")
if [ "$rc" = "0" ] && printf '%s' "$out" | grep -q "BASE-GATE" && ! printf '%s' "$out" | grep -q "HEAD-GATE"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL base-authoritative: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi

# 2. a failing BASE gate refuses even when HEAD passes
repo=$(mkrepo strictbase 'echo BASE-GATE-FAIL; exit 1' 'echo HEAD-GATE')
rc=$(run_adapter "$repo")
out=$(cat "$TMP/out")
if [ "$rc" != "0" ] && printf '%s' "$out" | grep -q "BASE-GATE-FAIL"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL base-failure-refuses: rc=%s out<<<%s>>>\n' "$rc" "$out"
fi

# 3. planted: a commit built on base B that deletes lines added at B+1 is
# refused, naming the commit that added them
KITREPO=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
stalerepo="$TMP/stale"
rm -rf "$stalerepo"
mkdir -p "$stalerepo/scripts" "$stalerepo/src" "$stalerepo/var/agent-tmp"
git -C "$stalerepo" init -q
git -C "$stalerepo" config user.email "test@example.invalid"
git -C "$stalerepo" config user.name "worker-1"
cp "$KITREPO/src/land-guard.ts" "$stalerepo/src/land-guard.ts"
printf '#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n' > "$stalerepo/scripts/regexploit-gate.py"
printf '#!/bin/sh\nexit 0\n' > "$stalerepo/scripts/fresh-gate.sh"
chmod +x "$stalerepo/scripts/fresh-gate.sh"
printf 'one\n' > "$stalerepo/f.ts"
git -C "$stalerepo" add -A
git -C "$stalerepo" commit -qm "[test] base B"
base=$(git -C "$stalerepo" rev-parse HEAD)
printf 'one\ntwo added at B+1\n' > "$stalerepo/f.ts"
git -C "$stalerepo" add -A
git -C "$stalerepo" commit -qm "[test] B+1 adds line two"
tip=$(git -C "$stalerepo" rev-parse HEAD)
git -C "$stalerepo" checkout -q "$base"
printf 'one\nmine without line two\n' > "$stalerepo/f.ts"
git -C "$stalerepo" add -A
git -C "$stalerepo" commit -qm "[test] stale candidate"
candidate=$(git -C "$stalerepo" rev-parse HEAD)
printf 'refs/heads/main %s refs/heads/main %s\n' "$candidate" "$tip" | (cd -- "$stalerepo" && sh "$ADAPTER" > "$TMP/out" 2>&1)
rc=$?
if [ "$rc" != "0" ] && grep -q "stale deletion from $tip" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL stale-refused: rc=%s out<<<%s>>>\n' "$rc" "$(cat "$TMP/out")"
fi

# 4. control: the same candidate rebased onto the tip passes
git -C "$stalerepo" checkout -q "$tip"
printf 'one\ntwo added at B+1\nmine on top\n' > "$stalerepo/f.ts"
git -C "$stalerepo" add -A
git -C "$stalerepo" commit -qm "[test] fresh candidate"
fresh=$(git -C "$stalerepo" rev-parse HEAD)
printf 'refs/heads/main %s refs/heads/main %s\n' "$fresh" "$tip" | (cd -- "$stalerepo" && sh "$ADAPTER" > "$TMP/out" 2>&1)
rc=$?
if [ "$rc" = "0" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL fresh-passes: rc=%s out<<<%s>>>\n' "$rc" "$(cat "$TMP/out")"
fi

printf 'pre-push-gate: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
