#!/bin/sh
# check-tap-owner.test.sh — RT1 Homebrew slice 4/4 ownership gate contract.
set -u
CHECK=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/check-tap-owner.sh
# shellcheck source=scripts/kitlib-tmp.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/kitlib-tmp.sh"
kitlib_tmp TMP check-tap-owner-test || exit 1
pass=0
fail=0
check() { # name expected_rc actual_rc output [pattern...]
	name=$1; want=$2; got=$3; out=$4; shift 4
	ok=1
	[ "$got" = "$want" ] || ok=0
	for pattern in "$@"; do
		printf '%s' "$out" | grep -q -- "$pattern" || ok=0
	done
	if [ "$ok" = "1" ]; then pass=$((pass + 1)); printf 'ok %s\n' "$name";
	else fail=$((fail + 1)); printf 'FAIL %s (rc=%s want=%s out=%s)\n' "$name" "$got" "$want" "$out"; fi
}
good='{"tap":"JYeswak/homebrew-tap","owner":"JYeswak","provenance":"parent comment 1155 + AM56114"}'
printf '%s\n' "$good" > "$TMP/good.json"
out=$(sh "$CHECK" check --tap JYeswak/homebrew-tap --record "$TMP/good.json" 2>&1); rc=$?
check "owner gate: matching record verifies" 0 "$rc" "$out" "TAP_OWNER=verified"
printf '%s\n' '{"tap":"JYeswak/homebrew-tap","owner":"EvilOrg"}' > "$TMP/evil.json"
out=$(sh "$CHECK" check --tap JYeswak/homebrew-tap --record "$TMP/evil.json" 2>&1); rc=$?
check "planted: mismatched owner refused" 4 "$rc" "$out" "does not own tap"
out=$(sh "$CHECK" check --tap JYeswak/homebrew-tap --record "$TMP/absent.json" 2>&1); rc=$?
check "planted: missing record refused" 4 "$rc" "$out" "no owner record"
printf '%s\n' '{"tap":"JYeswak/homebrew-tap","owner":""}' > "$TMP/empty.json"
out=$(sh "$CHECK" check --tap JYeswak/homebrew-tap --record "$TMP/empty.json" 2>&1); rc=$?
check "planted: empty owner refused" 4 "$rc" "$out" "empty or malformed"
out=$(sh "$CHECK" check --tap not-a-tap --record "$TMP/good.json" 2>&1); rc=$?
check "planted: malformed tap refused" 2 "$rc" "$out" "OWNER/REPO"
printf '%s tests passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
