#!/bin/sh
# install-sync-check.test.sh - SYNC1 box 5 installer contract (ompkit-pwdi).
# Fixture repo without scripts/: install creates it, the copy proves itself;
# re-install is idempotent; non-repos and the kit root itself are refused.
set -u
INSTALLER=$(CDPATH='' cd -- "$(dirname "$0")/../../scripts" && pwd -P)/install-sync-check.sh
TMP=var/agent-tmp/install-sync-check-test-$$
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT INT TERM
pass=0
fail=0
ok() {
	if [ "$1" = "$2" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s: got %s want %s\n' "$3" "$1" "$2"; fi
}

ORIGIN="$TMP/origin.git"
git init -q --bare "$ORIGIN"
R="$TMP/repo"
git clone -q "$ORIGIN" "$R" 2>/dev/null
rm -f "$R/.git/hooks/commit-msg"
GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@e GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@e \
	git -C "$R" commit -q --allow-empty --message "root [test]"
git -C "$R" push -q origin HEAD:main 2>/dev/null
[ -d "$R/scripts" ]
rc=$?
ok "$rc" "1" "fixture-has-no-scripts"
# 1. install creates scripts/ and the copy proves itself (synced repo -> 0)
sh "$INSTALLER" "$R" > "$TMP/o1" 2>&1
ok "$?" "0" "install-rc"
[ -x "$R/scripts/sync-check.sh" ]
rc=$?
ok "$rc" "0" "copy-executable"
grep -q "probe exit 0" "$TMP/o1"
ok "$?" "0" "probe-synced"
grep -q "undo: rm" "$TMP/o1"
ok "$?" "0" "undo-printed"

# 2. re-install is idempotent
sh "$INSTALLER" "$R" > /dev/null 2>&1
ok "$?" "0" "reinstall-rc"

# 3. non-repo refused nonzero
sh "$INSTALLER" "$TMP/nope" > /dev/null 2>&1
ok "$?" "2" "nonrepo-refused"

# 4. the kit root itself is refused (it is the source)
sh "$INSTALLER" "$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd -P)" > /dev/null 2>&1
ok "$?" "2" "self-refused"

printf 'install-sync-check: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
