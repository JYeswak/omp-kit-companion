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
# on stale mtimes, so re-adding elsewhere launders nothing), and tracker
# export regenerations that lose no issue row (every removed row's issue id
# still present in the staged file; any lost id falls through, fail closed).
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

# The invocation owner, not the piped path-loop subshell, owns cache cleanup
# and signal handlers. Retention is never appropriate for these private facts.
facts_here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
[ -f "$facts_here/kitlib-tmp.sh" ] || { printf 'stale-worktree: kitlib-tmp.sh missing beside gate\n' >&2; exit 1; }
# shellcheck source=scripts/kitlib-tmp.sh
. "$facts_here/kitlib-tmp.sh"
KITLIB_TMP_AUTO_CLEANUP=1
metadata_dir=""
kitlib_tmp metadata_dir stale-worktree-facts || exit 1

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
		/^diff --git / { inat = 0; next }
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
blame_lines() {
	# $1 = path; reads its removed HEAD line numbers (ascending) on stdin and
	# prints "<line> <sha>" for each, from ONE `git blame` restricted with -L
	# to just those lines (consecutive numbers coalesced into ranges). Blame
	# attributes every line independently, so -L changes no line's commit;
	# a full blame per removed line cost O(removed x history): 7 rows of a
	# 27 MB tracker took 230 s (ompkit-xa5s.30).
	# Intended split: the words are only "-L" and "<n>,<m>" (digits, comma).
	# shellcheck disable=SC2046
	set -- "$1" $(awk 'NR == 1 { s = e = $1; next } $1 == e + 1 { e = $1; next } { printf "-L %d,%d ", s, e; s = e = $1 } END { if (NR) printf "-L %d,%d\n", s, e }')
	[ "$#" -gt 1 ] || return 0
	bpath=$1
	shift
	git blame --porcelain "$@" "$HEAD" -- "$bpath" 2>/dev/null | awk '/^[0-9a-f]{40} [0-9]+ [0-9]+/ { print $3, $1 }'
}

# Commit facts are immutable within this pinned invocation, not per removed
# line (ompkit-axz7m.9). The cache survives the path-loop subshell and is owned
# by the existing temp primitive; unsuccessful Git observations are not cached.
commit_facts() {
	facts_prefix="$metadata_dir/$1"
	if [ -f "$facts_prefix.ready" ]; then
		IFS= read -r subject < "$facts_prefix.subject" || return 1
		IFS= read -r cdate < "$facts_prefix.date" || return 1
		IFS= read -r cbead < "$facts_prefix.bead" || return 1
		return 0
	fi
	subject=$(git log -1 --format=%s "$1" 2>/dev/null)
	facts_subject_rc=$?
	cdate=$(git log -1 --format=%ct "$1" 2>/dev/null)
	facts_date_rc=$?
	facts_body=$(git log -1 --format=%B "$1" 2>/dev/null)
	facts_body_rc=$?
	cbead=$(printf '%s\n' "$facts_body" | grep -E -m1 '^[[:space:]]*[Bb]ead:[[:space:]]*[A-Za-z0-9._-]+' | sed -e 's/^[^:]*:[[:space:]]*//' -e 's/[[:space:]]*$//')
	if [ "$facts_subject_rc" -eq 0 ] && [ "$facts_date_rc" -eq 0 ] && [ "$facts_body_rc" -eq 0 ]; then
		printf '%s\n' "$subject" > "$facts_prefix.subject" || return 1
		printf '%s\n' "$cdate" > "$facts_prefix.date" || return 1
		printf '%s\n' "$cbead" > "$facts_prefix.bead" || return 1
		: > "$facts_prefix.ready" || return 1
	fi
	return 0
}

