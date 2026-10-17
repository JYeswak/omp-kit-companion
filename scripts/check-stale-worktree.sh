#!/bin/sh
# check-stale-worktree.sh MSGFILE — commit-msg member (STALEWT1, ompkit-fp72.120.10; STALEWT2 fp72.123).
# Refuses a commit that would revert lines already landed in HEAD. Two rules:
#   (a) stale: a removed line blamed to a commit NEWER than the file's last
#       worktree write (the worktree predates the landing);
#   (b) foreign-bead: a removed line blamed to a commit carrying a `Bead:`
#       trailer different from this message's bead, unless the blamed sha is
#       declared with a `Revert: <sha>` or `Supersedes: <sha>` trailer line.
# Not judged: lines re-added byte-identically in the same commit at least as
# often as removed (moves, count-aware; rule (b) only — rule (a) still fires
# on stale mtimes, so re-adding elsewhere launders nothing), and any removal
# inside .beads/issues.jsonl (tracker export records belong to beads; rule
# (a) still applies to it).
# Same-bead rework passes silently. Pure additions pass. Unborn HEAD passes.
# Reads the effective tree through the index (GIT_INDEX_FILE is respected, so
# `git commit --only` temporary indexes are judged). Renames are read as
# delete+add (no -M follow): the delete side is judged by the rules above.
# Exit 1 refuses the commit, naming path, sha and subject.
set -u
msg=${1:?usage: check-stale-worktree.sh MSGFILE}
root=$(git rev-parse --show-toplevel) || { printf 'stale-worktree: not inside a work tree\n' >&2; exit 1; }
git rev-parse -q --verify 'HEAD^{commit}' > /dev/null || exit 0

# Current message bead and declared reverts (empty when absent). A
# `Supersedes: <sha>` trailer declares an intended rewrite with the same
# strength as `Revert: <sha>`; the trailer line itself logs it in the commit.
bead=$(grep -E -m1 '^[[:space:]]*[Bb]ead:[[:space:]]*[A-Za-z0-9._-]+' "$msg" 2>/dev/null | sed -e 's/^[^:]*:[[:space:]]*//' -e 's/[[:space:]]*$//')
reverts=$(grep -E -o '^[[:space:]]*[Rr]evert:[[:space:]]*[0-9a-fA-F]{7,64}|^[[:space:]]*[Ss]upersedes:[[:space:]]*[0-9a-fA-F]{7,64}' "$msg" 2>/dev/null | sed -e 's/^[^:]*:[[:space:]]*//')
[ -f "$msg" ] || { printf 'stale-worktree: cannot read %s\n' "$msg" >&2; exit 1; }

# Effective committed paths, NUL-separated straight into the loop (a shell
# variable cannot hold NULs; temp index included, so --only is judged).
git diff --cached --name-only -z HEAD -- >/dev/null 2>&1 || { printf 'stale-worktree: cannot list committed paths\n' >&2; exit 1; }
 test -n "$(git diff --cached --name-only HEAD --)" || exit 0
 tree=$(git write-tree) || { printf 'stale-worktree: cannot write the effective tree\n' >&2; exit 1; }

mtime_of() {
	# $1 = worktree path; prints epoch mtime, or nothing when absent.
	[ -e "$1" ] || return 0
	stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || return 0
}

removed_lines() {
	# $1 = path; prints removed HEAD line numbers, one per line, by
	# walking each zero-context hunk body (- lines consume old numbers).
	# Only hunks count: a removed "-- x" line renders as "--- x" and must
	# not be eaten as the file header, or every later number shifts.
	git diff -U0 --no-color --no-ext-diff "$HEAD" "$tree" -- "$1" 2>/dev/null | awk '
		/^@@ / {
			old = substr($2, 2);
			split(old, r, ",");
			old = r[1] + 0;
			inat = 1;
			next;
		}
		!inat { next }
		/^-/ { print old; old++; next }
		/^\+/ { next }
		/^ / { old++; next }
		/^\\/ { next }'
}
blame_sha() {
	git blame --porcelain "$HEAD" -- "$1" 2>/dev/null | awk -v want="$2" '
		/^\t/ { n++; if (n == want) { print sha; exit } next }
		/^[0-9a-f]{40} / { sha = $1 }
		END { exit 0 }'
}

moved_lines() {
	# $1 = path; prints removed HEAD line numbers whose exact text is
	# re-added elsewhere in the same staged diff at least as many times
	# (multiset moves, cross-file). Each added line cancels one removal.
	# Requires $mvadd (all added texts, one per line). Empty means none.
	[ -s "$mvadd" ] || return 0
	git diff -U0 --no-color --no-ext-diff "$HEAD" "$tree" -- "$1" 2>/dev/null | awk '
		/^@@ / { old = substr($2, 2); split(old, r, ","); old = r[1] + 0; inat = 1; next }
		!inat { next }
		/^-/ { print old "\t" substr($0, 2); old++ }' > "$mvrm"
	awk -F'\t' 'NR == FNR { add[$0]++; next } { text = substr($0, index($0, "\t") + 1); if (add[text] > 0) { print $1; add[text]-- } }' "$mvadd" "$mvrm"
}

