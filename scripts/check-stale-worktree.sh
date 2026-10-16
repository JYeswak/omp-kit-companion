#!/bin/sh
# check-stale-worktree.sh MSGFILE — commit-msg member (STALEWT1, ompkit-fp72.120.10).
# Refuses a commit that would revert lines already landed in HEAD. Two rules:
#   (a) stale: a removed line blamed to a commit NEWER than the file's last
#       worktree write (the worktree predates the landing);
#   (b) foreign-bead: a removed line blamed to a commit carrying a `Bead:`
#       trailer different from this message's bead, unless the blamed sha is
#       declared with a `Revert: <sha>` trailer line.
# Same-bead rework passes silently. Pure additions pass. Unborn HEAD passes.
# Reads the effective tree through the index (GIT_INDEX_FILE is respected, so
# `git commit --only` temporary indexes are judged). Renames are read as
# delete+add (no -M follow): the delete side is judged by the rules above.
# Exit 1 refuses the commit, naming path, sha and subject.
set -u
msg=${1:?usage: check-stale-worktree.sh MSGFILE}
root=$(git rev-parse --show-toplevel) || { printf 'stale-worktree: not inside a work tree\n' >&2; exit 1; }
git rev-parse -q --verify 'HEAD^{commit}' > /dev/null || exit 0

# Current message bead and declared reverts (empty when absent).
bead=$(grep -E -m1 '^[[:space:]]*[Bb]ead:[[:space:]]*[A-Za-z0-9._-]+' "$msg" 2>/dev/null | sed -e 's/^[^:]*:[[:space:]]*//' -e 's/[[:space:]]*$//')
reverts=$(grep -E -o '^[[:space:]]*[Rr]evert:[[:space:]]*[0-9a-fA-F]{7,64}' "$msg" 2>/dev/null | sed -e 's/^[^:]*:[[:space:]]*//')
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
 	git diff -U0 --no-color --no-ext-diff "$HEAD" "$tree" -- "$1" 2>/dev/null | awk '
 		/^@@ / {
 			old = substr($2, 2);
 			split(old, r, ",");
 			old = r[1] + 0;
 			next;
 		}
 		/^--- / || /^\+\+\+ / { next }
 		/^-/ { print old; old++; next }
 		/^\+/ { next }
 		/^ / { old++; next }
 		/^\\/ { next }'
 }

blame_sha() {
	# $1 = path, $2 = HEAD line number; prints the blamed commit sha.
	git blame --porcelain "$HEAD" -- "$1" 2>/dev/null | awk -v want="$2" '
		/^\t/ { n++; if (n == want) { print sha; exit } next }
		/^[0-9a-f]{40} / { sha = $1 }
		END { exit 0 }'
}

HEAD=$(git rev-parse --verify 'HEAD^{commit}')
nl=$(printf '\nX'); nl=${nl%X}
git diff --cached --name-only -z HEAD -- | tr '\0' '\n' | while IFS= read -r path; do
	[ -n "$path" ] || continue
	case "$path" in */*..*|..*|*"$nl"*) continue ;; esac
	diffout=$(git diff -U0 --no-color --no-ext-diff "$HEAD" "$tree" -- "$path" 2>/dev/null) || continue
	case "$diffout" in *Binary\ files\ *differ*) continue ;; esac
	[ -n "$(removed_lines "$path")" ] || continue
	mt=$(mtime_of "$root/$path")
	seen=""
	for ln in $(removed_lines "$path"); do
		sha=$(blame_sha "$path" "$ln") || continue
		[ -n "$sha" ] || continue
		case "$seen" in *"$sha"*) continue ;; esac
		seen="$seen $sha"
		subject=$(git log -1 --format=%s "$sha" 2>/dev/null)
		cdate=$(git log -1 --format=%ct "$sha" 2>/dev/null)
		cbead=$(git log -1 --format=%B "$sha" 2>/dev/null | grep -E -m1 '^[[:space:]]*[Bb]ead:[[:space:]]*[A-Za-z0-9._-]+' | sed -e 's/^[^:]*:[[:space:]]*//' -e 's/[[:space:]]*$//')
		declared=0
		for r in $reverts; do
			case "$sha" in "$r"*) declared=1 ;; esac
		done
		# Rule (a): worktree predates the landing (absent file skips: no mtime).
		if [ -n "$mt" ] && [ -n "$cdate" ] && [ "$cdate" -gt "$mt" ] && [ "$declared" -eq 0 ]; then
			printf 'STALE_WORKTREE %s reverts %s (%s)\n' "$path" "$sha" "$subject" >> "$root/.git/stale-worktree-report.$$"
			printf '1\n' >> "$root/.git/stale-worktree-refused.$$"
			continue
		fi
		# Rule (b): foreign bead reverted without declaration.
		if [ -n "$cbead" ] && [ -n "$bead" ] && [ "$cbead" != "$bead" ] && [ "$declared" -eq 0 ]; then
			printf 'STALE_WORKTREE %s reverts %s (%s) from bead %s\n' "$path" "$sha" "$subject" "$cbead" >> "$root/.git/stale-worktree-report.$$"
			printf '1\n' >> "$root/.git/stale-worktree-refused.$$"
		fi
	done
 done
 if [ -s "$root/.git/stale-worktree-refused.$$" ]; then
 	report=$(cat "$root/.git/stale-worktree-report.$$" 2>/dev/null)
 	rm -f "$root/.git/stale-worktree-refused.$$" "$root/.git/stale-worktree-report.$$"
	printf 'stale-worktree: REFUSED: commit would revert landed lines:\n%s\n' "$report" >&2
 	printf 'stale-worktree: declare each intended revert with a `Revert: <sha>` trailer line, or rework on a fresh worktree\n' >&2
 	exit 1
 fi
 rm -f "$root/.git/stale-worktree-refused.$$" "$root/.git/stale-worktree-report.$$"
 exit 0
