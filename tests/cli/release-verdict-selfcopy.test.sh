#!/bin/sh
# release-verdict.sh runs from a private copy (ompkit-6xxhu): rewriting the checkout's script in place
# while a verdict runs (as e78aa29091 did on 2026-11-01) must not change what the running process
# executes. RV_UNDER_TEST swaps in another script for the planted negative.
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
set -u
KITREPO=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
REPO_TMP="$KITREPO/var/agent-tmp"
mkdir -p "$REPO_TMP"
# shellcheck source=scripts/kitlib-tmp.sh
. "$KITREPO/scripts/kitlib-tmp.sh"
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP release-verdict-selfcopy-test || exit 1
pass=0
fail=0
ok() { if [ "$1" = 0 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s\n' "$2"; fi; }

repo="$TMP/repo"
mkdir -p "$repo/scripts"
git -C "$repo" init -q --template= -b main
git -C "$repo" config user.email t@example.invalid
git -C "$repo" config user.name t
cp "${RV_UNDER_TEST:-$KITREPO/scripts/release-verdict.sh}" "$repo/scripts/release-verdict.sh"
cp "$KITREPO/scripts/kitlib-tmp.sh" "$KITREPO/scripts/kitlib-shimpath.sh" "$repo/scripts/"
cat >"$repo/scripts/full-suite-verdict.sh" <<'EOF'
#!/bin/sh
commit=""
while [ $# -gt 0 ]; do case "$1" in --commit) commit=$2; shift 2 ;; *) shift ;; esac; done
: >"$RV_STARTED"
sleep 2
printf 'judged %s\n' "$commit" >>"$RV_LOG"
EOF
git -C "$repo" add -A
git -C "$repo" commit -qm "[test] one"
c1=$(git -C "$repo" rev-parse HEAD)
export RV_LOG="$TMP/judged.log" RV_STARTED="$TMP/started"

# While the runner sleeps, rewrite the script in place (same inode, as an editor or a commit does) with
# lines that announce themselves; any read of the new bytes runs one of them.
: >"$RV_LOG"
sh "$repo/scripts/release-verdict.sh" --commit "$c1" --no-fetch >"$TMP/out" 2>&1 &
holder=$!
i=0
while [ ! -f "$RV_STARTED" ] && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
n=0
while [ "$n" -lt 400 ]; do printf 'printf "REWRITTEN\\n"\n'; n=$((n + 1)); done >"$TMP/rewrite"
cat "$TMP/rewrite" >"$repo/scripts/release-verdict.sh"
wait "$holder"
rc=$?
# Exactly the run's own two lines: no REWRITTEN, no parse error from reading new bytes at old offsets.
[ "$rc" = 0 ] && grep -qx "judged $c1" "$RV_LOG" && [ "$(grep -c . "$TMP/out")" = 2 ] \
	&& [ "$(grep -c '^release-verdict: ' "$TMP/out")" = 2 ]
ok $? "running-verdict-ignores-rewrite: rc=$rc out=$(cat "$TMP/out")"
set -- "$repo"/.git/omp-kit/release-verdict.run.*
[ ! -e "$1" ]
ok $? "private-copy-removed: $*"

printf 'release-verdict-selfcopy: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = 0 ]
