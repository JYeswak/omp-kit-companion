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
# rz5.106.7: the report names class and location and never the matched text (this repo is public:
# the output goes to CI logs and to the pre-push gate.log).
if grep -q "secret: config.txt:1" "$TMP/out" && ! grep -q "$fake_token_body" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL secret-not-emitted: out<<<%s>>>\n' "$(sed "s/$fake_token_body/<TOKEN-BODY>/g" "$TMP/out")"
fi
# rz5.106.7: a secret in a binary tracked file is still found (no -I skip), still not printed.
mkfixture
printf 'x\000y token=%s%s\000z\n' "$fake_token_prefix" "$fake_token_body" > "$TMP/fixture/blob.bin"
git -C "$TMP/fixture" add blob.bin
expect_fail "secret-in-binary"
if grep -q "secret: blob.bin:" "$TMP/out" && ! grep -q "$fake_token_body" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL secret-in-binary-reported: out<<<%s>>>\n' "$(sed "s/$fake_token_body/<TOKEN-BODY>/g" "$TMP/out")"
fi
# rz5.106.7: an unreadable tracked file fails closed instead of being skipped.
mkfixture
printf 'nothing secret\n' > "$TMP/fixture/locked.txt"
git -C "$TMP/fixture" add locked.txt
chmod 000 "$TMP/fixture/locked.txt"
expect_fail "unreadable-fails-closed"
if grep -q "unreadable: locked.txt" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL unreadable-reported: out<<<%s>>>\n' "$(cat "$TMP/out")"
fi
chmod 600 "$TMP/fixture/locked.txt"

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
if grep -q "home-path: paths.txt:1" "$TMP/out" && ! grep -q "$home_user" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL home-user-not-emitted: out<<<%s>>>\n' "$(cat "$TMP/out")"
fi
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

# rz5.106.7: a tracked file whose name git C-quotes (here a tab) holding a planted token must not
# yield OK; a non-ASCII name stays scannable and its token is found.
mkfixture
tabname=$(printf 'odd\tname.txt')
printf 'token = "%s%s"\n' "$fake_token_prefix" "$fake_token_body" > "$TMP/fixture/$tabname"
git -C "$TMP/fixture" add -- "$tabname"
expect_fail "quoted-name-not-skipped"
if grep -q 'unscannable-name: ' "$TMP/out" && ! grep -q "$fake_token_body" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL quoted-name-reported: out<<<%s>>>\n' "$(sed "s/$fake_token_body/<TOKEN-BODY>/g" "$TMP/out")"
fi
mkfixture
nonascii=$(printf 'caf\303\251.txt')
printf 'token = "%s%s"\n' "$fake_token_prefix" "$fake_token_body" > "$TMP/fixture/$nonascii"
git -C "$TMP/fixture" add -A
expect_fail "non-ascii-name-scanned"
if grep -q 'secret: caf' "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL non-ascii-name-secret-found: out<<<%s>>>\n' "$(sed "s/$fake_token_body/<TOKEN-BODY>/g" "$TMP/out")"
fi

# rz5.106.7: producer failures fail closed with exit 2, never "publishability: OK", never content.
# A neutral fixture plus a planted token, so an OK or a printed token are both visible failures.
mkfixture
printf 'token = "%s%s"\n' "$fake_token_prefix" "$fake_token_body" > "$TMP/fixture/config.txt"
git -C "$TMP/fixture" add config.txt
real_git=$(command -v git)
real_grep=$(command -v grep)
mkdir -p "$TMP/stub-git" "$TMP/stub-grep"
# The stubs are script text: their $1 and $@ must stay literal, so single quotes are intended.
# shellcheck disable=SC2016
printf '#!/bin/sh\nfor a in "$@"; do [ "$a" = "ls-files" ] && { echo "fatal: planted ls-files failure" >&2; exit 128; }; done\nexec "%s" "$@"\n' "$real_git" > "$TMP/stub-git/git"
# shellcheck disable=SC2016
printf '#!/bin/sh\nfor a in "$@"; do [ "$a" = "-naoE" ] && { echo "grep: planted read error" >&2; exit 2; }; done\nexec "%s" "$@"\n' "$real_grep" > "$TMP/stub-grep/grep"
chmod +x "$TMP/stub-git/git" "$TMP/stub-grep/grep"
for producer in git grep; do
	rc=0
	PATH="$TMP/stub-$producer:$PATH" sh "$CHECK" "$TMP/fixture" > "$TMP/out" 2>&1 || rc=$?
	if [ "$rc" = "2" ] && ! grep -q 'publishability: OK' "$TMP/out" && ! grep -q "$fake_token_body" "$TMP/out"; then
		pass=$((pass + 1))
	else
		fail=$((fail + 1)); printf 'FAIL failing-%s-fails-closed: rc=%s out<<<%s>>>\n' "$producer" "$rc" "$(sed "s/$fake_token_body/<TOKEN-BODY>/g" "$TMP/out")"
	fi
done

printf 'publishability: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
