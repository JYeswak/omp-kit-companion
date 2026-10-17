#!/bin/sh
# stale-worktree.test.sh — STALEWT1 commit-msg stale-revert gate contract
# (ompkit-fp72.120.10). The member is installed by the installer into fixture
# repos and judged through real `git commit` runs, including `commit --only`:
# a commit that would revert lines landed in HEAD is refused naming the
# commit, unless the revert is declared with a `Revert: <sha>` trailer.
set -u
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"

INSTALLER=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/install-commit-msg-bead.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/stale-worktree-test.XXXXXX") || exit 1
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
	mkdir -p "$dir/pkg"
	printf 'base line\nlanded line L\n' > "$dir/pkg/f.txt"
	git -C "$dir" add pkg/f.txt
	git -C "$dir" commit -q --message "[test] land L" --message "Bead: t-land"
	out=$(sh "$INSTALLER" "$dir" 2>&1) || { printf 'FAIL install %s: %s\n' "$1" "$out" >&2; exit 1; }
	[ -x "$dir/.git/hooks/hooks.d/commit-msg/49-omp-kit-stale-worktree" ] || { printf 'FAIL install %s: member absent\n' "$1" >&2; exit 1; }
	printf '%s' "$dir"
}

backdate() {
	# Portable old mtime (predates every test commit).
	touch -t 202001010000 "$1"
}

# 1. stale worktree removal via `commit --only`: refused naming the landing sha
R=$(new_repo stale-only)
A=$(git -C "$R" rev-parse HEAD)
printf 'base line\n' > "$R/pkg/f.txt"
backdate "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
out=$(git -C "$R" commit --only --message "[test] stale attempt" --message "Bead: t-other" -- pkg/f.txt 2>&1)
check "$?" "1" "stale-only-refused" "$out" "STALE_WORKTREE pkg/f.txt reverts $A"
check "$(git -C "$R" rev-list --count HEAD)" "1" "stale-only-head-unmoved" "$out" "STALE_WORKTREE"

# 2. same case with a declared `Revert:` trailer: allowed and logged
out=$(git -C "$R" commit --only --message "[test] declared revert" --message "Bead: t-other" --message "Revert: $A" -- pkg/f.txt 2>&1)
check "$?" "0" "declared-revert-allowed" "$out" ""
check "$(git -C "$R" rev-list --count HEAD)" "2" "declared-revert-landed" "$out" ""
check "$(git -C "$R" log -1 --format=%B HEAD | grep -c "Revert: $A")" "1" "declared-revert-logged" "$out" ""

# 3. author's own new lines (pure addition, stale mtime): passes
R=$(new_repo own-lines)
printf 'base line\nlanded line L\nown line\n' > "$R/pkg/f.txt"
backdate "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
out=$(git -C "$R" commit --message "[test] own lines" --message "Bead: t-other" 2>&1)
check "$?" "0" "own-lines-pass" "$out" ""

# 4. same-bead rework removing the landed line with a fresh mtime: passes
R=$(new_repo same-bead)
printf 'base line\nreworked line\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
out=$(git -C "$R" commit --message "[test] same bead rework" --message "Bead: t-land" 2>&1)
check "$?" "0" "same-bead-pass" "$out" ""

# 5. mixed: fresh own hunk plus a foreign removal: refused, hunk survives
R=$(new_repo mixed)
printf 'base line\nown fresh hunk\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
out=$(git -C "$R" commit --message "[test] mixed" --message "Bead: t-other" 2>&1)
check "$?" "1" "mixed-refused" "$out" "from bead t-land"
check "$(git -C "$R" rev-list --count HEAD)" "1" "mixed-head-unmoved" "$out" "STALE_WORKTREE"
check "$(grep -c "own fresh hunk" "$R/pkg/f.txt")" "1" "mixed-hunk-survives" "$out" "STALE_WORKTREE"

# 6. e2e through the public save path with a peer's uncommitted hunk present:
# the peer's bytes stay byte-identical and the save succeeds when clean
R=$(new_repo peer-hunk)
printf 'peer bytes\n' > "$R/pkg/peer.txt"
printf 'base line\nlanded line L\nown line\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
out=$(git -C "$R" commit --message "[test] clean save beside peer hunk" --message "Bead: t-other" 2>&1)
check "$?" "0" "peer-save-passes" "$out" ""
check "$(cat "$R/pkg/peer.txt")" "peer bytes" "peer-bytes-identical" "$out" ""
check "$(git -C "$R" status --porcelain -- pkg/peer.txt)" "?? pkg/peer.txt" "peer-still-untracked" "$out" ""

# 7. native export regeneration: a serializer commit writes rows for two
# issues; regenerating (reordered + reworded, no issue lost) under another
# bead passes. Fails today: rule (b) blames the serializer's bead.
new_export_repo() {
	dir="$TMP/$1"
	mkdir -p "$dir/.beads"
	git -C "$dir" init -q 2>/dev/null
	git -C "$dir" config user.email "test@invalid.example"
	git -C "$dir" config user.name "Test"
	rm -f "$dir/.git/hooks/commit-msg" "$dir/.git/hooks/commit-msg-"* "$dir/.git/hooks/pre-commit"
	out=$(sh "$INSTALLER" "$dir" 2>&1) || { printf 'FAIL install %s: %s\n' "$1" "$out" >&2; exit 1; }
	printf '%s' "$dir"
}
R=$(new_export_repo export-regen)
printf '%s\n' '{"id":"t-1","title":"one"}' '{"id":"t-2","title":"two"}' > "$R/.beads/issues.jsonl"
git -C "$R" add .beads/issues.jsonl
git -C "$R" commit -q --message "[test] serializer export" --message "Bead: t-exporter"
S=$(git -C "$R" rev-parse HEAD)
printf '%s\n' '{"id":"t-2","title":"two reworded"}' '{"id":"t-1","title":"one"}' > "$R/.beads/issues.jsonl"
git -C "$R" add .beads/issues.jsonl
out=$(git -C "$R" commit --message "[test] export regen" --message "Bead: t-other" 2>&1)
check "$?" "0" "export-regen-passes" "$out" ""
check "$(git -C "$R" rev-list --count HEAD)" "2" "export-regen-landed" "$out" ""

