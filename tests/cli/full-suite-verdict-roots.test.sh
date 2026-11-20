#!/bin/sh
# shellcheck disable=SC1091
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
# full-suite-verdict-roots.test.sh — CATALOG1 (release catalog omission of extension tests).
# The declared suite spans tests/cli, tests/fleet-guard, extensions and src Bun tests plus the tests/kit-gate
# Python suite. A failing test under any of those roots must fail the verdict; before this the roots were
# never judged, so a regression in extensions/ or src/ could not stop a release.
set -u
FULL_SUITE_JOBS=2
export FULL_SUITE_JOBS

KITROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
VERDICT=${FULL_SUITE_VERDICT_UNDER_TEST:-"$KITROOT_DIR/scripts/full-suite-verdict.sh"}
REPO_TMP="$KITROOT_DIR/var/agent-tmp"
mkdir -p "$REPO_TMP"
# shellcheck source=scripts/kitlib-tmp.sh
. "$KITROOT_DIR/scripts/kitlib-tmp.sh"
KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP full-suite-verdict-roots-test || exit 1

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }
not_ok() { fail=$((fail + 1)); echo "not ok - $1"; }

mkrepo_begin() {
	repo="$TMP/$1"
	rm -rf "$repo" "$repo.cache"
	mkdir -p "$repo/scripts" "$repo/tests/cli"
	cp "$KITROOT_DIR/scripts/kitlib-tmp.sh" "$repo/scripts/kitlib-tmp.sh"
}
addfile() { mkdir -p "$(dirname "$repo/$1")"; printf '%s\n' "$2" >"$repo/$1"; }
mkrepo_commit() {
	git -C "$repo" init -q
	git -C "$repo" config user.name "CATALOG1 test"
	git -C "$repo" config user.email "catalog1@example.invalid"
	git -C "$repo" add -A
	git -C "$repo" commit -q -m "[test] CATALOG1 fixture"
}
run_verdict() {
	out="$TMP/$1.out"
	KITROOT=$KITROOT_DIR OMP_KIT_OMP_SRC_FETCH=0 sh "$VERDICT" --repo "$repo" --commit HEAD --cache-dir "$repo.cache" >"$out" 2>&1
	rc=$?
}

if ! command -v bun >/dev/null 2>&1; then
	echo "bun is required for the catalog roots test; refusing to skip silently" >&2
	exit 1
fi

passing_ts() {
	printf 'import { expect, test } from "bun:test";\ntest("CATALOG1 passing %s", () => { expect(1).toBe(1); });\n' "$1"
}

# (a) Every root is enumerated and a fully passing tree is PASS: two cli files, one extensions file, one src file,
# one tests/kit-gate Python suite. The count line is the catalog the verdict judges.
mkrepo_begin roots-pass
addfile tests/cli/a.test.ts "$(passing_ts cli)"
addfile extensions/ext-a.test.ts "$(passing_ts extensions)"
addfile src/src-a.test.ts "$(passing_ts src)"
addfile src/nested/src-b.test.ts "$(passing_ts nested-src)"
addfile tests/kit-gate/gate_test.py 'print("CATALOG1 kit-gate suite ok")'
mkrepo_commit
run_verdict roots-pass
if [ "$rc" -eq 0 ] && grep -F 'full-suite: bun=4 shell=0 python=1' "$out" >/dev/null && grep -F 'VERDICT PASS' "$out" >/dev/null; then
	ok "cli, extensions, src (nested too) and tests/kit-gate suites are all in the declared catalog and judged"
else
	not_ok "the declared catalog missed a root (rc=$rc)"; cat "$out"
fi

# (b) Planted negatives: a failing test under each new root is a FAIL, never skipped.
for root_file in extensions/ext-fail.test.ts src/src-fail.test.ts; do
	label=$(printf '%s' "$root_file" | tr '/.' '--')
	mkrepo_begin "fail-$label"
	addfile tests/cli/a.test.ts "$(passing_ts cli)"
	addfile "$root_file" 'import { expect, test } from "bun:test";
test("CATALOG1 planted failure", () => { expect(1).toBe(2); });'
	mkrepo_commit
	run_verdict "fail-$label"
	if [ "$rc" -ne 0 ] && grep -F 'VERDICT FAIL' "$out" >/dev/null && grep -F "$root_file" "$out" >/dev/null; then
		ok "a failing $root_file fails the verdict and is named"
	else
		not_ok "a failing $root_file did not fail the verdict (rc=$rc)"; cat "$out"
	fi
done
mkrepo_begin fail-kit-gate
addfile tests/cli/a.test.ts "$(passing_ts cli)"
addfile tests/kit-gate/gate_test.py 'import sys
print("CATALOG1 planted kit-gate failure")
sys.exit(1)'
mkrepo_commit
run_verdict fail-kit-gate
if [ "$rc" -ne 0 ] && grep -F 'VERDICT FAIL' "$out" >/dev/null && grep -F 'tests/kit-gate/gate_test.py' "$out" >/dev/null; then
	ok "a failing tests/kit-gate Python suite fails the verdict and is named"
else
	not_ok "a failing tests/kit-gate suite did not fail the verdict (rc=$rc)"; cat "$out"
fi

# (c) The store's two catalog readers agree with the verdict on the same tree: the recorded declared set equals the
# exact source tree and the exact commit tree.
catalog=$(python3 - "$KITROOT_DIR" "$TMP/roots-pass" <<'PY'
import importlib.util, subprocess, sys
spec = importlib.util.spec_from_file_location("store", sys.argv[1] + "/scripts/full-suite-verdict-store.py")
store = importlib.util.module_from_spec(spec)
spec.loader.exec_module(store)
from pathlib import Path
repo = Path(sys.argv[2])
commit = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
tree = store.declared_suite_files(repo, "main")
git = store.declared_suite_files_from_git(repo, commit, "main")
print("EQUAL" if tree == git else "DIFFERENT", len(tree), sorted(tree)[0])
PY
)
case $catalog in
	"EQUAL 5 extensions/ext-a.test.ts") ok "the store's tree and git catalogs name the same five files" ;;
	*) not_ok "the store catalogs disagree or miss a root: $catalog" ;;
esac

echo "full-suite-verdict-roots: $pass pass $fail fail"
[ "$fail" -eq 0 ]
