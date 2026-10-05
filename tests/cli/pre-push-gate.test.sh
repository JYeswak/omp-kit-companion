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

printf 'pre-push-gate: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
