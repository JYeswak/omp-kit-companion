#!/bin/sh
# repo-layout.test.sh — PUB1f layout check contract
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.106.6).
# Fixture checkouts with planted deviations; every verdict comes from the
# checker's exit code plus its complete output.
set -u

CHECK=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/repo-layout-check.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/repo-layout-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0

mkfull() {
	repo=$1
	rm -rf "$repo"
	mkdir -p "$repo/src" "$repo/tests" "$repo/scripts" "$repo/docs/adr" "$repo/var/agent-tmp"
	printf 'var/agent-tmp/\n' > "$repo/.gitignore"
	git -C "$repo" init -q 2>/dev/null
}

# 1. planted: missing docs/adr warns but exits 0
mkfull "$TMP/repo"
rmdir "$TMP/repo/docs/adr"
if sh "$CHECK" "$TMP/repo" > "$TMP/out" 2>&1; then
	if grep -q "WARN missing dir docs/adr" "$TMP/out"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL warn: no finding\n'; fi
else
	fail=$((fail + 1)); printf 'FAIL warn: rc!=0\n'
fi

# 2. same fixture with --strict exits non-zero
if sh "$CHECK" --strict "$TMP/repo" > "$TMP/out" 2>&1; then
	fail=$((fail + 1)); printf 'FAIL strict: rc=0\n'
else
	got_rc=$?
	if [ "$got_rc" = "1" ] && grep -q "FAIL" "$TMP/out"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL strict: rc=%s\n' "$got_rc"; fi
fi

# 3. unignored scratch is reported
mkfull "$TMP/repo"
printf '' > "$TMP/repo/.gitignore"
if sh "$CHECK" "$TMP/repo" > "$TMP/out" 2>&1; then
	if grep -q "not gitignored" "$TMP/out"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL gitignore: no finding\n'; fi
else
	fail=$((fail + 1)); printf 'FAIL gitignore: rc!=0\n'
fi

# 4. complete layout passes
mkfull "$TMP/repo"
if sh "$CHECK" "$TMP/repo" > "$TMP/out" 2>&1; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL complete: rc!=0\n'
fi

printf 'repo-layout: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
