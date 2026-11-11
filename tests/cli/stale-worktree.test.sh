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
# Installer probes use an intentionally unresolvable bead, never the live
# tracker. The stale-worktree member itself derives attribution from Git.
BR_BIN=/usr/bin/false
export BR_BIN


pass=0
fail=0
check() {
	if [ "$1" = "$2" ] && { [ -z "$5" ] || printf '%s' "$4" | grep -q -- "$5"; }; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: rc=%s want %s out<<<%s>>>\n' "$3" "$1" "$2" "$4"; fi
}

# RELEASE15 (ompkit-fp72.120.16.98): the fixture templates keep only the member under test. Each fixture commit
# otherwise ran the whole installed chain (11 pre-commit members ~4 s, 7 other commit-msg members ~1 s, and the
# reference-transaction member ~1 s per ref update), so ~47 commits cost 6.5 min, the slowest file in the full suite.
# Every commit still goes through the real installed runner and member 49; the other members have their own suites.
only_stale_member() {
	for member in "$1"/.git/hooks/hooks.d/*/*; do
		[ -f "$member" ] || continue
		case "$member" in
			*/commit-msg/49-omp-kit-stale-worktree | */commit-msg/kitlib-tmp.sh | \
			*/commit-msg/gate-event.sh | */commit-msg/kitlib_jsonl.py | */commit-msg/kitlib_lock.py) ;;
			*) rm -f "$member" ;;
		esac
	done
	# The pre-commit, pre-push and reference-transaction runners have no member left; drop them so a commit does not
	# spawn them (reference-transaction fires 3-5 times per commit). The commit-msg runner stays: it is under test.
	rm -f "$1/.git/hooks/pre-commit" "$1/.git/hooks/pre-push" "$1/.git/hooks/reference-transaction"
	git -C "$1" config maintenance.auto false
}
seeded_template="$TMP/.stale-worktree-seeded-template"
new_repo() {
	dir="$TMP/$1"
	if [ ! -x "$seeded_template/.git/hooks/hooks.d/commit-msg/49-omp-kit-stale-worktree" ]; then
		mkdir -p "$seeded_template/pkg"
		git -C "$seeded_template" init -q --template= 2>/dev/null
		git -C "$seeded_template" config user.email "test@invalid.example"
		git -C "$seeded_template" config user.name "Test"
		rm -f "$seeded_template/.git/hooks/commit-msg" "$seeded_template/.git/hooks/commit-msg-"* "$seeded_template/.git/hooks/pre-commit"
		printf 'base line\nlanded line L\n' > "$seeded_template/pkg/f.txt"
		git -C "$seeded_template" add pkg/f.txt
		git -C "$seeded_template" commit -q --message "[test] land L" --message "Bead: t-land"
		out=$(sh "$INSTALLER" "$seeded_template" 2>&1) || { printf 'FAIL install %s: %s\n' "$1" "$out" >&2; exit 1; }
		only_stale_member "$seeded_template"
	fi
	mkdir -p "$dir"
	cp -Rp "$seeded_template/." "$dir/" || { printf 'FAIL copy %s from template\n' "$1" >&2; exit 1; }
	[ -x "$dir/.git/hooks/hooks.d/commit-msg/49-omp-kit-stale-worktree" ] || { printf 'FAIL copy %s: member absent\n' "$1" >&2; exit 1; }
	printf '%s' "$dir"
}


backdate() {
	# Portable old mtime (predates every test commit).
	touch -t 202001010000 "$1"
}

