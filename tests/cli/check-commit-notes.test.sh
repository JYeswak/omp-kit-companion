#!/bin/sh
# check-commit-notes.test.sh — SHIFTLEFT1 commit-msg notes gate contract
# (ompkit-1wgy). The member is installed by the installer into fixture repos
# and judged through real `git commit` runs: a shipped-path commit needs one
# `Bead:` trailer with a staged or committed changelog.d fragment, or one
# `[no-changelog] <reason>` line, exactly as the push notes gate requires.
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
	git -C "$dir" commit -q --allow-empty --message "[test] root"
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
check "$?" "1" "subject-only-refused" "$out" "commit-notes: REFUSED: this commit touches shipped paths (scripts/a.sh) but has no single 'Bead: <id>' trailer"
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

printf 'check-commit-notes: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
