#!/bin/sh
# publishability.test.sh — PUB1 checker contract
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.106).
# Builds a fixture git repo with planted bad shapes and neutral controls;
# every verdict comes from the checker's exit code plus its complete output.
set -u

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
CHECK="$REPO_ROOT/scripts/publishability-check.sh"
REPO_TMP="$REPO_ROOT/var/agent-tmp"
mkdir -p "$REPO_TMP"
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
fake_token_prefix='ghp_'
fake_token_body='abcdefghijklmnopqrstuvwxyz0123456789'
printf 'token = "%s%s"\n' "$fake_token_prefix" "$fake_token_body" > "$TMP/fixture/config.txt"
git -C "$TMP/fixture" add config.txt
expect_fail "secret-token"

# 2. planted absolute home path is refused; the same path under scratch is ignored
mkfixture
home_root='/Users'
home_separator='/'
home_user='josh'
home_suffix='/work'
home_path="${home_root}${home_separator}${home_user}${home_suffix}"
printf 'root = "%s"\n' "$home_path" > "$TMP/fixture/paths.txt"
mkdir -p "$TMP/fixture/var/agent-tmp/scratch.1"
printf 'root = "%s"\n' "$home_path" > "$TMP/fixture/var/agent-tmp/scratch.1/paths.txt"
git -C "$TMP/fixture" add paths.txt
git -C "$TMP/fixture" add -f var/agent-tmp/scratch.1/paths.txt
expect_fail "home-path"
if sh "$CHECK" "$TMP/fixture" 2>&1 | grep -q "scratch.1"; then
	fail=$((fail + 1)); printf 'FAIL scratch-exempt: scratch finding reported\n'
else
	pass=$((pass + 1))
fi

# 3. planted private IP and LAN hostname refused; neutral fixtures pass
mkfixture
private_ip_prefix='10.'
private_ip_suffix='0.4.15'
lan_host='printer'
lan_suffix='.local'
printf 'db = "%s%s"\nlan = "%s%s"\n' "$private_ip_prefix" "$private_ip_suffix" "$lan_host" "$lan_suffix" > "$TMP/fixture/net.txt"
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