# 8. export loss with a STALE worktree is still refused via rule (a), even
# though the path is outside rule (b): backdated file, dropped row.
R=$(new_export_repo export-loss-stale)
printf '%s\n' '{"id":"t-1","title":"one"}' '{"id":"t-2","title":"two"}' > "$R/.beads/issues.jsonl"
git -C "$R" add .beads/issues.jsonl
git -C "$R" commit -q --message "[test] serializer export" --message "Bead: t-exporter"
S=$(git -C "$R" rev-parse HEAD)
printf '%s\n' '{"id":"t-1","title":"one"}' > "$R/.beads/issues.jsonl"
backdate "$R/.beads/issues.jsonl"
git -C "$R" add .beads/issues.jsonl
out=$(git -C "$R" commit --message "[test] export drops t-2 on stale file" --message "Bead: t-other" 2>&1)
check "$?" "1" "export-loss-stale-refused" "$out" "STALE_WORKTREE .beads/issues.jsonl reverts $S"
check "$(git -C "$R" rev-list --count HEAD)" "1" "export-loss-stale-unmoved" "$out" "STALE_WORKTREE"

# 9. in-file reorder of foreign-bead lines passes (move, not revert)
R=$(new_repo reorder)
A=$(git -C "$R" rev-parse HEAD)
printf 'base line\nsecond\nlanded line L\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
git -C "$R" commit -q --message "[test] land two lines" --message "Bead: t-land"
printf 'base line\nlanded line L\nsecond\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
out=$(git -C "$R" commit --message "[test] reorder" --message "Bead: t-other" 2>&1)
check "$?" "0" "reorder-passes" "$out" ""
check "$(git -C "$R" rev-list --count HEAD)" "3" "reorder-landed" "$out" ""

# 10. cross-file move of a foreign-bead line passes
R=$(new_repo xmove)
printf 'base line\nlanded line L\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
git -C "$R" commit -q --message "[test] land L" --message "Bead: t-land"
printf 'base line\n' > "$R/pkg/f.txt"
printf 'landed line L\n' > "$R/pkg/g.txt"
git -C "$R" add pkg/f.txt pkg/g.txt
out=$(git -C "$R" commit --message "[test] extract L" --message "Bead: t-other" 2>&1)
check "$?" "0" "xmove-passes" "$out" ""

# 11. removing a text twice while re-adding it once (cross-file) is judged:
# one removal stays uncancelled and still refuses
R=$(new_repo overremove)
printf 'same\nsame\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
git -C "$R" commit -q --message "[test] land dup" --message "Bead: t-land"
printf '' > "$R/pkg/f.txt"
printf 'same\n' > "$R/pkg/g.txt"
git -C "$R" add pkg/f.txt pkg/g.txt
out=$(git -C "$R" commit --message "[test] drop one same" --message "Bead: t-other" 2>&1)
check "$?" "1" "overremove-refused" "$out" "STALE_WORKTREE pkg/f.txt reverts"
check "$(git -C "$R" rev-list --count HEAD)" "2" "overremove-unmoved" "$out" "STALE_WORKTREE"

# 12. a Supersedes trailer declares a foreign rewrite truthfully
R=$(new_repo supersede)
printf 'base line\nlanded line L\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
git -C "$R" commit -q --message "[test] land L" --message "Bead: t-land"
A=$(git -C "$R" rev-parse HEAD)
printf 'base line\nrewritten line\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
out=$(git -C "$R" commit --message "[test] rewrite L" --message "Bead: t-other" --message "Supersedes: $A" 2>&1)
check "$?" "0" "supersede-passes" "$out" ""
check "$(git -C "$R" log -1 --format=%B HEAD | grep -c "Supersedes: $A")" "1" "supersede-logged" "$out" ""

# 13. bad control: stale mtime deletion re-added elsewhere still refuses via (a)
R=$(new_repo badcontrol)
printf 'base line\nlanded line L\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
git -C "$R" commit -q --message "[test] land L" --message "Bead: t-land"
A=$(git -C "$R" rev-parse HEAD)
printf 'base line\n' > "$R/pkg/f.txt"
printf 'landed line L\n' > "$R/pkg/g.txt"
backdate "$R/pkg/f.txt"
backdate "$R/pkg/g.txt"
git -C "$R" add pkg/f.txt pkg/g.txt
out=$(git -C "$R" commit --message "[test] stale move" --message "Bead: t-other" 2>&1)
check "$?" "1" "badcontrol-refused" "$out" "STALE_WORKTREE pkg/f.txt reverts $A"
check "$(git -C "$R" rev-list --count HEAD)" "1" "badcontrol-unmoved" "$out" "STALE_WORKTREE"

printf 'stale-worktree: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
