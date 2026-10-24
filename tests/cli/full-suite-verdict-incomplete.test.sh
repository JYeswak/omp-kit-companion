#!/bin/sh
# shellcheck disable=SC1091
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
# full-suite-verdict-incomplete.test.sh — FULLSUITELOG1 (ompkit-lrbd.6).
# A suite run that ends without complete evidence is non-pass, caches no verdict, and keeps its
# output at the printed <tree>.incomplete.log path. A complete run still records <tree>.log plus
# the <tree>.json verdict.
set -u

KITROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
VERDICT="$KITROOT_DIR/scripts/full-suite-verdict.sh"
REPO_TMP="$KITROOT_DIR/var/agent-tmp"
mkdir -p "$REPO_TMP"
# shellcheck source=scripts/kitlib-tmp.sh
. "$KITROOT_DIR/scripts/kitlib-tmp.sh"
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP full-suite-verdict-incomplete-test || exit 1

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }
not_ok() { fail=$((fail + 1)); echo "not ok - $1"; }

# mkrepo NAME PY_BODY: fixture repo whose candidate commit holds one python suite.
mkrepo() {
	repo="$TMP/$1"
	rm -rf "$repo"
	mkdir -p "$repo/scripts" "$repo/tests/cli"
	cp "$KITROOT_DIR/scripts/kitlib-tmp.sh" "$repo/scripts/kitlib-tmp.sh"
	printf '%s\n' "$2" >"$repo/tests/cli/fixture_test.py"
	git -C "$repo" init -q
	git -C "$repo" config user.name "FULLSUITELOG1 test"
	git -C "$repo" config user.email "fullsuitelog1@example.invalid"
	git -C "$repo" add -A
	git -C "$repo" commit -q -m "[test] FULLSUITELOG1 fixture"
}

run_verdict() {
	out="$TMP/$1.out"
	KITROOT=$KITROOT_DIR OMP_KIT_OMP_SRC_FETCH=0 sh "$VERDICT" --repo "$repo" --commit HEAD --cache-dir "$repo.cache" >"$out" 2>&1
	rc=$?
	tree=$(git -C "$repo" rev-parse 'HEAD^{tree}')
}

# Incomplete: the python suite prints a marker, then SIGKILLs the runner loop that would print
# its GREEN/RED line, so the run never accounts for it.
mkrepo incomplete 'import os, signal
print("FULLSUITELOG1-MARKER before runner death", flush=True)
os.kill(os.getppid(), signal.SIGKILL)'
run_verdict incomplete
cache="$repo.cache"
[ "$rc" -ne 0 ] && ok "incomplete run exits non-pass (rc=$rc)" || not_ok "incomplete run exited 0"
[ ! -e "$cache/$tree.json" ] && ok "incomplete run caches no verdict" || not_ok "incomplete run cached $cache/$tree.json"
[ ! -e "$cache/$tree.log" ] && ok "incomplete run writes no reusable <tree>.log" || not_ok "incomplete run left $cache/$tree.log"
[ ! -e "$cache/$tree.running.log" ] && ok "incomplete run leaves no running log" || not_ok "running log left behind"
inc="$cache/$tree.incomplete.log"
if grep -F "partial log: $inc" "$out" >/dev/null; then ok "RED line prints the incomplete log path"; else not_ok "RED line lacks the incomplete log path"; cat "$out"; fi
if [ -f "$inc" ] && grep -F 'FULLSUITELOG1-MARKER before runner death' "$inc" >/dev/null; then
	ok "incomplete log holds the suite output"
else
	not_ok "incomplete log missing or lacks suite output"
fi

# Control: a complete run records <tree>.log plus the cached verdict.
mkrepo complete 'print("FULLSUITELOG1-CONTROL ok")'
run_verdict complete
cache="$repo.cache"
[ "$rc" -eq 0 ] && ok "complete run passes" || { not_ok "complete run rc=$rc"; cat "$out"; }
[ -f "$cache/$tree.json" ] && grep -F '"verdict": "PASS"' "$cache/$tree.json" >/dev/null && ok "complete run caches PASS verdict" || not_ok "complete run cached no PASS verdict"
grep -F 'FULLSUITELOG1-CONTROL ok' "$cache/$tree.log" >/dev/null 2>&1 && ok "complete run keeps <tree>.log" || not_ok "complete run has no <tree>.log"
[ ! -e "$cache/$tree.incomplete.log" ] && ok "complete run writes no incomplete log" || not_ok "complete run wrote an incomplete log"

echo "full-suite-verdict-incomplete: pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
