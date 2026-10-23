#!/bin/sh
# check-staged-fragments.test.sh — SHIFTLEFT1 pre-commit fragment gate
# contract (ompkit-1wgy). The member is installed by the installer into
# fixture repos carrying the real release-notes validator and judged through
# real `git commit` runs: a staged fragment that `release-notes.sh fold`
# refuses is refused at commit time; a repo without the validator passes.
set -u
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"

SCRIPTS=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)
INSTALLER=$SCRIPTS/install-commit-msg-bead.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
if ! printenv TMPDIR >/dev/null; then KITLIB_TMP_ROOT=$REPO_TMP; fi
# shellcheck source=scripts/kitlib-tmp.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/kitlib-tmp.sh"
kitlib_tmp TMP staged-fragments-test || exit 1

pass=0
fail=0
check() {
	if [ "$1" = "$2" ] && printf '%s' "$4" | grep -q -- "$5"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: rc=%s want %s out<<<%s>>>\n' "$3" "$1" "$2" "$4"; fi
}

# new_repo NAME [validator]: a fixture repo with a minimal valid CHANGELOG.md
# (fold needs exactly one `## [Unreleased]` heading) and, when asked, the real
# release-notes.sh/.ts committed under scripts/.
new_repo() {
	dir="$TMP/$1"
	mkdir -p "$dir"
	git -C "$dir" init -q 2>/dev/null
	git -C "$dir" config user.email "test@invalid.example"
	git -C "$dir" config user.name "Test"
	rm -f "$dir/.git/hooks/commit-msg" "$dir/.git/hooks/commit-msg-"* "$dir/.git/hooks/pre-commit"
	printf '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n### Added\n\n- First release.\n' > "$dir/CHANGELOG.md"
	if [ "${2:-}" = validator ]; then
		mkdir -p "$dir/scripts"
		cp "$SCRIPTS/release-notes.sh" "$SCRIPTS/release-notes.ts" "$dir/scripts/"
	fi
	git -C "$dir" add -A
	git -C "$dir" commit -q --message "[test] root" --message "[no-changelog] fixture"
	out=$(sh "$INSTALLER" "$dir" 2>&1) || { printf 'FAIL install %s: %s\n' "$1" "$out" >&2; exit 1; }
	[ -x "$dir/.git/hooks/hooks.d/pre-commit/47-omp-kit-staged-fragments" ] || { printf 'FAIL install %s: member absent\n' "$1" >&2; exit 1; }
	printf '%s' "$dir"
}

commit() {
	repo=$1
	shift
	(CDPATH='' cd -- "$repo" && git commit -q "$@" 2>&1)
}

# 1. unknown category: refused, naming the validator's reason; HEAD unmoved
R=$(new_repo unknown validator)
mkdir -p "$R/changelog.d"
printf '### Security\n\n- Hardened widgets.\n' > "$R/changelog.d/bad.md"
git -C "$R" add changelog.d/bad.md
out=$(commit "$R" -m "[test] unknown category")
check "$?" "1" "unknown-category-refused" "$out" 'unknown category "Security"'
check "$(git -C "$R" rev-list --count HEAD)" "1" "unknown-category-head-unmoved" "$out" "staged-fragments: REFUSED: staged changelog fragments are not promotable"

# 2. two category headers: refused
printf '### Fixed\n\n- One.\n\n### Added\n\n- Two.\n' > "$R/changelog.d/bad.md"
git -C "$R" add changelog.d/bad.md
out=$(commit "$R" -m "[test] two categories")
check "$?" "1" "two-categories-refused" "$out" 'only one optional leading "### Category" line is allowed'

# 3. a valid Fixed fragment: passes
printf '### Fixed\n\n- Widgets no longer wobble.\n' > "$R/changelog.d/bad.md"
git -C "$R" add changelog.d/bad.md
out=$(commit "$R" -m "[test] valid fragment")
check "$?" "0" "valid-fragment-pass" "x" "x"

# 4. no validator in the repo: any fragment passes
R=$(new_repo novalidator)
mkdir -p "$R/changelog.d"
printf '### Security\n\n- One.\n\n### Added\n\n- Two.\n' > "$R/changelog.d/bad.md"
git -C "$R" add changelog.d/bad.md
out=$(commit "$R" -m "[test] no validator")
check "$?" "0" "no-validator-pass" "x" "x"

# 5. a commit from a linked worktree (git exports GIT_DIR=<repo>/.git/worktrees/<name> to hooks; `omp-kit
# land --patch` commits this way): the member still judges the fragment, and the repository stays non-bare
# (ompkit-xa5s.41: its validation `git init` under that GIT_DIR flipped the companion to core.bare=true).
R=$(new_repo worktree validator)
W="$TMP/worktree-wt"
git -C "$R" worktree add -q --detach "$W" HEAD
mkdir -p "$W/changelog.d"
printf '### Security\n\n- Hardened widgets.\n' > "$W/changelog.d/bad.md"
git -C "$W" add changelog.d/bad.md
out=$(commit "$W" -m "[test] worktree unknown category")
check "$?" "1" "worktree-unknown-category-refused" "$out" 'unknown category "Security"'
printf '### Fixed\n\n- Widgets no longer wobble.\n' > "$W/changelog.d/bad.md"
git -C "$W" add changelog.d/bad.md
out=$(commit "$W" -m "[test] worktree valid fragment")
# Only this member is judged: other chain members may refuse a worktree commit for their own reasons.
check "$(printf '%s' "$out" | grep -c 'staged-fragments:')" "0" "worktree-valid-fragment-member-passes" "x" "x"
check "$(git -C "$R" config --get core.bare)" "false" "worktree-commit-keeps-repo-non-bare" "x" "x"

printf 'check-staged-fragments: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
