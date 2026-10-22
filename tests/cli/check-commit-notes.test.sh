#!/bin/sh
# check-commit-notes.test.sh — SHIFTLEFT1 commit-msg notes gate contract
# (ompkit-1wgy, KITLIB-FRAG ompkit-m21ru). The member is installed by the
# installer into fixture repos and judged through real `git commit` runs: a
# shipped-path commit needs one `Bead:` trailer with a changelog.d fragment
# added or modified since the last release tag (staged or committed), or one
# `[no-changelog] <reason>` line, exactly as release-notes.sh check requires.
set -u
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"

INSTALLER=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/install-commit-msg-bead.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/commit-notes-test.XXXXXX") || exit 1
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
	mkdir -p "$dir/changelog.d"
	: > "$dir/changelog.d/.keep"
	git -C "$dir" add changelog.d/.keep
	git -C "$dir" commit -q --message "[test] root"
	# A released repo: the root is the release floor, so changelog.d/.keep shipped
	# with it and never enters the notes range (release-notes.sh would refuse a
	# non-fragment path added inside the range).
	git -C "$dir" tag v0.0.0
	out=$(sh "$INSTALLER" "$dir" 2>&1) || { printf 'FAIL install %s: %s\n' "$1" "$out" >&2; exit 1; }
	[ -x "$dir/.git/hooks/hooks.d/commit-msg/46-omp-kit-commit-notes" ] || { printf 'FAIL install %s: member absent\n' "$1" >&2; exit 1; }
	mkdir -p "$dir/scripts" "$dir/changelog.d" "$dir/docs"
	printf '%s' "$dir"
}

commit() {
	repo=$1
	shift
	(CDPATH='' cd -- "$repo" && git commit -q "$@" 2>&1)
}

# 1. shipped path, bead id only in the subject: refused, HEAD unmoved
R=$(new_repo subject-only)
printf 'echo a\n' > "$R/scripts/a.sh"
git -C "$R" add scripts/a.sh
out=$(commit "$R" -m "[test] fix a x-1")
check "$?" "1" "subject-only-refused" "$out" "commit-notes: REFUSED: this commit touches shipped paths but must have one Bead: trailer, a \[no-changelog\] reason;"
case "$out" in *"changelog fragment"*) bad=1 ;; *) bad=0 ;; esac
check "$bad" "0" "subject-only-refused-by-trailer-rule-alone" "$out" "commit-notes: REFUSED"
check "$(git -C "$R" rev-list --count HEAD)" "1" "subject-only-head-unmoved" "$out" "commit-notes: REFUSED"

# 2. Bead: trailer with no fragment: refused, naming the expected fragment
out=$(commit "$R" -m "[test] fix a" -m "Bead: x-1")
check "$?" "1" "no-fragment-refused" "$out" "changelog.d/1.md"

# 3. Bead: trailer with a staged changelog.d/1.md: passes
printf '### Fixed\n\n- a\n' > "$R/changelog.d/1.md"
git -C "$R" add changelog.d/1.md
out=$(commit "$R" -m "[test] fix a" -m "Bead: x-1")
check "$?" "0" "trailer-fragment-pass" "x" "x"

# 4. [no-changelog] reason with a shipped path: passes
R=$(new_repo waiver)
printf 'echo a\n' > "$R/scripts/a.sh"
git -C "$R" add scripts/a.sh
out=$(commit "$R" -m "[test] tidy a" -m "[no-changelog] docs only")
check "$?" "0" "no-changelog-pass" "x" "x"

# 5. only non-shipped paths staged, no trailer: passes
printf 'x\n' > "$R/docs/x.md"
git -C "$R" add docs/x.md
out=$(commit "$R" -m "[test] docs x")
check "$?" "0" "non-shipped-pass" "x" "x"

# 6. --only: the shipped path is committed alone and its fragment is in HEAD
R=$(new_repo only-head)
printf '### Fixed\n\n- a\n' > "$R/changelog.d/1.md"
git -C "$R" add changelog.d/1.md
commit "$R" -m "[test] fragment first" > /dev/null
printf 'echo a\n' > "$R/scripts/a.sh"
printf 'echo b\n' > "$R/scripts/b.sh"
git -C "$R" add scripts/a.sh scripts/b.sh
out=$(commit "$R" --only scripts/a.sh -m "[test] fix a" -m "Bead: x-1")
check "$?" "0" "only-head-fragment-pass" "x" "x"
check "$(git -C "$R" diff-tree --no-commit-id --name-only -r HEAD)" "scripts/a.sh" "only-head-committed-alone" "x" "x"

