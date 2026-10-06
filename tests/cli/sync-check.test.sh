#!/bin/sh
# sync-check.test.sh - SYNC1 boxes 1-2 contract (ompkit-pwdi).
# Temp bare origin + clones: current passes, 3-behind refused with the
# drop-back line, fast-forward moves HEAD cleanly, dirty and diverged report
# without touching anything. No network; file:// remote only.
set -u
CHECK=$(CDPATH='' cd -- "$(dirname "$0")/../../scripts" && pwd -P)/sync-check.sh
TMP=var/agent-tmp/sync-check-test-$$
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT INT TERM
pass=0
fail=0
ok() {
	if [ "$1" = "$2" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s: got %s want %s\n' "$3" "$1" "$2"; fi
}
git_env() { GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@e GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@e "$@"; }
# Fresh repos inherit Josh's global commit-msg hook template; fixture commits
# are not fleet commits, so remove the hook in every fixture repo.
unhook() { rm -f "$1/.git/hooks/commit-msg"; }

# Origin with one commit; WORK cloned at that commit; SEED advances origin by 3.
ORIGIN="$TMP/origin.git"
git init -q --bare "$ORIGIN"
SEED="$TMP/seed"
git clone -q "$ORIGIN" "$SEED" 2>/dev/null
unhook "$SEED"
git_env git -C "$SEED" commit -q --allow-empty --message "root [test]"
git -C "$SEED" push -q origin HEAD:main 2>/dev/null
WORK="$TMP/work"
git clone -q "$ORIGIN" "$WORK" 2>/dev/null
unhook "$WORK"
git -C "$WORK" checkout -q main 2>/dev/null || git -C "$WORK" checkout -q -b main origin/main
for i in 1 2 3; do echo "$i" > "$SEED/advance.txt"; git_env git -C "$SEED" add advance.txt; git_env git -C "$SEED" commit -q --message "up $i [test]"; done
git -C "$SEED" push -q origin HEAD:main 2>/dev/null

# 1. current passes
FRESH="$TMP/fresh"
git clone -q "$ORIGIN" "$FRESH" 2>/dev/null
git -C "$FRESH" checkout -q main 2>/dev/null || true
sh "$CHECK" --repo "$FRESH" > "$TMP/o1" 2>&1
ok "$?" "0" "current-passes"
grep -q "SYNCED" "$TMP/o1"
ok "$?" "0" "current-says-synced"

# 2. three behind refused with drop-back + exact command
sh "$CHECK" --repo "$WORK" > "$TMP/o2" 2>&1
ok "$?" "4" "behind-refused"
grep -q "drop back: sync first" "$TMP/o2"
ok "$?" "0" "behind-drop-back-line"
grep -q "3 commit(s) behind" "$TMP/o2"
ok "$?" "0" "behind-count"
grep -q "merge --ff-only origin/main" "$TMP/o2"
ok "$?" "0" "behind-exact-command"

# 2b. post-push assertion: gap reported with count, clean reports OK
sh "$CHECK" --repo "$WORK" --assert-synced > "$TMP/o2b" 2>&1
ok "$?" "4" "assert-gap-rc"
grep -q "POST-PUSH-GAP" "$TMP/o2b"
ok "$?" "0" "assert-gap-named"
grep -q "3 commit(s) behind" "$TMP/o2b"
ok "$?" "0" "assert-gap-count"
sh "$CHECK" --repo "$FRESH" --assert-synced > "$TMP/o2c" 2>&1
ok "$?" "0" "assert-clean-rc"

# 3. fast-forward happy path (with an unrelated uncommitted file present)
echo precious > "$WORK/keep.txt"
sh "$CHECK" --repo "$WORK" --fast-forward > "$TMP/o3" 2>&1
ok "$?" "0" "ff-rc"
grep -q "FAST-FORWARDED" "$TMP/o3"
ok "$?" "0" "ff-report"
[ "$(git -C "$WORK" rev-parse HEAD)" = "$(git -C "$WORK" rev-parse origin/main)" ]; rc=$?; ok "$rc" "0" "ff-moved"
[ "$(cat "$WORK/keep.txt")" = "precious" ]; rc=$?; ok "$rc" "0" "ff-kept-unrelated"
[ "$(cat "$WORK/advance.txt")" = "3" ]; rc=$?; ok "$rc" "0" "ff-updated-worktree"
sh "$CHECK" --repo "$WORK" > /dev/null 2>&1
ok "$?" "0" "ff-now-synced"

# 4. dirty-blocked: origin advances tracked file F, work edits F uncommitted
echo one > "$SEED/f.txt"
git_env git -C "$SEED" add f.txt
git_env git -C "$SEED" commit -q --message "track f"
git -C "$SEED" push -q origin HEAD:main 2>/dev/null
git -C "$WORK" fetch -q origin 2>/dev/null
echo local-edit > "$WORK/f.txt"
BEFORE=$(git -C "$WORK" rev-parse HEAD)
sh "$CHECK" --repo "$WORK" --fast-forward > "$TMP/o4" 2>&1
ok "$?" "4" "dirty-refused"
[ "$(git -C "$WORK" rev-parse HEAD)" = "$BEFORE" ]; rc=$?; ok "$rc" "0" "dirty-head-unmoved"
[ "$(cat "$WORK/f.txt")" = "local-edit" ]; rc=$?; ok "$rc" "0" "dirty-content-intact"

# 5. diverged: local commit on top + upstream commit
git -C "$WORK" checkout -q -- f.txt 2>/dev/null
git_env git -C "$WORK" commit -q --allow-empty --message "local only"
echo more >> "$SEED/f.txt"
git_env git -C "$SEED" commit -qam "upstream more"
git -C "$SEED" push -q origin HEAD:main 2>/dev/null
BEFORE=$(git -C "$WORK" rev-parse HEAD)
sh "$CHECK" --repo "$WORK" --fast-forward > "$TMP/o5" 2>&1
ok "$?" "4" "diverged-refused"
grep -q "DIVERGED" "$TMP/o5"
ok "$?" "0" "diverged-named"
[ "$(git -C "$WORK" rev-parse HEAD)" = "$BEFORE" ]; rc=$?; ok "$rc" "0" "diverged-head-unmoved"

# 6. non-repo refused nonzero
sh "$CHECK" --repo "$TMP/nope" > /dev/null 2>&1
ok "$?" "2" "nonrepo-refused"

printf 'sync-check: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