# STALELOCK1 (ompkit-fp72.120.16.229): the member reaps its own commit's
# orphan index.lock only when that git is dead, no process holds the lock,
# and no live git works in the tree. `-t STALELOCK1` runs only this block.
# shellcheck source=scripts/kitlib-proc.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/kitlib-proc.sh"
MEMBER=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/check-stale-worktree.sh
stalelock_repo() {
	d="$TMP/$1"; mkdir -p "$d"
	git -C "$d" init -q --template= 2>/dev/null
	git -C "$d" config user.email "test@invalid.example"; git -C "$d" config user.name "Test"
	printf 'x\n' > "$d/f"; git -C "$d" add f; git -C "$d" commit -q -m "[test] base" -m "Bead: t-lock"
	printf '%s' "$d"
}
dead_pid() { sh -c 'exit 0' & p=$!; wait "$p"; printf '%s' "$p"; }
# Lock holders are owned children: each execs down to one process (no orphanable grandchild), runs from
# $TMP so a leak is visible by cwd, and is reaped on every exit path (kitlib_tmp_atexit) as well as at the
# end of this section. STALELOCK2: a `sh -c '...; sleep 60'` holder signalled by its sh pid left the sleep
# orphaned (ppid 1) with cwd in the scratch, so `omp-kit scratch release` read SCRATCH_RELEASE_HELD.
stalelock_holders=""
stalelock_hold() {
	(cd "$TMP" && exec sh -c 'exec 3< "$1"; exec sleep 60' sh "$1") & holder=$!
	stalelock_holders="$stalelock_holders $holder"
}
stalelock_reap_pid() {
	kitlib_signal TERM "$1" 2>/dev/null
	n=0; while kitlib_signal 0 "$1" 2>/dev/null && [ "$n" -lt 20 ]; do n=$((n + 1)); sleep 0.1; done
	kitlib_signal KILL "$1" 2>/dev/null
	wait "$1" 2>/dev/null
	return 0
}
stalelock_reap_holders() {
	for p in $stalelock_holders; do stalelock_reap_pid "$p"; done
	stalelock_holders=""
}
kitlib_tmp_atexit stalelock_reap_holders
# Pids of every process whose cwd is $TMP or below (bounded: lsof -S 5 stat timeout). Fails closed on lsof error.
stalelock_cwd_survivors() {
	listing=$(lsof -S 5 -d cwd -Fpn) || { printf 'LSOF_FAILED\n'; return 0; }
	printf '%s\n' "$listing" | awk -v t="$TMP" -v self="$$" \
		'/^p/ { p = substr($0, 2) } /^n/ { d = substr($0, 2); if (p != self && (d == t || index(d, t "/") == 1)) print p }'
}
L=$(stalelock_repo lock-orphan)
printf 'index bytes of a killed commit\n' > "$L/.git/index.lock"; backdate "$L/.git/index.lock"
out=$(cd "$L" && HOME="$TMP/lockhome" sh "$MEMBER" --reap-orphan-lock "$(dead_pid)" 2>&1)
check "$?" "0" "STALELOCK1-orphan-rc" "$out" "STALELOCK1 reaped orphan index lock $L/.git/index.lock"
check "$([ -e "$L/.git/index.lock" ] || printf gone)" "gone" "STALELOCK1-orphan-cleared" "$out" "no lsof holder"
moved_n=0; for f in "$L"/.git/index.lock.stale-*; do [ -e "$f" ] && moved_n=$((moved_n + 1)); done
check "$moved_n" "1" "STALELOCK1-orphan-moved-aside" "$out" ""
check "$(grep -c '"by":"STALELOCK1"' "$TMP/lockhome/.local/state/omp-kit/index-lock-ledger.jsonl")" "1" "STALELOCK1-ledger-row" "$out" ""
out=$(git -C "$L" commit -q --allow-empty -m "[test] after reap" -m "Bead: t-lock" 2>&1)
check "$?" "0" "STALELOCK1-commit-after-reap" "$out" ""

