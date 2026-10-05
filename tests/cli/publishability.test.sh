#!/bin/sh
# publishability.test.sh — PUB1 checker contract
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.106).
# Builds a fixture git repo with planted bad shapes and neutral controls;
# every verdict comes from the checker's exit code plus its complete output.
set -u

CHECK=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/publishability-check.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/publishability-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0
expect_fail() {
	name=$1
	if sh "$CHECK" "$TMP/fixture" > "$TMP/out" 2>&1; then
		fail=$((fail + 1)); printf 'FAIL %s: rc=0, expected findings\n' "$name"
	else
		got_rc=$?
		if [ "$got_rc" = "1" ]; then pass=$((pass + 1));
		else fail=$((fail + 1)); printf 'FAIL %s: rc=%s\n' "$name" "$got_rc"; fi
	fi
}

mkfixture() {
	rm -rf "$TMP/fixture"
	mkdir -p "$TMP/fixture"
	git -C "$TMP/fixture" init -q 2>/dev/null
	git -C "$TMP/fixture" config user.email "test@example.invalid"
	git -C "$TMP/fixture" config user.name "worker-1"
}

# 1. planted secret token is refused
mkfixture
printf 'token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"\n' > "$TMP/fixture/config.txt"
git -C "$TMP/fixture" add config.txt
expect_fail "secret-token"

# 2. planted absolute home path is refused; the same path under scratch is ignored
mkfixture
printf 'root = "/Users/josh/work"\n' > "$TMP/fixture/paths.txt"
mkdir -p "$TMP/fixture/var/agent-tmp/scratch.1"
printf 'root = "/Users/josh/work"\n' > "$TMP/fixture/var/agent-tmp/scratch.1/paths.txt"
git -C "$TMP/fixture" add paths.txt var/agent-tmp/scratch.1/paths.txt
expect_fail "home-path"
if sh "$CHECK" "$TMP/fixture" 2>&1 | grep -q "scratch.1"; then
	fail=$((fail + 1)); printf 'FAIL scratch-exempt: scratch finding reported\n'
else
	pass=$((pass + 1))
fi

# 3. planted private IP and LAN hostname refused; neutral fixtures pass
mkfixture
printf 'db = "10.0.4.15"\nlan = "printer.local"\n' > "$TMP/fixture/net.txt"
git -C "$TMP/fixture" add net.txt
expect_fail "private-net"
mkfixture
printf 'doc = "docs at example.invalid"\nby = "worker-1"\ntest = "192.0.2.44"\n' > "$TMP/fixture/neutral.txt"
git -C "$TMP/fixture" add neutral.txt
if sh "$CHECK" "$TMP/fixture" > "$TMP/out" 2>&1; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL neutral: rc!=0 out<<<%s>>>\n' "$(cat "$TMP/out")"
fi

printf 'publishability: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
