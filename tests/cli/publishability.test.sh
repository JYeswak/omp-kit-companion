#!/bin/sh
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
# publishability.test.sh — PUB1 checker contract
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.106).
# Builds a fixture git repo with planted bad shapes and neutral controls;
# every verdict comes from the checker's exit code plus its complete output.
set -u

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
CHECK="$REPO_ROOT/scripts/publishability-check.sh"
REPO_TMP="$REPO_ROOT/var/agent-tmp"
mkdir -p "$REPO_TMP"
# shellcheck source=scripts/kitlib-tmp.sh
. "$REPO_TMP/../../scripts/kitlib-tmp.sh"
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP publishability-test || exit 1

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
# 0. a shell test running with hook selectors cannot write the hook index or config.
sentinel="$TMP/git-env-sentinel"
mkdir -p "$sentinel"
git -C "$sentinel" init -q
git -C "$sentinel" config --local user.name "Sentinel"
git -C "$sentinel" config --local user.email "sentinel@example.invalid"
printf 'sentinel\n' > "$sentinel/sentinel.txt"
git -C "$sentinel" add sentinel.txt
cp "$sentinel/.git/index" "$TMP/sentinel-index.before"
shell_test_rc=0
if GIT_DIR="$sentinel/.git" GIT_INDEX_FILE="$sentinel/.git/index" sh "$REPO_ROOT/tests/cli/agent-trailer.test.sh" > "$TMP/shell-test.out" 2>&1; then
	:
else
	shell_test_rc=$?