# A lock held open by a live fixture process is left alone, and git still refuses as today.
H=$(stalelock_repo lock-held)
printf 'held\n' > "$H/.git/index.lock"; backdate "$H/.git/index.lock"
stalelock_hold "$H/.git/index.lock"
n=0; until lsof -- "$H/.git/index.lock" > /dev/null 2>&1 || [ "$n" -ge 50 ]; do n=$((n + 1)); sleep 0.1; done
out=$(cd "$H" && HOME="$TMP/lockhome" sh "$MEMBER" --reap-orphan-lock "$(dead_pid)" 2>&1)
check "$?" "0" "STALELOCK1-held-rc" "$out" ""
check "$(cat "$H/.git/index.lock")" "held" "STALELOCK1-held-kept" "$out" ""
out=$(git -C "$H" commit -q --allow-empty -m "[test] blocked" -m "Bead: t-lock" 2>&1)
check "$?" "128" "STALELOCK1-held-git-refuses" "$out" "index.lock"
# Mutant: clearing unconditionally removes the live lock (the gates are load-bearing).
# shellcheck disable=SC2016 # literal shell text for the mutant
sed 's/^	\[ -n "\$(find "\$lf" -newer.*$/	mv -- "$lf" "$lf.mutant"; return 0/' "$MEMBER" > "$TMP/stalelock-mutant.sh"
grep -q 'lf.mutant' "$TMP/stalelock-mutant.sh"
check "$?" "0" "STALELOCK1-mutant-planted" "" ""
out=$(cd "$H" && HOME="$TMP/lockhome" sh "$TMP/stalelock-mutant.sh" --reap-orphan-lock "$(dead_pid)" 2>&1)
check "$([ -e "$H/.git/index.lock" ] || printf removed)" "removed" "STALELOCK1-mutant-removes-live-lock" "$out" ""
# Planted: after the cases run, no process whose cwd is this test's scratch survives.
stalelock_reap_holders
survivors=$(stalelock_cwd_survivors)
check "$survivors" "" "STALELOCK1-no-holder-survives" "" ""
# Mutant (no reap): an owned holder left running is caught by the same check.
stalelock_hold "$H/f"
n=0; until [ -n "$(stalelock_cwd_survivors)" ] || [ "$n" -ge 50 ]; do n=$((n + 1)); sleep 0.1; done
check "$(stalelock_cwd_survivors | grep -cx "$holder")" "1" "STALELOCK1-mutant-unreaped-holder-detected" "" ""
stalelock_reap_holders
# Mutant (the leaked shape): signalling the holder's sh orphans its sleep, which the check catches.
(cd "$TMP" && exec sh -c 'exec 3< "$1"; sleep 60' sh "$H/f") & leaky=$!
n=0; until [ "$(stalelock_cwd_survivors | wc -l | tr -d ' ')" -ge 2 ] || [ "$n" -ge 50 ]; do n=$((n + 1)); sleep 0.1; done
stalelock_reap_pid "$leaky"
orphans=$(stalelock_cwd_survivors)
check "$([ -n "$orphans" ] && printf leaked)" "leaked" "STALELOCK1-mutant-sh-holder-orphans-sleep" "$orphans" ""
for p in $orphans; do stalelock_reap_pid "$p"; done
check "$(stalelock_cwd_survivors)" "" "STALELOCK1-mutant-orphans-reaped" "" ""
if [ "${1:-}" = -t ] && [ "${2:-}" = STALELOCK1 ]; then
	printf 'stale-worktree: %s pass %s fail\n' "$pass" "$fail"
	[ "$fail" -eq 0 ]; exit