moved_lines() {
	# $1 = path; prints removed HEAD line numbers cancelled by same-commit
	# re-adds, consuming from the GLOBAL $mvavail multiset (built from
	# $mvadd_sorted minus already-consumed $mvused). Consumption persists
	# across paths: one add excuses exactly one removal, wherever they sit.
	# Appends each consumed text to $mvused and re-sorts it.
	[ -s "$mvavail" ] || return 0
	git diff -U0 --no-color --no-ext-diff "$HEAD" "$tree" -- "$1" 2>/dev/null | awk '
		/^diff --git / { inat = 0; next }
		/^@@ / { old = substr($2, 2); split(old, r, ","); old = r[1] + 0; inat = 1; next }
		!inat { next }
		/^-/ { print old "\t" substr($0, 2); old++ }' > "$mvrm"
	awk -F'\t' 'NR == FNR { add[$0]++; next } { text = substr($0, index($0, "\t") + 1); if (add[text] > 0) { print; add[text]-- } }' "$mvavail" "$mvrm" > "$mvhit"
	cut -f2- "$mvhit" >> "$mvused"
	sort -o "$mvused" "$mvused"
	cut -f1 "$mvhit"
}

HEAD=$(git rev-parse --verify 'HEAD^{commit}')
nl=$(printf '\nX'); nl=${nl%X}
# Moved-text multiset over the whole staged diff: every added line's exact
# text, one per line. A removed line whose text is re-added at least as many
# times is a move, not a revert (count-aware: each add cancels one removal,
# globally across paths).
mvadd_sorted="$root/.git/stale-worktree-added.$$"
mvused="$root/.git/stale-worktree-used.$$"
mvavail="$root/.git/stale-worktree-avail.$$"
mvrm="$root/.git/stale-worktree-removed.$$"
mvhit="$root/.git/stale-worktree-hit.$$"
# The same invocation owner cleans these existing files on every exit.
# Join I/O failures propagate in pipeline status, not a disk error marker.
kitlib_tmp_atexit 'rm -f "$root/.git/stale-worktree-refused.$$" "$root/.git/stale-worktree-report.$$" "$mvadd_sorted" "$mvused" "$mvavail" "$mvrm" "$mvhit"'
git diff -U0 --no-color --no-ext-diff "$HEAD" "$tree" 2>/dev/null | awk '/^diff --git /{inat=0;next} /^@@ /{inat=1;next} !inat{next} /^\+/{print substr($0,2)}' | sort > "$mvadd_sorted"
: > "$mvused"
newest=""
git diff --cached --name-only -z HEAD -- | tr '\0' '\n' | while IFS= read -r path; do
	[ -n "$path" ] || continue
	case "$path" in */*..*|..*|*"$nl"*) continue ;; esac
	diffout=$(git diff -U0 --no-color --no-ext-diff "$HEAD" "$tree" -- "$path" 2>/dev/null) || continue
	case "$diffout" in *Binary\ files\ *differ*) continue ;; esac
	[ -n "$(removed_lines "$path")" ] || continue
	# Tracker export records belong to beads, not to the serializing commit.
	# A regeneration that loses no issue row is not a revert: when every
	# removed row's issue id still has a row in the staged file, rule (b)
	# skips this path. Any lost id, or no ids at all, falls through to the
	# normal rules (fail closed). Rule (a) always still applies to it.
	export_ok=0
	case "$path" in .beads/issues.jsonl|*/.beads/issues.jsonl)
		removed_ids=$(git diff -U0 --no-color --no-ext-diff "$HEAD" "$tree" -- "$path" 2>/dev/null | awk '/^@@ /{inat=1;next} !inat{next} /^-/{print substr($0,2)}' | grep -o '"id":"[^"]*"' | sort -u)
		if [ -n "$removed_ids" ]; then
			new_ids=$(git show "$tree:$path" 2>/dev/null | grep -o '"id":"[^"]*"' | sort -u)
			lost=0
			for id in $removed_ids; do
				printf '%s\n' "$new_ids" | grep -qxF -- "$id" || lost=1
			done
		[ "$lost" -eq 0 ] && export_ok=1
		fi
		;;
	esac
	# Moved lines (same-commit re-adds, count-aware across the whole commit)
	# skip rule (b) only. Rule (a) judges them on mtime: a stale deletion
	# re-added elsewhere still refuses, so no text-bag launders a real
	# stale revert.
	comm -23 "$mvadd_sorted" "$mvused" > "$mvavail"
	moved=" $(moved_lines "$path" | tr '\n' ' ')"
	mt=$(mtime_of "$root/$path")
	# No blame when no rule can refuse this path (ompkit-xa5s.30: closing an
	# old tracker row cost one 32 s blame). Rule (b) needs a message bead and
	# a path outside the loss-free export exemption. Rule (a) needs a blamed
	# commit dated after the worktree file; every blamed commit is HEAD or an
	# ancestor, so a file no older than the newest of those cannot be stale.
	# An unreadable history keeps the blame (fail closed).
	if [ "$export_ok" -eq 1 ] || [ -z "$bead" ]; then
		[ -n "$mt" ] || continue
		[ -n "$newest" ] || newest=$(git log --format=%ct "$HEAD" 2>/dev/null | sort -n | tail -n 1)
		case "$newest" in '' | *[!0-9]*) ;; *) [ "$newest" -gt "$mt" ] || continue ;; esac
	fi
	seen=""
	blamed=$(removed_lines "$path" | blame_lines "$path")
	# Join once, retaining removed-site order and the incumbent's first-match
	# semantics. Move allocation has consumed these two scratch files already.
	if ! removed_lines "$path" > "$mvrm"; then
		printf 'stale-worktree: cannot materialize removed sites: %s\n' "$path" >&2
		exit 1
	fi
	if ! printf '%s\n' "$blamed" | awk '
		FILENAME != "-" { order[++n] = $1; next }
		!($1 in sha) { sha[$1] = $2 }
		END {
			for (i = 1; i <= n; i++)
				if (order[i] in sha) print order[i], sha[order[i]]
		}' "$mvrm" - > "$mvhit"; then
		printf 'stale-worktree: cannot join removed sites: %s\n' "$path" >&2
		exit 1
	fi
	while IFS=' ' read -r ln sha; do
		[ -n "$sha" ] || continue
		if ! commit_facts "$sha"; then
			printf 'UNREADABLE_COMMIT_FACTS %s %s\n' "$path" "$sha" >&2
			exit 1
		fi
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
		# loss-free export regenerations and for moved lines (re-added in
		# this same commit, count-aware); rule (a) above already judged
		# those lines. Each removed line is evaluated (multiset); the
		# report names each sha once.
		skip_b=0
		[ "$export_ok" -eq 1 ] && skip_b=1
		case "$moved" in *" $ln "*) skip_b=1 ;; esac
		if [ "$skip_b" -eq 0 ] && [ -n "$cbead" ] && [ -n "$bead" ] && [ "$cbead" != "$bead" ] && [ "$declared" -eq 0 ]; then
			case "$seen" in *"$sha"*) ;; *) printf 'STALE_WORKTREE %s reverts %s (%s) from bead %s\n' "$path" "$sha" "$subject" "$cbead" >> "$root/.git/stale-worktree-report.$$" ;; esac
			seen="$seen $sha"
			printf '1\n' >> "$root/.git/stale-worktree-refused.$$"
		fi
	done < "$mvhit" || exit 1
 done || { printf 'stale-worktree: cannot evaluate removed sites\n' >&2; exit 1; }
 if [ -s "$root/.git/stale-worktree-refused.$$" ]; then
 	report=$(cat "$root/.git/stale-worktree-report.$$" 2>/dev/null)
	printf 'stale-worktree: REFUSED: commit would revert landed lines:\n%s\n' "$report" >&2
 	printf 'stale-worktree: declare each intended revert with a "Revert: <sha>" trailer line (or "Supersedes: <sha>" for a rewrite), or rework on a fresh worktree\n' >&2
 	exit 1
 fi
 exit 0