fi
sentinel_name=$(git -C "$sentinel" config --local user.name)
sentinel_email=$(git -C "$sentinel" config --local user.email)
index_unchanged=0
if cmp -s "$TMP/sentinel-index.before" "$sentinel/.git/index"; then index_unchanged=1; fi
if [ "$shell_test_rc" = "0" ] && [ "$sentinel_name" = "Sentinel" ] && [ "$sentinel_email" = "sentinel@example.invalid" ] && [ "$index_unchanged" = "1" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL shell-test-git-env: rc=%s name=%s email=%s index_unchanged=%s out<<<%s>>>\n' "$shell_test_rc" "$sentinel_name" "$sentinel_email" "$index_unchanged" "$(cat "$TMP/shell-test.out")"
fi


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
# rz5.106.7: an unreadable tracked file ends the run incomplete (UNRUN, exit
# 2): unscanned bytes are not clean bytes.
mkfixture
printf 'nothing secret\n' > "$TMP/fixture/locked.txt"
git -C "$TMP/fixture" add locked.txt
chmod 000 "$TMP/fixture/locked.txt"
rc=0; sh "$CHECK" "$TMP/fixture" > "$TMP/out" 2>&1 || rc=$?
chmod 600 "$TMP/fixture/locked.txt"
if [ "$rc" = "2" ] && grep -q "UNRUN" "$TMP/out" && grep -q "locked.txt" "$TMP/out" && ! grep -q 'publishability: OK' "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL unreadable-unrun: rc=%s out<<<%s>>>\n' "$rc" "$(cat "$TMP/out")"
fi

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
printf '#!/bin/sh\nfor a in "$@"; do case "$a" in *config.txt*) echo "grep: planted read error" >&2; exit 2;; esac; done\nexec "%s" "$@"\n' "$real_grep" > "$TMP/stub-grep/grep"
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
# rz5.106.7 REWORK: a fault hitting ONLY the reporting grep (the count
# precheck passes through) must still fail closed: the pipeline masks the
# reporter status, so the scanner records it separately.
mkdir -p "$TMP/stub-reporter"
# shellcheck disable=SC2016
printf '#!/bin/sh\nfor a in "$@"; do [ "$a" = "-naoE" ] && { echo "grep: planted reporter error" >&2; exit 2; }; done\nexec "%s" "$@"\n' "$real_grep" > "$TMP/stub-reporter/grep"
chmod +x "$TMP/stub-reporter/grep"
rc=0
PATH="$TMP/stub-reporter:$PATH" sh "$CHECK" "$TMP/fixture" > "$TMP/out" 2>&1 || rc=$?
if [ "$rc" = "2" ] && ! grep -q 'publishability: OK' "$TMP/out" && ! grep -q "$fake_token_body" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL reporter-fault-fails-closed: rc=%s out<<<%s>>>\n' "$rc" "$(sed "s/$fake_token_body/<TOKEN-BODY>/g" "$TMP/out")"
fi


# rz5.106.7 REWORK: a downstream stage failing AFTER consuming its input
# must still fail closed: the fault injector drains stdin like the real
# late -vE failure, then exits 2.
mkdir -p "$TMP/stub-late"
# shellcheck disable=SC2016
printf '#!/bin/sh\ncat > /dev/null\necho "awk: planted late error" >&2\nexit 2\n' > "$TMP/stub-late/awk"
chmod +x "$TMP/stub-late/awk"
rc=0
PATH="$TMP/stub-late:$PATH" sh "$CHECK" "$TMP/fixture" > "$TMP/out" 2>&1 || rc=$?
if [ "$rc" = "2" ] && ! grep -q 'publishability: OK' "$TMP/out" && ! grep -q "$fake_token_body" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL late-fault-fails-closed: rc=%s out<<<%s>>>\n' "$rc" "$(sed "s/$fake_token_body/<TOKEN-BODY>/g" "$TMP/out")"
fi

# rz5.106.7: zero scanned subjects is UNRUN (exit 2), never OK: an empty repo, and a plain directory
# nested inside a repo (an extracted archive) whose files git does not track.
mkfixture
rc=0; sh "$CHECK" "$TMP/fixture" > "$TMP/out" 2>&1 || rc=$?
if [ "$rc" = "2" ] && grep -q 'UNRUN' "$TMP/out" && ! grep -q 'publishability: OK' "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL empty-repo-unrun: rc=%s out<<<%s>>>\n' "$rc" "$(cat "$TMP/out")"
fi
mkfixture
printf 'tracked\n' > "$TMP/fixture/kept.txt"
git -C "$TMP/fixture" add kept.txt
mkdir -p "$TMP/fixture/extract"
printf 'token = "%s%s"\n' "$fake_token_prefix" "$fake_token_body" > "$TMP/fixture/extract/config.txt"
rc=0; sh "$CHECK" "$TMP/fixture/extract" > "$TMP/out" 2>&1 || rc=$?
if [ "$rc" = "2" ] && grep -q 'UNRUN' "$TMP/out" && ! grep -q 'publishability: OK' "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL nested-dir-unrun: rc=%s out<<<%s>>>\n' "$rc" "$(sed "s/$fake_token_body/<TOKEN-BODY>/g" "$TMP/out")"
fi
# rz5.106.7: an OK names how many files it scanned. Scratch is an owned dir in the scanned repo's
# var/agent-tmp, never TMPDIR: a planted forbidden TMPDIR (stand-in for macOS /var/folders) stays
# unused, the run leaves no scratch behind, and while it runs the dir carries .owner.
forbidden="$TMP/forbidden-tmpdir"
rc=0; TMPDIR="$forbidden" sh "$CHECK" "$TMP/fixture" > "$TMP/out" 2>&1 || rc=$?
left=$(find "$TMP/fixture/var/agent-tmp" -mindepth 1 2>/dev/null | wc -l | tr -d ' ')
if [ "$rc" = "0" ] && grep -q 'publishability: OK (1 file(s) scanned)' "$TMP/out" && [ ! -e "$forbidden" ] && [ "$left" = "0" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL owned-scratch-not-tmpdir: rc=%s forbidden_exists=%s leftover=%s out<<<%s>>>\n' "$rc" "$([ -e "$forbidden" ] && echo yes || echo no)" "$left" "$(cat "$TMP/out")"
fi
# While a scan runs, its scratch dir carries an .owner naming the scanner pid (stub grep pauses it).
mkdir -p "$TMP/stub-slow"
# The stub calls the real grep by absolute path: an unqualified grep inside it resolves to the stub
# itself and recurses without bound. shellcheck SC2016: the stub's $d and $@ stay literal.
# shellcheck disable=SC2016
printf '#!/bin/sh\nfor d in "%s"/var/agent-tmp/publishability.*; do [ -f "$d/.owner" ] && "%s" -q "^pid=" "$d/.owner" && touch "%s/owner-seen"; done\nexec "%s" "$@"\n' "$TMP/fixture" "$real_grep" "$TMP" "$real_grep" > "$TMP/stub-slow/grep"
chmod +x "$TMP/stub-slow/grep"
rm -f "$TMP/owner-seen"
PATH="$TMP/stub-slow:$PATH" sh "$CHECK" "$TMP/fixture" > "$TMP/out" 2>&1 || true
if [ -f "$TMP/owner-seen" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL scratch-has-owner: out<<<%s>>>\n' "$(cat "$TMP/out")"
fi

# rz5.106.7 REWORK: a tracked file deleted from the worktree (the index still
# lists it) ends the run incomplete (UNRUN, exit 2), never OK.
mkfixture
printf 'neutral readme\n' > "$TMP/fixture/README.md"
printf 'will be gone\n' > "$TMP/fixture/gone.md"
git -C "$TMP/fixture" add README.md gone.md
rm "$TMP/fixture/gone.md"
rc=0; sh "$CHECK" "$TMP/fixture" > "$TMP/out" 2>&1 || rc=$?
if [ "$rc" = "2" ] && grep -q "UNRUN" "$TMP/out" && grep -q "gone.md" "$TMP/out" && ! grep -q 'publishability: OK' "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL missing-tracked-unrun: rc=%s out<<<%s>>>\n' "$rc" "$(cat "$TMP/out")"
fi
# rz5.106.7 REWORK: matched values must never touch disk in the scan scratch
# dir while the scan runs. The inventory stub records every scratch dir
# listing on each grep call; any raw-hit artifact (the pre-fix hits file)
# fails the case.
mkfixture
printf 'token = "%s%s"\n' "$fake_token_prefix" "$fake_token_body" > "$TMP/fixture/config.txt"
git -C "$TMP/fixture" add config.txt
mkdir -p "$TMP/stub-inv"
# shellcheck disable=SC2016
printf '#!/bin/sh\nfor d in "%s"/var/agent-tmp/publishability.*; do [ -d "$d" ] && ls -A "$d" >> "%s/inv.log"; done\nexec "%s" "$@"\n' "$TMP/fixture" "$TMP" "$real_grep" > "$TMP/stub-inv/grep"
chmod +x "$TMP/stub-inv/grep"
rm -f "$TMP/inv.log"
PATH="$TMP/stub-inv:$PATH" sh "$CHECK" "$TMP/fixture" > "$TMP/out" 2>&1 || true
inv_lines=$(wc -l < "$TMP/inv.log" 2>/dev/null | tr -d ' ') || inv_lines=0
if [ "${inv_lines:-0}" -gt 0 ] && ! grep -qx 'hits' "$TMP/inv.log" 2>/dev/null && ! grep -q "$fake_token_body" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL no-raw-temp: inv_lines=%s inv<<<%s>>> out<<<%s>>>\n' "${inv_lines:-0}" "$(cat "$TMP/inv.log" 2>/dev/null)" "$(sed "s/$fake_token_body/<TOKEN-BODY>/g" "$TMP/out")"
fi

printf 'publishability: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
