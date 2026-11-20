#!/bin/sh
# suite-lease-owner.test.sh — SUITELEASEOWNER1. A suite lease whose owner pid has no readable start time (the omp bash
# tool's sh and bash report a virtual $$ that is not a process) refuses SUITE_LEASE_OWNER_UNREADABLE and, since
# 2026-11-20, says what to do: start the verdict through /bin/sh. Planted: an owner pid that exited. Control: the
# running test's own pid takes the lease, so the refusal is about the owner and not about the helper.
set -u
KITROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
REPO_TMP="$KITROOT_DIR/var/agent-tmp"
mkdir -p "$REPO_TMP"
# shellcheck source=scripts/kitlib-tmp.sh
. "$KITROOT_DIR/scripts/kitlib-tmp.sh"
KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP suite-lease-owner-test || exit 1
TMP=$(cd "$TMP" && pwd -P)
pass=0
fail=0
ok() { if [ "$1" = 0 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s\n' "$2"; fi; }

SUITE_LEASE_LIB=$KITROOT_DIR/scripts
# shellcheck source=scripts/suite-lease.sh
. "$KITROOT_DIR/scripts/suite-lease.sh"

# acquire OWNER STATE: one acquire attempt; rc in $rc, helper output in $out.
acquire() {
	rc=0
	out=$(suite_lease__py acquire --owner "$1" --launcher owner-test --tree 0000000000000000000000000000000000000001 \
		--role base --commit 0000000000000000000000000000000000000002 --state "$2" --join 0 --entry "" \
		--priority normal --wait-secs 5 --queue-max 3 2>&1) || rc=$?
}

sh -c 'exit 0' &
gone=$!
wait "$gone"
acquire "$gone" "$TMP/dead-owner"
[ "$rc" = 75 ] && printf '%s' "$out" | grep -Fq 'REFUSED SUITE_LEASE_OWNER_UNREADABLE' \
	&& printf '%s' "$out" | grep -Fq '/bin/sh' && printf '%s' "$out" | grep -Fq 'virtual $$'
ok $? "dead-owner-refusal-names-the-remedy: rc=$rc out=$out"

acquire "$$" "$TMP/live-owner"
[ "$rc" = 0 ] && printf '%s' "$out" | grep -q '^ACQUIRED '
ok $? "live-owner-takes-the-lease: rc=$rc out=$out"
suite_lease__py release --owner "$$" --state "$TMP/live-owner" >/dev/null 2>&1 || :

kitlib_tmp_cleanup "$TMP" 2>/dev/null || :
printf 'suite-lease-owner: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = 0 ]
