#!/bin/sh
# RELCLOCK1 (ompkit-774u.67): release-verdict.sh judges the published head with that commit's own
# runner, one run per repo at a time, and a run that finds the lock held hands its commit to the
# holder, which judges the newest wanted commit before it releases the lock.
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
set -u
KITREPO=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
REPO_TMP="$KITREPO/var/agent-tmp"
mkdir -p "$REPO_TMP"
# shellcheck source=scripts/kitlib-tmp.sh
. "$KITREPO/scripts/kitlib-tmp.sh"
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP release-verdict-test || exit 1
pass=0
fail=0
ok() { if [ "$1" = 0 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s\n' "$2"; fi; }

repo="$TMP/repo"
mkdir -p "$repo/scripts"
git -C "$repo" init -q --template= -b main
git -C "$repo" config user.email t@example.invalid
git -C "$repo" config user.name t
cp "$KITREPO/scripts/release-verdict.sh" "$KITREPO/scripts/kitlib-tmp.sh" "$repo/scripts/"
# The committed runner records which commit it judged and from which directory it ran; the
# working-tree copy is replaced below, so a run that used it would record WORKTREE.
cat >"$repo/scripts/full-suite-verdict.sh" <<'EOF'
#!/bin/sh
commit=""
while [ $# -gt 0 ]; do case "$1" in --commit) commit=$2; shift 2 ;; *) shift ;; esac; done
[ -z "${RV_SLEEP:-}" ] || sleep "$RV_SLEEP"
printf 'judged %s from-export\n' "$commit" >>"$RV_LOG"
exit "${RV_RC:-0}"
EOF
git -C "$repo" add -A
git -C "$repo" commit -qm "[test] one"
c1=$(git -C "$repo" rev-parse HEAD)
cat >"$repo/scripts/full-suite-verdict.sh" <<'EOF'
#!/bin/sh
printf 'judged WORKTREE\n' >>"$RV_LOG"
EOF
export RV_LOG="$TMP/judged.log"

# 1. The commit's own runner is used, never the working tree's.
: >"$RV_LOG"
sh "$repo/scripts/release-verdict.sh" --commit "$c1" --no-fetch >"$TMP/o1" 2>&1
rc=$?
[ "$rc" = 0 ] && grep -qx "judged $c1 from-export" "$RV_LOG" && ! grep -q WORKTREE "$RV_LOG"
ok $? "exported-runner: rc=$rc log=$(cat "$RV_LOG")"

# 2. The runner's failure is the script's status.
: >"$RV_LOG"
RV_RC=1 sh "$repo/scripts/release-verdict.sh" --commit "$c1" --no-fetch >"$TMP/o2" 2>&1
rc=$?
st=1; [ "$rc" = 1 ] && st=0
ok "$st" "failure-propagates: rc=$rc"

# 3. A second run while the first holds the lock hands over its commit and exits 0; the holder
# judges it before releasing the lock.
git -C "$repo" commit -q --allow-empty -m "[test] two"
c2=$(git -C "$repo" rev-parse HEAD)
: >"$RV_LOG"
RV_SLEEP=3 sh "$repo/scripts/release-verdict.sh" --commit "$c1" --no-fetch >"$TMP/o3a" 2>&1 &
holder=$!
i=0
while [ ! -f "$repo/.git/omp-kit/release-verdict.lock/pid" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
sh "$repo/scripts/release-verdict.sh" --commit "$c2" --no-fetch >"$TMP/o3b" 2>&1
rc2=$?
wait "$holder"
rc1=$?
[ "$rc2" = 0 ] && grep -q "holds the lock" "$TMP/o3b" && [ "$rc1" = 0 ] \
	&& [ "$(sed -n 1p "$RV_LOG")" = "judged $c1 from-export" ] && [ "$(sed -n 2p "$RV_LOG")" = "judged $c2 from-export" ] \
	&& [ ! -d "$repo/.git/omp-kit/release-verdict.lock" ]
ok $? "handover: rc1=$rc1 rc2=$rc2 log=$(cat "$RV_LOG")"

# 4. A lock left by a dead holder is taken, not obeyed.
mkdir -p "$repo/.git/omp-kit/release-verdict.lock"
sh -c 'exit 0' &
dead=$!
wait "$dead"
printf '%s\n' "$dead" >"$repo/.git/omp-kit/release-verdict.lock/pid"
: >"$RV_LOG"
sh "$repo/scripts/release-verdict.sh" --commit "$c2" --no-fetch >"$TMP/o4" 2>&1
rc=$?
[ "$rc" = 0 ] && grep -qx "judged $c2 from-export" "$RV_LOG"
ok $? "stale-lock: rc=$rc"

printf 'release-verdict: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = 0 ]
