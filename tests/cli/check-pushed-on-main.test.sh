#!/bin/sh
# check-pushed-on-main.test.sh -- PUSHGUARD1 member contract (ompkit-rc-epic-land-fix-release-dogfood-rz5.139).
# Fixture: main holds c1 <- c2; X is a private-index style candidate on c1
# (commit-tree -p c1) that main does not hold. Lines are fed the way git's
# pre-push protocol does: <local ref> <local sha> <remote ref> <remote sha>.
set -u
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"

MEMBER=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/check-pushed-on-main.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/on-main-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0
ok() {
	if [ "$1" = "$2" ]; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: got %s want %s\n' "$3" "$1" "$2"; fi
}

R="$TMP/repo"
git init -q -b main "$R"
git -C "$R" config user.email "test@invalid.example"
git -C "$R" config user.name "Test"
git -C "$R" commit -q --no-verify --allow-empty -m c1
C1=$(git -C "$R" rev-parse HEAD)
git -C "$R" commit -q --no-verify --allow-empty -m c2
C2=$(git -C "$R" rev-parse HEAD)
X=$(printf 'candidate\n' | git -C "$R" commit-tree "$C1^{tree}" -p "$C1")
Z=0000000000000000000000000000000000000000

# judge <repo> <lines>: run the member from the repo top level like git does.
judge() {
	printf '%s' "$2" | (CDPATH='' cd -- "$1" && sh "$MEMBER") 2> "$TMP/err"
}

judge "$R" "refs/heads/main $C2 refs/heads/main $C1
"
ok "$?" "0" "main-tip-passes"
judge "$R" "refs/heads/main $C1 refs/heads/main $Z
"
ok "$?" "0" "main-ancestor-passes"

judge "$R" "refs/heads/cand $X refs/heads/main $C1
"
ok "$?" "4" "candidate-refused"
grep -q "REFUSED $X" "$TMP/err"
ok "$?" "0" "candidate-named"

judge "$R" "(delete) $Z refs/heads/main $C2
"
ok "$?" "4" "deletion-refused"

judge "$R" "refs/heads/cand $X refs/heads/feature $Z
"
ok "$?" "0" "other-remote-ref-passes"

# A refused line is not cleared by a passing line after it, and only the
# off-main sha is named.
judge "$R" "refs/heads/cand $X refs/heads/main $C1
refs/heads/main $C2 refs/heads/main $C1
"
ok "$?" "4" "mixed-lines-refused"
grep -c REFUSED "$TMP/err" > "$TMP/count"
ok "$(cat "$TMP/count")" "1" "mixed-lines-one-refusal"

judge "$R" "refs/heads/main deadbeefdeadbeefdeadbeefdeadbeefdeadbeef refs/heads/main $C2
"
ok "$?" "4" "unknown-object-refused"

M="$TMP/nomain"
git init -q -b trunk "$M"
git -C "$M" config user.email "test@invalid.example"
git -C "$M" config user.name "Test"
git -C "$M" commit -q --no-verify --allow-empty -m t1
T1=$(git -C "$M" rev-parse HEAD)
judge "$M" "refs/heads/trunk $T1 refs/heads/main $Z
"
ok "$?" "4" "no-local-main-refused"

printf 'check-pushed-on-main: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