# 7. KITLIB-FRAG (ompkit-m21ru): the member asks release-notes.ts, so a fragment
#    that only shipped at the last release tag does not cover a new commit
#    (00828a5/bcf52aa/33f0c61 passed an existence check and blocked 0.2.65).
#    Both gates judge the same commit the same way.
RELEASE_NOTES=$(dirname -- "$INSTALLER")/release-notes.sh
release_check() { (CDPATH='' cd -- "$1" && sh "$RELEASE_NOTES" check --base-tag v0.1.0 --head HEAD 2>&1); }
R=$(new_repo shipped-only)
printf '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-01\n\n- First release.\n' > "$R/CHANGELOG.md"
printf '### Fixed\n\n- a\n' > "$R/changelog.d/1.md"
git -C "$R" add CHANGELOG.md changelog.d/1.md
commit "$R" -m "[test] release 0.1.0" > /dev/null
git -C "$R" tag v0.1.0
printf 'echo a\n' > "$R/scripts/a.sh"
git -C "$R" add scripts/a.sh
out=$(commit "$R" -m "[test] fix a" -m "Bead: x-1")
check "$?" "1" "shipped-only-fragment-refused" "$out" "commit-notes: REFUSED: this commit (Bead: x-1) has no changelog fragment: changelog.d/1.md"
check "$(git -C "$R" rev-list --count HEAD)" "2" "shipped-only-head-unmoved" "x" "x"
commit "$R" --no-verify -m "[test] fix a" -m "Bead: x-1" > /dev/null
planted=$(git -C "$R" rev-parse --short=7 HEAD)
out=$(release_check "$R")
check "$?" "1" "shipped-only-release-agrees" "$out" "direct commit $planted (Bead: x-1) has no changelog fragment: changelog.d/1.md"
git -C "$R" update-ref HEAD HEAD~1
printf '### Fixed\n\n- a, fixed again\n' > "$R/changelog.d/1.md"
git -C "$R" add changelog.d/1.md
out=$(commit "$R" -m "[test] fix a" -m "Bead: x-1")
check "$?" "0" "staged-fragment-pass" "x" "x"
out=$(release_check "$R")
check "$?" "0" "staged-fragment-release-agrees" "$out" "(Bead: x-1) covered by changelog.d/1.md"
# a fragment added after the tag in an earlier commit covers a later --only commit
printf 'echo b\n' > "$R/scripts/b.sh"
printf 'echo c\n' > "$R/scripts/c.sh"
git -C "$R" add scripts/b.sh scripts/c.sh
out=$(commit "$R" --only scripts/b.sh -m "[test] fix b" -m "Bead: x-1")
check "$?" "0" "since-tag-fragment-only-pass" "x" "x"
out=$(release_check "$R")
check "$?" "0" "since-tag-fragment-release-agrees" "x" "x"
# the installed member finds its resolver beside itself, never in the kit checkout
check "$(cmp -s "$R/.git/hooks/hooks.d/commit-msg/release-notes.ts" "$(dirname -- "$INSTALLER")/release-notes.ts"; echo $?)" "0" "resolver-installed-beside-member" "x" "x"
rm -f "$R/.git/hooks/hooks.d/commit-msg/release-notes.ts"
out=$(commit "$R" --only scripts/c.sh -m "[test] fix c" -m "Bead: x-1")
check "$?" "1" "resolver-missing-refused" "$out" "commit-notes: REFUSED: installed resolver release-notes.ts missing beside"

# 8. a repo with no changelog.d (jev, localbench, uds ...) never runs the notes gate: passes
N="$TMP/no-fragments"
mkdir -p "$N/scripts"
git -C "$N" init -q 2>/dev/null
git -C "$N" config user.email "test@invalid.example"
git -C "$N" config user.name "Test"
rm -f "$N/.git/hooks/commit-msg" "$N/.git/hooks/commit-msg-"* "$N/.git/hooks/pre-commit"
git -C "$N" commit -q --allow-empty --message "[test] root"
sh "$INSTALLER" "$N" > /dev/null 2>&1 || { printf 'FAIL install no-fragments\n' >&2; exit 1; }
printf 'echo a\n' > "$N/scripts/a.sh"
git -C "$N" add scripts/a.sh
out=$(commit "$N" -m "[test] fix a x-1")
check "$?" "0" "no-changelog-dir-pass" "x" "x"

printf 'check-commit-notes: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