fi

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
export_template="$TMP/.stale-worktree-export-template"
new_export_repo() {
	dir="$TMP/$1"
	if [ ! -x "$export_template/.git/hooks/hooks.d/commit-msg/49-omp-kit-stale-worktree" ]; then
		mkdir -p "$export_template/.beads"
		git -C "$export_template" init -q --template= 2>/dev/null
		git -C "$export_template" config user.email "test@invalid.example"
		git -C "$export_template" config user.name "Test"
		rm -f "$export_template/.git/hooks/commit-msg" "$export_template/.git/hooks/commit-msg-"* "$export_template/.git/hooks/pre-commit"
		out=$(sh "$INSTALLER" "$export_template" 2>&1) || { printf 'FAIL install %s: %s\n' "$1" "$out" >&2; exit 1; }
		only_stale_member "$export_template"
	fi
	mkdir -p "$dir"
	cp -Rp "$export_template/." "$dir/" || { printf 'FAIL copy %s from template\n' "$1" >&2; exit 1; }
	[ -x "$dir/.git/hooks/hooks.d/commit-msg/49-omp-kit-stale-worktree" ] || { printf 'FAIL copy %s: member absent\n' "$1" >&2; exit 1; }
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

# 25. STALEEXACT1 R2: an ordinary edit of a peer's line is exempt only by
# provenance. No trailer refuses exactly as before (naming the peer, with
# both ways out printed); a base that already contains the peer commit
# admits it with no Supersedes; a base from before the peer commit, an
# unknown or unparseable sha, a base off HEAD's history, or two different
# bases refuse.
R=$(new_repo stalexact-r2)
cp "$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/kitlib-tmp.sh" "$TMP/kitlib-tmp.sh"
S0=$(git -C "$R" rev-parse HEAD)
printf 'base line\npeer wording\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
git -C "$R" commit -q --message "[test] peer wording" --message "Bead: t-peer" --message "Supersedes: $S0"
P=$(git -C "$R" rev-parse HEAD)
S=$(git -C "$R" rev-parse HEAD~1)
printf 'base line\nbrand new\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
out=$(git -C "$R" commit --message "[test] ordinary edit" --message "Bead: t-other" 2>&1)
check "$?" "1" "STALEEXACT1-r2-no-trailer-refused" "$out" "STALE_WORKTREE pkg/f.txt reverts $P"
check "$(git -C "$R" rev-list --count HEAD)" "2" "STALEEXACT1-r2-no-trailer-unmoved" "$out" "from bead t-peer"
check "$(printf '%s\n' "$out" | grep -c "Authored-On: <sha of the commit your checkout was at when you made the edit>")" "1" "STALEEXACT1-r2-remedy-names-requirement" "$out" ""
check "$(printf '%s\n' "$out" | grep -c "omp-kit land --patch FILE --base <sha> proves the base")" "1" "STALEEXACT1-r2-remedy-names-proof" "$out" ""
out=$(git -C "$R" commit --message "Authored-On: $P do it" --message "Bead: t-other" 2>&1)
check "$?" "1" "STALEEXACT1-r2-subject-mention-ignored" "$out" "STALE_WORKTREE pkg/f.txt reverts $P"
check "$(printf '%s\n' "$out" | grep -c "Authored-On: <sha of the commit")" "1" "STALEEXACT1-r2-subject-still-remedies" "$out" ""
out=$(git -C "$R" commit --message "[test] ordinary edit" --message "Mentions Authored-On: $P in passing." --message "Bead: t-other" 2>&1)
check "$?" "1" "STALEEXACT1-r2-midbody-mention-ignored" "$out" "STALE_WORKTREE pkg/f.txt reverts $P"
out=$(git -C "$R" commit --message "[test] ordinary edit" --message "Bead: t-other" --message "Authored-On: $S" 2>&1)
check "$?" "1" "STALEEXACT1-r2-stale-base-refused" "$out" "STALE_WORKTREE pkg/f.txt reverts $P"
check "$(git -C "$R" rev-list --count HEAD)" "2" "STALEEXACT1-r2-stale-base-unmoved" "$out" ""
out=$(git -C "$R" commit --message "[test] ordinary edit" --message "Bead: t-other" --message "Authored-On: deadbee1234567" 2>&1)
check "$?" "1" "STALEEXACT1-r2-unknown-base-refused" "$out" "STALE_WORKTREE pkg/f.txt reverts $P"
out=$(git -C "$R" commit --message "[test] ordinary edit" --message "Bead: t-other" --message "Authored-On: not-a-sha-at-all" 2>&1)
check "$?" "1" "STALEEXACT1-r2-unparseable-base-refused" "$out" "STALE_WORKTREE pkg/f.txt reverts $P"
SIDE=$(git -C "$R" commit-tree "HEAD^{tree}" -m "side base")
out=$(git -C "$R" commit --message "[test] ordinary edit" --message "Bead: t-other" --message "Authored-On: $SIDE" 2>&1)
check "$?" "1" "STALEEXACT1-r2-offhistory-base-refused" "$out" "STALE_WORKTREE pkg/f.txt reverts $P"
out=$(git -C "$R" commit --message "[test] ordinary edit" --message "Bead: t-other" --message "Authored-On: $P" --message "Authored-On: $S" 2>&1)
check "$?" "1" "STALEEXACT1-r2-two-bases-refused" "$out" "STALE_WORKTREE pkg/f.txt reverts $P"
out=$(git -C "$R" commit --message "[test] ordinary edit" --message "Bead: t-other" --message "Authored-On: $P" 2>&1)
check "$?" "0" "STALEEXACT1-r2-valid-base-passes" "$out" ""
check "$(git -C "$R" rev-list --count HEAD)" "3" "STALEEXACT1-r2-valid-base-landed" "$out" ""

# 26. STALEEXACT1 R1: a hunk that re-adds the blamed commit's pre-image is a
# revert regardless of other added lines — even with a valid Authored-On
# base. A plain restoration refuses without a trailer and passes with one;
# restoration plus an adjacent new line, or trailing-whitespace drift, still
# refuse with a valid base. Planted negative: without the R1 predicate the
# restore-plus-new stage passes.
R=$(new_repo stalexact-r1)
member="$R/.git/hooks/hooks.d/commit-msg/49-omp-kit-stale-worktree"
S0=$(git -C "$R" rev-parse HEAD)
printf 'base line\npeer wording\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
git -C "$R" commit -q --message "[test] peer wording" --message "Bead: t-peer" --message "Supersedes: $S0"
P=$(git -C "$R" rev-parse HEAD)
printf 'base line\nlanded line L\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
out=$(git -C "$R" commit --message "[test] restore pre-image" --message "Bead: t-other" 2>&1)
check "$?" "1" "STALEEXACT1-r1-restore-refused" "$out" "STALE_WORKTREE pkg/f.txt reverts $P"
check "$(git -C "$R" rev-list --count HEAD)" "2" "STALEEXACT1-r1-restore-unmoved" "$out" "from bead t-peer"
out=$(git -C "$R" commit --message "[test] restore pre-image" --message "Bead: t-other" --message "Revert: $P" 2>&1)
check "$?" "0" "STALEEXACT1-r1-declared-restore-passes" "$out" ""
check "$(git -C "$R" log -1 --format=%B HEAD | grep -c "Revert: $P")" "1" "STALEEXACT1-r1-restore-logged" "$out" ""
R=$(new_repo stalexact-r1-superset)
member="$R/.git/hooks/hooks.d/commit-msg/49-omp-kit-stale-worktree"
S0=$(git -C "$R" rev-parse HEAD)
printf 'base line\npeer wording\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
git -C "$R" commit -q --message "[test] peer wording" --message "Bead: t-peer" --message "Supersedes: $S0"
P=$(git -C "$R" rev-parse HEAD)
printf 'base line\nlanded line L\nadjacent new\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
out=$(git -C "$R" commit --message "[test] restore plus new" --message "Bead: t-other" --message "Authored-On: $P" 2>&1)
check "$?" "1" "STALEEXACT1-r1-superset-refused" "$out" "STALE_WORKTREE pkg/f.txt reverts $P"
nor1="$TMP/staleexact-nor1.sh"
sed 's/r1_restores=1/r1_restores=0/' "$member" > "$nor1"
grep -q 'r1_restores=1' "$nor1"
check "$?" "1" "STALEEXACT1-nor1-planted" "" ""
printf '[test] restore plus new\n\nBead: t-other\n\nAuthored-On: %s\n' "$P" > "$TMP/staleexact-superset.msg"
out=$(cd "$R" && sh "$nor1" "$TMP/staleexact-superset.msg" 2>&1)
check "$?" "0" "STALEEXACT1-nor1-passes-restore-plus-new" "$out" ""
printf 'base line\nlanded line L \n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
out=$(git -C "$R" commit --message "[test] whitespace drift" --message "Bead: t-other" --message "Authored-On: $P" 2>&1)
check "$?" "1" "STALEEXACT1-r1-trimmed-refused" "$out" "STALE_WORKTREE pkg/f.txt reverts $P"
R=$(new_repo stalexact-r1-twohop)
S0=$(git -C "$R" rev-parse HEAD)
printf 'base line\nC line\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
git -C "$R" commit -q --message "[test] peer L to C" --message "Bead: t-peer1" --message "Supersedes: $S0"
P1=$(git -C "$R" rev-parse HEAD)
printf 'base line\nB line\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
git -C "$R" commit -q --message "[test] peer C to B" --message "Bead: t-peer2" --message "Supersedes: $P1"
P2=$(git -C "$R" rev-parse HEAD)
printf 'base line\nlanded line L\n' > "$R/pkg/f.txt"
git -C "$R" add pkg/f.txt
out=$(git -C "$R" commit --message "[test] restore L two hops back" --message "Bead: t-other" 2>&1)
check "$?" "1" "STALEEXACT1-r1-twohop-refused" "$out" "STALE_WORKTREE pkg/f.txt reverts $P2"
check "$(printf '%s\n' "$out" | grep -c "reverts $P1")" "0" "STALEEXACT1-r1-twohop-blames-head" "$out" ""

# 27. STALEEXACT1 R2 deletion: deleting lines a peer only added refuses
# without a trailer or a declared revert, and passes with an Authored-On
# base that already contains the peer commit — no Supersedes needed.
R=$(new_repo stalexact-r2-delete)
printf 'peer line\n' > "$R/pkg/g.txt"
git -C "$R" add pkg/g.txt
git -C "$R" commit -q --message "[test] peer adds g" --message "Bead: t-peer2"
Q=$(git -C "$R" rev-parse HEAD)
printf '' > "$R/pkg/g.txt"
git -C "$R" add pkg/g.txt
out=$(git -C "$R" commit --message "[test] drop peer g" --message "Bead: t-other" 2>&1)
check "$?" "1" "STALEEXACT1-r2-delete-refused" "$out" "STALE_WORKTREE pkg/g.txt reverts $Q"
check "$(git -C "$R" rev-list --count HEAD)" "2" "STALEEXACT1-r2-delete-unmoved" "$out" "from bead t-peer2"
out=$(git -C "$R" commit --message "[test] drop peer g" --message "Bead: t-other" --message "Supersedes: $Q" 2>&1)
check "$?" "0" "STALEEXACT1-r2-declared-delete-passes" "$out" ""
R=$(new_repo stalexact-r2-delete-based)
printf 'peer line\n' > "$R/pkg/g.txt"
git -C "$R" add pkg/g.txt
git -C "$R" commit -q --message "[test] peer adds g" --message "Bead: t-peer2"
Q=$(git -C "$R" rev-parse HEAD)
printf '' > "$R/pkg/g.txt"
git -C "$R" add pkg/g.txt
out=$(git -C "$R" commit --message "[test] drop peer g on base" --message "Bead: t-other" --message "Authored-On: $Q" 2>&1)
check "$?" "0" "STALEEXACT1-r2-delete-based-passes" "$out" ""
check "$(git -C "$R" rev-list --count HEAD)" "3" "STALEEXACT1-r2-delete-based-landed" "$out" ""
printf 'stale-worktree: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
