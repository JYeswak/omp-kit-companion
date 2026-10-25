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
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
# shellcheck source=scripts/kitlib-tmp.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/kitlib-tmp.sh"
kitlib_tmp TMP stale-worktree-test || exit 1

pass=0
fail=0
check() {
	if [ "$1" = "$2" ] && { [ -z "$5" ] || printf '%s' "$4" | grep -q -- "$5"; }; then pass=$((pass + 1));
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

# 8b. export loss with a FRESH worktree is refused via rule (b): the record
# preservation predicate, not filename-as-authority (native 60087 case).
R=$(new_export_repo export-loss-fresh)
printf '%s\n' '{"id":"t-owner","title":"one"}' '{"id":"t-current","title":"two"}' > "$R/.beads/issues.jsonl"
git -C "$R" add .beads/issues.jsonl
git -C "$R" commit -q --message "[test] serializer export" --message "Bead: t-exporter"
S=$(git -C "$R" rev-parse HEAD)
printf '%s\n' '{"id":"t-current","title":"two"}' > "$R/.beads/issues.jsonl"
git -C "$R" add .beads/issues.jsonl
out=$(git -C "$R" commit --message "[test] export drops t-owner" --message "Bead: t-other" 2>&1)
check "$?" "1" "export-loss-fresh-refused" "$out" "STALE_WORKTREE .beads/issues.jsonl reverts $S"
check "$(git -C "$R" rev-list --count HEAD)" "1" "export-loss-fresh-unmoved" "$out" "STALE_WORKTREE"

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

# 11b. cross-file multiplicity (native 60092): the same line removed in two
# files but re-added once still refuses; consumption is global, not per-path
R=$(new_repo xmulti)
printf 'base line\nlanded line L\n' > "$R/pkg/f.txt"
printf 'other\nlanded line L\n' > "$R/pkg/g.txt"
git -C "$R" add pkg/f.txt pkg/g.txt
git -C "$R" commit -q --message "[test] land L twice" --message "Bead: t-land"
printf 'base line\n' > "$R/pkg/f.txt"
printf 'other\n' > "$R/pkg/g.txt"
printf 'landed line L\n' > "$R/pkg/h.txt"
git -C "$R" add pkg/f.txt pkg/g.txt pkg/h.txt
out=$(git -C "$R" commit --message "[test] drop one L" --message "Bead: t-other" 2>&1)
check "$?" "1" "xmulti-refused" "$out" "STALE_WORKTREE"
check "$(git -C "$R" rev-list --count HEAD)" "2" "xmulti-unmoved" "$out" "STALE_WORKTREE"

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

# 12b. GATEDIAG1: two foreign landings refused in one run print one ready Supersedes block naming both, and that
# block alone admits the rewrite (one edit, never a round per sha).
R=$(new_repo supersede-block)
A1=$(git -C "$R" rev-parse HEAD)
printf 'base line\nlanded line L\nsecond landing M\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
git -C "$R" commit -q --message "[test] land M" --message "Bead: t-land2"
A2=$(git -C "$R" rev-parse HEAD)
printf 'base line\nrewritten both\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
out=$(git -C "$R" commit --message "[test] rewrite L and M" --message "Bead: t-other" 2>&1)
check "$?" "1" "block-refused" "$out" "add this block to the commit message"
block=$(printf '%s\n' "$out" | grep '^Supersedes: ' | sort)
check "$block" "$(printf 'Supersedes: %s\nSupersedes: %s\n' "$A1" "$A2" | sort)" "block-names-both-shas" "$out" ""
out=$(git -C "$R" commit --message "[test] rewrite L and M" --message "Bead: t-other" --message "$block" 2>&1)
check "$?" "0" "block-alone-admits" "$out" ""

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

# 14. several removed lines are judged from ONE blame per path (COMMITPERF1,
# ompkit-xa5s.30: a blame per removed line made one 7-row tracker close take
# 230 s). Removed lines 2, 4 and 5 (ranges 2,2 and 4,5) blame to two commits:
# the own-bead line passes, both foreign lines refuse naming their commit, and
# git blame runs exactly once for the path.
R=$(new_repo blame-once)
A=$(git -C "$R" rev-parse HEAD)
printf 'base line\nlanded line L\nkeep\nother one\nother two\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
git -C "$R" commit -q --message "[test] land others" --message "Bead: t-foreign"
B=$(git -C "$R" rev-parse HEAD)
printf 'base line\nkeep\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
out=$(GIT_TRACE="$TMP/blame-once.trace" git -C "$R" commit --message "[test] multi removal" --message "Bead: t-land" 2>&1)
check "$?" "1" "blame-once-refused" "$out" "STALE_WORKTREE pkg/f.txt reverts $B (\[test\] land others) from bead t-foreign"
check "$(printf '%s\n' "$out" | grep -c "reverts $A")" "0" "blame-once-own-line-not-named" "$out" ""
check "$(grep -c 'built-in: git blame' "$TMP/blame-once.trace")" "1" "blame-once-one-blame" "$out" ""

# 15. a loss-free tracker close with a fresh worktree runs no blame at all
# (ompkit-xa5s.30: closing an old row cost one 32 s blame): rule (b) skips
# the export path and no ancestor is newer than the file, so nothing can refuse.
R=$(new_export_repo export-close-noblame)
printf '%s\n' '{"id":"t-1","title":"one"}' '{"id":"t-2","title":"two"}' > "$R/.beads/issues.jsonl"
git -C "$R" add .beads/issues.jsonl
git -C "$R" commit -q --message "[test] serializer export" --message "Bead: t-exporter"
printf '%s\n' '{"id":"t-1","title":"one","status":"closed"}' '{"id":"t-2","title":"two"}' > "$R/.beads/issues.jsonl"
git -C "$R" add .beads/issues.jsonl
out=$(GIT_TRACE="$TMP/export-close-noblame.trace" git -C "$R" commit --message "[test] close t-1" --message "Bead: t-other" 2>&1)
check "$?" "0" "export-close-noblame-passes" "$out" ""
check "$(grep -c 'built-in: git blame' "$TMP/export-close-noblame.trace")" "0" "export-close-noblame-no-blame" "$out" ""

# 16. the same close on a STALE worktree still blames and refuses via rule (a)
R=$(new_export_repo export-close-stale)
printf '%s\n' '{"id":"t-1","title":"one"}' '{"id":"t-2","title":"two"}' > "$R/.beads/issues.jsonl"
git -C "$R" add .beads/issues.jsonl
git -C "$R" commit -q --message "[test] serializer export" --message "Bead: t-exporter"
S=$(git -C "$R" rev-parse HEAD)
printf '%s\n' '{"id":"t-1","title":"one","status":"closed"}' '{"id":"t-2","title":"two"}' > "$R/.beads/issues.jsonl"
backdate "$R/.beads/issues.jsonl"
git -C "$R" add .beads/issues.jsonl
out=$(git -C "$R" commit --message "[test] close t-1 on a stale file" --message "Bead: t-other" 2>&1)
check "$?" "1" "export-close-stale-refused" "$out" "STALE_WORKTREE .beads/issues.jsonl reverts $S"

# 17. a message with no Bead: trailer and a fresh worktree runs no blame
# (rule (b) needs the message bead; rule (a) cannot fire on a fresh file)
R=$(new_repo beadless-noblame)
printf 'base line\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
out=$(GIT_TRACE="$TMP/beadless-noblame.trace" git -C "$R" commit --message "[test] drop L, no bead trailer" 2>&1)
check "$?" "0" "beadless-noblame-passes" "$out" ""
check "$(grep -c 'built-in: git blame' "$TMP/beadless-noblame.trace")" "0" "beadless-noblame-no-blame" "$out" ""

# 18. the same bead-less removal on a STALE worktree still refuses via rule (a)
R=$(new_repo beadless-stale)
A=$(git -C "$R" rev-parse HEAD)
printf 'base line\n' > "$R/pkg/f.txt"
backdate "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
out=$(git -C "$R" commit --message "[test] drop L on a stale file, no bead trailer" 2>&1)
check "$?" "1" "beadless-stale-refused" "$out" "STALE_WORKTREE pkg/f.txt reverts $A"

# 19. equal subjects are not metadata identity: facts belong to the full SHA.
# The first path's own-bead facts must not admit the second path's foreign removal.
R=$(new_repo facts-sha-identity)
A=$(git -C "$R" rev-parse HEAD)
printf 'peer one\npeer two\n' > "$R/pkg/g.txt"
git -C "$R" add pkg/g.txt
git -C "$R" commit -q --message "[test] land L" --message "Bead: t-peer"
B=$(git -C "$R" rev-parse HEAD)
printf 'base line\n' > "$R/pkg/f.txt"
: > "$R/pkg/g.txt"
git -C "$R" add pkg/f.txt pkg/g.txt
out=$(git -C "$R" commit --message "[test] mixed equal-subject facts" --message "Bead: t-land" 2>&1)
check "$?" "1" "facts-full-sha-identity" "$out" "STALE_WORKTREE pkg/g.txt reverts $B"
check "$(git -C "$R" rev-parse HEAD)" "$B" "facts-refusal-head-unmoved" "$out" "from bead t-peer"

# 20. a successful absent bead is an empty fact, not an unreadable cache entry.
R=$(new_repo facts-empty-bead)
printf 'anonymous one\nanonymous two\n' > "$R/pkg/anonymous.txt"
git -C "$R" add pkg/anonymous.txt
git -C "$R" commit -q --message "[test] anonymous landing"
: > "$R/pkg/anonymous.txt"
git -C "$R" add pkg/anonymous.txt
out=$(git -C "$R" commit --message "[test] anonymous rewrite" --message "Bead: t-other" 2>&1)
check "$?" "0" "facts-successful-empty-bead" "$out" ""

# 21. invocation-private facts cannot inherit an enclosing task's retention.
R=$(new_repo facts-cleanup)
printf 'base line\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
cache_root="$TMP/facts-cleanup-root"
mkdir "$cache_root"
printf '[test] private facts\n\nBead: t-land\n' > "$TMP/facts-cleanup.msg"
out=$(cd "$R" && KITLIB_TMP_ROOT="$cache_root" KITLIB_TMP_AUTO_CLEANUP=0 sh .git/hooks/hooks.d/commit-msg/49-omp-kit-stale-worktree "$TMP/facts-cleanup.msg" 2>&1)
check "$?" "0" "facts-retention-control-passes" "$out" ""
left=""
for entry in "$cache_root"/* "$cache_root"/.[!.]* "$cache_root"/..?*; do
	[ -e "$entry" ] || [ -L "$entry" ] || continue
	left="$entry"
done
check "$left" "" "facts-invocation-cache-disposed" "$out" ""

# 22. unreadable join scratch cannot turn a removed-site judgement into a pass.
R=$(new_repo facts-join-io)
printf 'base line\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
printf '[test] join I/O\n\nBead: t-land\n' > "$TMP/facts-join-io.msg"
member="$R/.git/hooks/hooks.d/commit-msg/49-omp-kit-stale-worktree"
out=$(cd "$R" && sh "$member" "$TMP/facts-join-io.msg" 2>&1)
check "$?" "0" "join-io-passing-control" "$out" ""
# Corrupt the real invocation's join destinations only after move allocation,
# when blame runs. Git still produces the real attribution; no metadata or
# decision is mocked, and the private directory remains kitlib-owned.
join_real_git=$(command -v git)
join_fault_bin="$TMP/join-fault-bin"
join_fault_root="$TMP/join-fault-root"
mkdir "$join_fault_bin" "$join_fault_root"
cat > "$join_fault_bin/git" <<'SH'
#!/bin/sh
if [ "$1" = blame ]; then
	found=0
	for scope in "$GATE_JOIN_ROOT"/stale-worktree-facts.*; do
		[ -d "$scope" ] || continue
		mkdir "$scope/$GATE_JOIN_TARGET" || exit 91
		found=1
	done
	[ "$found" -eq 1 ] || exit 91
fi
exec "$GATE_REAL_GIT" "$@"
SH
chmod +x "$join_fault_bin/git"
for target in removed hit; do
	out=$(cd "$R" && PATH="$join_fault_bin:$PATH" KITLIB_TMP_ROOT="$join_fault_root" GATE_JOIN_ROOT="$join_fault_root" GATE_JOIN_TARGET="$target" GATE_REAL_GIT="$join_real_git" sh "$member" "$TMP/facts-join-io.msg" 2>&1)
	fault_rc=$?
	case "$target" in
		removed) expected="stale-worktree: cannot materialize removed sites" ;;
		hit) expected="stale-worktree: cannot join removed sites" ;;
	esac
	check "$fault_rc" "1" "join-io-$target-refuses" "$out" "$expected"
done

# 23. failed or incomplete Git observations cannot erase a removed-site check.
R=$(new_repo history-errors)
A=$(git -C "$R" rev-parse HEAD)
printf 'base line\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
printf '[test] history control\n\nBead: t-land\n' > "$TMP/history-good.msg"
member="$R/.git/hooks/hooks.d/commit-msg/49-omp-kit-stale-worktree"
out=$(cd "$R" && sh "$member" "$TMP/history-good.msg" 2>&1)
check "$?" "0" "history-readable-passing-control" "$out" ""
real_git=$(command -v git)
fault_bin="$TMP/history-fault-bin"
mkdir "$fault_bin"
cat > "$fault_bin/git" <<'SH'
#!/bin/sh
case "$GATE_GIT_FAULT:$1:${2-}:${3-}" in
	head-fail:rev-parse:-q:--verify) exit 7 ;;
	ref-unavailable:show-ref:--exists:*) exit 129 ;;
	blame-fail:blame:*) exit 7 ;;
	blame-empty:blame:*) exit 0 ;;
	metadata-fail:log:-1:*) exit 7 ;;
	date-invalid:log:-1:--format=%ct) printf 'not-an-epoch\n'; exit 0 ;;
	diff-fail:diff:-U0:*) exit 7 ;;
	ancestor-partial:log:--format=%ct:*) printf '0\n'; exit 7 ;;
esac
exec "$GATE_REAL_GIT" "$@"
SH
chmod +x "$fault_bin/git"
for fault in head-fail blame-fail blame-empty metadata-fail date-invalid diff-fail; do
	out=$(cd "$R" && PATH="$fault_bin:$PATH" GATE_REAL_GIT="$real_git" GATE_GIT_FAULT="$fault" sh "$member" "$TMP/history-good.msg" 2>&1)
	fault_rc=$?
	case "$fault" in
		head-fail) expected="stale-worktree: unreadable HEAD" ;;
		blame-*) expected="stale-worktree: unreadable attribution" ;;
		metadata-fail | date-invalid) expected="UNREADABLE_COMMIT_FACTS" ;;
		diff-fail) expected="stale-worktree: cannot read staged diff" ;;
	esac
	check "$fault_rc" "1" "history-$fault-refuses" "$out" "$expected"
done

# A failed ancestor query's partial stdout is not a complete maximum. Keep
# attribution; a genuine stale removal refuses, while its declared revert passes.
backdate "$R/pkg/f.txt"
printf '[test] stale history\n' > "$TMP/history-stale.msg"
out=$(cd "$R" && PATH="$fault_bin:$PATH" GATE_REAL_GIT="$real_git" GATE_GIT_FAULT=ancestor-partial sh "$member" "$TMP/history-stale.msg" 2>&1)
check "$?" "1" "history-partial-maximum-cannot-skip" "$out" "STALE_WORKTREE pkg/f.txt reverts $A"
printf '[test] declared history\n\nRevert: %s\n' "$A" > "$TMP/history-declared.msg"
out=$(cd "$R" && PATH="$fault_bin:$PATH" GATE_REAL_GIT="$real_git" GATE_GIT_FAULT=ancestor-partial sh "$member" "$TMP/history-declared.msg" 2>&1)
check "$?" "0" "history-partial-maximum-declared-control" "$out" ""

# An actually unborn symbolic branch remains a permitted first commit.
R=$(new_export_repo history-unborn)
out=$(cd "$R" && sh .git/hooks/hooks.d/commit-msg/49-omp-kit-stale-worktree "$TMP/history-good.msg" 2>&1)
check "$?" "0" "history-proven-unborn-control" "$out" ""
out=$(cd "$R" && PATH="$fault_bin:$PATH" GATE_REAL_GIT="$real_git" GATE_GIT_FAULT=ref-unavailable sh .git/hooks/hooks.d/commit-msg/49-omp-kit-stale-worktree "$TMP/history-good.msg" 2>&1)
check "$?" "1" "history-unborn-query-unavailable-refuses" "$out" "stale-worktree: unreadable HEAD"

# An existing malformed branch is not a missing branch, even when quiet
# verification returns the same status used by an actually absent reference.
R=$(new_repo history-malformed-ref)
branch=$(git -C "$R" symbolic-ref HEAD)
printf 'not-an-object-id\n' > "$R/.git/$branch"
out=$(cd "$R" && sh .git/hooks/hooks.d/commit-msg/49-omp-kit-stale-worktree "$TMP/history-good.msg" 2>&1)
check "$?" "1" "history-malformed-ref-refuses" "$out" "stale-worktree: unreadable HEAD"

# 24. Native land --patch commits in a linked worktree: .git is a file,
# while the installed commit-msg chain lives in the shared Git directory.
# Exercise that real hook without a .git-shape bypass. The public compiled
# land publication/isolation smoke is a separate original-acceptance replay.
R=$(new_repo linked-worktree)
A=$(git -C "$R" rev-parse HEAD)
W="$TMP/linked-worktree-candidate"
git -C "$R" worktree add --quiet --detach "$W" HEAD || exit 1
check "$([ -f "$W/.git" ] && printf file)" "file" "linked-git-is-file" "" ""
printf 'base line\nlanded line L\npeer uncommitted bytes\n' > "$R/pkg/f.txt"
printf 'base line\nlanded line L\nselected line\n' > "$W/pkg/f.txt"
out=$(git -C "$W" commit --only --message "[test] linked selected addition" --message "Bead: t-other" -- pkg/f.txt 2>&1)
check "$?" "0" "linked-addition-passes" "$out" ""
check "$(git -C "$W" show HEAD:pkg/f.txt)" "$(printf 'base line\nlanded line L\nselected line')" "linked-only-selected-bytes" "$out" ""
check "$(cat "$R/pkg/f.txt")" "$(printf 'base line\nlanded line L\npeer uncommitted bytes')" "linked-peer-bytes-unchanged" "$out" ""
check "$(git -C "$R" rev-parse HEAD)" "$A" "linked-canonical-head-unmoved" "$out" ""

# A same-bead removal with an old mtime must still refuse through rule (a),
# with the actual landing SHA and actionable guidance, not a scratch error.
B=$(git -C "$W" rev-parse HEAD)
printf 'base line\nselected line\n' > "$W/pkg/f.txt"
backdate "$W/pkg/f.txt"
out=$(git -C "$W" commit --only --message "[test] linked stale removal" --message "Bead: t-land" -- pkg/f.txt 2>&1)
check "$?" "1" "linked-stale-refused" "$out" "STALE_WORKTREE pkg/f.txt reverts $A"
check "$(git -C "$W" rev-parse HEAD)" "$B" "linked-stale-head-unmoved" "$out" "rework on a fresh worktree"

# Freshness alone must not excuse a foreign-bead removal (rule (b)).
touch "$W/pkg/f.txt"
out=$(git -C "$W" commit --only --message "[test] linked foreign removal" --message "Bead: t-other" -- pkg/f.txt 2>&1)
check "$?" "1" "linked-foreign-refused" "$out" "from bead t-land"
check "$(git -C "$W" rev-parse HEAD)" "$B" "linked-foreign-head-unmoved" "$out" "Supersedes:"

# Re-adding the removed text elsewhere remains an allowed move, including
# in a linked worktree; the global moved-text scratch must be usable too.
printf 'landed line L\n' > "$W/pkg/g.txt"
git -C "$W" add pkg/g.txt
out=$(git -C "$W" commit --only --message "[test] linked move" --message "Bead: t-other" -- pkg/f.txt pkg/g.txt 2>&1)
check "$?" "0" "linked-move-passes" "$out" ""
check "$(git -C "$W" show HEAD:pkg/g.txt)" "landed line L" "linked-move-retains-line" "$out" ""

printf 'stale-worktree: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
