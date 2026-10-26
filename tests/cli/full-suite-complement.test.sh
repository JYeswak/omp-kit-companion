#!/bin/sh
# full-suite-complement.test.sh: NODOUBLEPASS1 (ompkit-bp50d). The full-suite verdict given a
# focused-passed report for the SAME tree runs only the complement and records the covered set;
# a report for another tree, or naming a file the archive does not enumerate, changes nothing;
# a failing complement file still fails the verdict (no coverage lost).
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
set -u
KITROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
VERDICT=${FULL_SUITE_VERDICT_UNDER_TEST:-"$KITROOT_DIR/scripts/full-suite-verdict.sh"}
REPO_TMP="$KITROOT_DIR/var/agent-tmp"
# shellcheck source=scripts/kitlib-tmp.sh
. "$KITROOT_DIR/scripts/kitlib-tmp.sh"
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP full-suite-complement-test || exit 1
pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }
not_ok() { fail=$((fail + 1)); echo "not ok - $1"; }
step() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1"; }

# Fixture: three bun files and one shell suite; one bun file fails only when FIXTURE_FAIL_C is set.
repo="$TMP/repo"
mkdir -p "$repo/scripts" "$repo/tests/cli"
cp "$KITROOT_DIR/scripts/kitlib-tmp.sh" "$repo/scripts/kitlib-tmp.sh"
for n in a b; do
	printf 'import { test, expect } from "bun:test";\ntest("%s", () => { expect(1).toBe(1); });\n' "$n" >"$repo/tests/cli/$n.test.ts"
done
printf 'import { test, expect } from "bun:test";\ntest("c", () => { expect(process.env.FIXTURE_FAIL_C ?? "").toBe(""); });\n' >"$repo/tests/cli/c.test.ts"
printf '#!/bin/sh\necho "shell suite ran"\nexit 0\n' >"$repo/tests/cli/s.test.sh"
git -C "$repo" init -q
git -C "$repo" config user.name "NODOUBLEPASS1 test"
git -C "$repo" config user.email "nodoublepass1@example.invalid"
git -C "$repo" add -A
git -C "$repo" commit -q -m "[test] NODOUBLEPASS1 fixture"
tree=$(git -C "$repo" rev-parse 'HEAD^{tree}')
judge=$(shasum -a 256 "$(dirname -- "$VERDICT")/fresh-gate.sh" | cut -d' ' -f1)
runtime="$(uname -s)/$(uname -m)/bun-$(bun --version)/$(python3 --version 2>&1)"
hdr() { printf 'tree %s\njudge %s\nruntime %s\n' "$1" "$judge" "$runtime"; }

run_verdict() {
	out="$TMP/$1.out"
	shift
	rm -rf "$repo.cache"
	# env -u: a planted FIXTURE_FAIL_C must never leak into the next run (POSIX sh keeps a prefix
	# assignment on a function call in the caller's environment).
	env -u FIXTURE_FAIL_C ${FAIL_C:+FIXTURE_FAIL_C=1} KITROOT="$KITROOT_DIR" OMP_KIT_OMP_SRC_FETCH=0 sh "$VERDICT" --repo "$repo" --commit HEAD --cache-dir "$repo.cache" "$@" >"$out" 2>&1
	rc=$?
}

# 1. same-tree report covering a, b and the shell suite: only c runs; verdict PASS records the split.
step "same-tree report"
report="$TMP/passed.txt"
{ hdr "$tree"; printf 'tests/cli/a.test.ts\ntests/cli/b.test.ts\ntests/cli/s.test.sh\n'; } >"$report"
run_verdict same --focused-passed "$report"
if [ "$rc" -eq 0 ]; then ok "same-tree: verdict PASS"; else not_ok "same-tree rc=$rc"; cat "$out"; fi
if grep -q 'full-suite: covered by the focused pass on the same tree: bun=2 shell=1 python=0; complement bun=1 shell=0 python=0' "$out"; then ok "same-tree: complement line names bun=1 shell=0"; else not_ok "same-tree: complement line"; grep 'full-suite' "$out"; fi
if grep -q 'VERDICT PASS .* covered_by_focused=3' "$out"; then ok "same-tree: PASS line counts 3 covered"; else not_ok "same-tree: PASS line"; grep VERDICT "$out"; fi
if ! grep -q 'shell suite ran' "$repo.cache/$tree.log"; then ok "same-tree: the covered shell suite did not run"; else not_ok "same-tree: covered shell suite ran"; fi
if python3 -c '
import json, sys
e = json.load(open(sys.argv[1]))["evidence"]
c = e["covered_by_focused"]
assert c["bun"] == ["tests/cli/a.test.ts", "tests/cli/b.test.ts"], c
assert c["shell"] == ["tests/cli/s.test.sh"] and c["py"] == [] and c["ignored"] == [], c
assert e["bun_files"] == 1 and e["shell_suites"] == 0, e
' "$repo.cache/$tree.json"; then ok "same-tree: cached JSON lists the covered set and the complement counts"; else not_ok "same-tree: cached JSON"; fi

