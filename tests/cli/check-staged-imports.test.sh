#!/bin/sh
# check-staged-imports.test.sh — SHIFTLEFT1 pre-commit import gate contract
# (ompkit-1wgy). The member is installed by the installer into fixture repos
# and judged through real `git commit` runs: a staged file importing a path
# that is neither staged nor committed is refused; the `--only` temporary
# index is judged, not the full index.
set -u
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"

INSTALLER=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/install-commit-msg-bead.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/staged-imports-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0
check() {
	if [ "$1" = "$2" ] && printf '%s' "$4" | grep -q -- "$5"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: rc=%s want %s out<<<%s>>>\n' "$3" "$1" "$2" "$4"; fi
}

new_repo() {
	dir="$TMP/$1"
	mkdir -p "$dir"
	git -C "$dir" init -q 2>/dev/null
	git -C "$dir" config user.email "test@invalid.example"
	git -C "$dir" config user.name "Test"
	rm -f "$dir/.git/hooks/commit-msg" "$dir/.git/hooks/commit-msg-"* "$dir/.git/hooks/pre-commit"
	git -C "$dir" commit -q --allow-empty --message "[test] root"
	out=$(sh "$INSTALLER" "$dir" 2>&1) || { printf 'FAIL install %s: %s\n' "$1" "$out" >&2; exit 1; }
	[ -x "$dir/.git/hooks/hooks.d/pre-commit/45-omp-kit-staged-imports" ] || { printf 'FAIL install %s: member absent\n' "$1" >&2; exit 1; }
	printf '%s' "$dir"
}

commit() {
	repo=$1
	shift
	(CDPATH='' cd -- "$repo" && git commit -q "$@" 2>&1)
}

# 1. a.ts imports ./b.ts, b.ts untracked: refused, naming the import
R=$(new_repo untracked)
printf 'import { b } from "./b.ts";\nconsole.log(b);\n' > "$R/a.ts"
printf 'export const b = 1;\n' > "$R/b.ts"
git -C "$R" add a.ts
out=$(commit "$R" -m "[test] a without b")
check "$?" "1" "untracked-refused" "$out" "imports missing ./b.ts (from a.ts)"
check "$(git -C "$R" rev-list --count HEAD)" "1" "untracked-head-unmoved" "$out" "staged-imports: REFUSED"

# 2. both staged: passes
git -C "$R" add b.ts
out=$(commit "$R" -m "[test] a with b")
check "$?" "0" "both-staged-pass" "x" "x"

# 3. --only a.ts with b.ts committed earlier: passes
R=$(new_repo only-committed)
printf 'export const b = 1;\n' > "$R/b.ts"
git -C "$R" add b.ts
commit "$R" -m "[test] b first" > /dev/null
printf 'import { b } from "./b.ts";\nconsole.log(b);\n' > "$R/a.ts"
git -C "$R" add a.ts
out=$(commit "$R" --only a.ts -m "[test] a only")
check "$?" "0" "only-committed-pass" "x" "x"

# 4. --only a.ts while b.ts is staged in the full index but only in the
#    worktree for the commit: the --only temporary index lacks b.ts, refused
R=$(new_repo only-worktree)
printf 'import { b } from "./b.ts";\nconsole.log(b);\n' > "$R/a.ts"
printf 'export const b = 1;\n' > "$R/b.ts"
git -C "$R" add a.ts b.ts
out=$(commit "$R" --only a.ts -m "[test] a only, b left behind")
check "$?" "1" "only-worktree-refused" "$out" "imports missing ./b.ts (from a.ts)"

# 5. ../ imports resolve against the importing file's directory
R=$(new_repo parent)
mkdir -p "$R/src/lib" "$R/src/app"
printf 'export const u = 1;\n' > "$R/src/lib/util.ts"
printf 'import { u } from "../lib/util.ts";\nconsole.log(u);\n' > "$R/src/app/main.ts"
git -C "$R" add src
out=$(commit "$R" -m "[test] parent import" -m "[no-changelog] fixture")
check "$?" "0" "parent-valid-pass" "x" "x"
printf 'import { n } from "../lib/nope.ts";\nconsole.log(n);\n' > "$R/src/app/other.ts"
git -C "$R" add src/app/other.ts
out=$(commit "$R" -m "[test] parent import missing" -m "[no-changelog] fixture")
check "$?" "1" "parent-missing-refused" "$out" "imports missing ../lib/nope.ts (from src/app/other.ts)"

printf 'check-staged-imports: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