HEAD=$(git rev-parse --verify 'HEAD^{commit}')
nl=$(printf '\nX'); nl=${nl%X}
# Moved-text multiset over the whole staged diff: every added line's exact
# text, one per line. A removed line whose text is re-added at least as many
# times is a move, not a revert (count-aware: each add cancels one removal).
mvadd="$root/.git/stale-worktree-added.$$"
mvrm="$root/.git/stale-worktree-removed.$$"
git diff -U0 --no-color --no-ext-diff "$HEAD" "$tree" 2>/dev/null | awk '/^@@ /{inat=1;next} !inat{next} /^\+/{print substr($0,2)}' | sort > "$mvadd"
git diff --cached --name-only -z HEAD -- | tr '\0' '\n' | while IFS= read -r path; do
	[ -n "$path" ] || continue
	case "$path" in */*..*|..*|*"$nl"*) continue ;; esac
	diffout=$(git diff -U0 --no-color --no-ext-diff "$HEAD" "$tree" -- "$path" 2>/dev/null) || continue
	case "$diffout" in *Binary\ files\ *differ*) continue ;; esac
	[ -n "$(removed_lines "$path")" ] || continue
	# Tracker export records belong to beads, not to the serializing commit:
	# .beads/issues.jsonl is outside rule (b). Rule (a) still applies to it.
	exempt_b=0
	case "$path" in .beads/issues.jsonl|*/.beads/issues.jsonl) exempt_b=1 ;; esac
	# Moved lines (same-commit re-adds, count-aware) skip rule (b) only.
	# Rule (a) judges them on mtime: a stale deletion re-added elsewhere
	# still refuses, so no text-bag launders a real stale revert.
	moved=" $(moved_lines "$path" | tr '\n' ' ')"
	mt=$(mtime_of "$root/$path")
	seen=""
	for ln in $(removed_lines "$path"); do
		sha=$(blame_sha "$path" "$ln") || continue
		[ -n "$sha" ] || continue
		subject=$(git log -1 --format=%s "$sha" 2>/dev/null)
		cdate=$(git log -1 --format=%ct "$sha" 2>/dev/null)
		cbead=$(git log -1 --format=%B "$sha" 2>/dev/null | grep -E -m1 '^[[:space:]]*[Bb]ead:[[:space:]]*[A-Za-z0-9._-]+' | sed -e 's/^[^:]*:[[:space:]]*//' -e 's/[[:space:]]*$//')
		declared=0
		for r in $reverts; do
			case "$sha" in "$r"*) declared=1 ;; esac
		done
		# Rule (a): worktree predates the landing (absent file skips: no mtime).
		if [ -n "$mt" ] && [ -n "$cdate" ] && [ "$cdate" -gt "$mt" ] && [ "$declared" -eq 0 ]; then
			case "$seen" in *"$sha"*) ;; *) printf 'STALE_WORKTREE %s reverts %s (%s)\n' "$path" "$sha" "$subject" >> "$root/.git/stale-worktree-report.$$" ;; esac
			seen="$seen $sha"
			printf '1\n' >> "$root/.git/stale-worktree-refused.$$"
			continue
		fi
		# Rule (b): foreign bead reverted without declaration. Skipped for
		# tracker-export paths and for moved lines (re-added in this same
		# commit, count-aware); rule (a) above already judged those lines.
		# Each removed line is evaluated (multiset); the report names each
		# sha once.
		skip_b=0
		[ "$exempt_b" -eq 1 ] && skip_b=1
		case "$moved" in *" $ln "*) skip_b=1 ;; esac
		if [ "$skip_b" -eq 0 ] && [ -n "$cbead" ] && [ -n "$bead" ] && [ "$cbead" != "$bead" ] && [ "$declared" -eq 0 ]; then
			case "$seen" in *"$sha"*) ;; *) printf 'STALE_WORKTREE %s reverts %s (%s) from bead %s\n' "$path" "$sha" "$subject" "$cbead" >> "$root/.git/stale-worktree-report.$$" ;; esac
			seen="$seen $sha"
			printf '1\n' >> "$root/.git/stale-worktree-refused.$$"
		fi
	done
 done
 if [ -s "$root/.git/stale-worktree-refused.$$" ]; then
 	report=$(cat "$root/.git/stale-worktree-report.$$" 2>/dev/null)
	rm -f "$root/.git/stale-worktree-refused.$$" "$root/.git/stale-worktree-report.$$" "$mvadd" "$mvrm"
	printf 'stale-worktree: REFUSED: commit would revert landed lines:\n%s\n' "$report" >&2
 	printf 'stale-worktree: declare each intended revert with a "Revert: <sha>" trailer line (or "Supersedes: <sha>" for a rewrite), or rework on a fresh worktree\n' >&2
 	exit 1
 fi
 rm -f "$root/.git/stale-worktree-refused.$$" "$root/.git/stale-worktree-report.$$" "$mvadd" "$mvrm"
 exit 0