# 2. planted: a report for another tree is ignored and everything runs.
step "planted other-tree report"
{ hdr 0000000000000000000000000000000000000000; printf 'tests/cli/a.test.ts\ntests/cli/b.test.ts\ntests/cli/s.test.sh\n'; } >"$report"
run_verdict other --focused-passed "$report"
if [ "$rc" -eq 0 ] && grep -q 'focused-passed report is for tree 0000000000000000000000000000000000000000, not candidate' "$out" && grep -q 'VERDICT PASS .*bun_ran=3 shell=1 python=0 .*covered_by_focused=0' "$out" && grep -q 'shell suite ran' "$repo.cache/$tree.log"; then
	ok "planted other-tree: ignored, all three bun files and the shell suite ran"
else
	not_ok "planted other-tree (rc=$rc)"; cat "$out"
fi

# 3. planted: a complement file that fails fails the verdict even though the report covers the rest.
step "planted failing complement"
{ hdr "$tree"; printf 'tests/cli/a.test.ts\ntests/cli/b.test.ts\ntests/cli/s.test.sh\n'; } >"$report"
FAIL_C=1 run_verdict failc --focused-passed "$report"
FAIL_C=
if [ "$rc" -ne 0 ] && grep -q 'VERDICT FAIL .*bun_fail=1' "$out"; then ok "planted failing complement: verdict FAIL bun_fail=1"; else not_ok "planted failing complement (rc=$rc)"; grep VERDICT "$out"; fi
if grep -q 'FULL-SUITE: failing tests' "$out" && grep -q 'tests/cli/c.test.ts: (fail) c' "$out"; then ok "planted failing complement: the failing test is named in the gate output"; else not_ok "failing test not named"; grep -A3 'failing tests' "$out"; fi

FAIL_C=
# 4. planted: a report naming a file the archive does not enumerate is reported and reduces nothing.
step "planted unknown name"
{ hdr "$tree"; printf 'tests/cli/zzz.test.ts\n'; } >"$report"
run_verdict unknown --focused-passed "$report"
if [ "$rc" -eq 0 ] && grep -q 'focused-passed names tests/cli/zzz.test.ts, not in the declared suite; ignored' "$out" && grep -q 'complement bun=3 shell=1 python=0' "$out"; then
	ok "planted unknown name: reported, full suite ran"
else
	not_ok "planted unknown name (rc=$rc)"; grep 'full-suite' "$out"
fi

# 4b. planted: a report from another judge (different fresh-gate.sh bytes) or runtime is ignored.
step "planted other judge"
{ printf 'tree %s\njudge %s\nruntime %s\n' "$tree" "deadbeef" "$runtime"; printf 'tests/cli/a.test.ts\ntests/cli/b.test.ts\n'; } >"$report"
run_verdict judge --focused-passed "$report"
if [ "$rc" -eq 0 ] && grep -q 'written by judge deadbeef, not this gate' "$out" && grep -q 'VERDICT PASS .*bun_ran=3 .*covered_by_focused=0' "$out"; then ok "planted other judge: ignored, all files ran"; else not_ok "planted other judge (rc=$rc)"; grep -E 'full-suite|VERDICT' "$out"; fi
{ printf 'tree %s\njudge %s\nruntime %s\n' "$tree" "$judge" "Other/arch/bun-0/Python 0"; printf 'tests/cli/a.test.ts\n'; } >"$report"
run_verdict runtime --focused-passed "$report"
if [ "$rc" -eq 0 ] && grep -q 'ran on runtime Other/arch/bun-0/Python 0, not' "$out" && grep -q 'covered_by_focused=0' "$out"; then ok "planted other runtime: ignored"; else not_ok "planted other runtime (rc=$rc)"; grep -E 'full-suite|VERDICT' "$out"; fi

# 5. control: no report at all is the complete suite, no covered line.
step "control without report"
run_verdict none
if [ "$rc" -eq 0 ] && ! grep -q 'covered by the focused pass' "$out" && grep -q 'VERDICT PASS .* covered_by_focused=0' "$out"; then ok "control: complete suite, 0 covered"; else not_ok "control (rc=$rc)"; grep -E 'full-suite|VERDICT' "$out"; fi

printf 'full-suite-complement: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = 0 ]
