#!/bin/sh
# pre-push-verification-level.sh — VLEVEL-PUSH1 (ompkit-2w7h.2).
# A push whose range holds a non-exempt commit with no verification level in
# its subject is refused, naming the sha and subject. The fleet's documented
# private-index landing (GIT_INDEX_FILE + hash-object + commit-tree) never runs
# the commit-msg hook, so commit-tree commits reach the push with no level
# unless a pre-push member judges the range. Merge, revert and fixup commits
# stay exempt, matching hooks.d/commit-msg/commit-msg-verification-level.sh.
#
# The level and exempt patterns below are byte-identical in intent to that
# hook's level_of()/exempt(): LEVELS=(pending selftest test mutation oracle
# live); a subject claims one via "[level]", "<level> pending|verified" or
# "<level>-level"; exempt subjects match ^(Merge |Revert |fixup! |squash! ).
# If the commit-msg hook changes, update both and re-run --selftest.
#
# Usage:
#   pre-push-verification-level.sh --repo DIR --base SHA --tip SHA
#       refuse (exit 4) when git rev-list TIP --not BASE holds a non-exempt
#       level-less commit. BASE is the exclusion floor (the remote sha).
#   pre-push-verification-level.sh --pre-push [<remote-name>] [--repo DIR]
#       pre-push hook body: read "<lref> <lsha> <rref> <rsha>" lines on stdin
#       and check each pushed range. Deletions pass; a zero remote sha (new
#       ref) is judged against the remote-tracking refs of <remote-name>.
#   pre-push-verification-level.sh --check [REPO]
#       report the installed chain member when missing or stale (exit 3),
#       like install-commit-msg-bead.sh --check. Prints "hooks fresh" on pass.
#   pre-push-verification-level.sh --selftest
#       planted temp-repo proof: (a) level-less commit-tree push refused and
#       origin unchanged; (b) same with [pending] pushed; (c) levelless merge
#       pushed; (d) empty range passes. A mutant with the member skipped fails
#       (a), proving the member is the catcher. All fixtures live under
#       "${TMPDIR:-/tmp}" and are removed on exit.
set -u

SELF=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/$(basename -- "$0")
MEMBER="hooks.d/pre-push/41-omp-kit-pushed-vlevel"

level_of() {
	# prints the level claimed by the subject, or nothing; mirrors
	# commit-msg-verification-level.sh level_of()
	subject="$1"
	for lv in pending selftest test mutation oracle live; do
		if printf '%s' "$subject" | grep -qiE "\[${lv}\]|\b${lv}[- ](pending|verified)\b|\b${lv}-level\b"; then
			printf '%s' "$lv"
			return 0
		fi
	done
	return 1
}

is_exempt() {
	# mirrors commit-msg-verification-level.sh exempt()
	printf '%s' "$1" | grep -qiE '^(Merge |Revert |fixup! |squash! )'
}

check_range() {
	# check_range REPO BASE TIP: refuse when the range holds a non-exempt
	# level-less commit. Empty ranges pass.
	repo="$1" base="$2" tip="$3"
	commits=$(git -C "$repo" rev-list "$tip" --not "$base" 2>/dev/null) || {
		printf 'pre-push-verification-level: cannot list range %s --not %s\n' "$tip" "$base" >&2
		return 2
	}
	for sha in $commits; do
		subject=$(git -C "$repo" log --format=%s -n 1 "$sha" 2>/dev/null) || {
			printf 'pre-push-verification-level: cannot read %s\n' "$sha" >&2
			return 2
		}
		if is_exempt "$subject"; then
			continue
		fi
		if level_of "$subject" >/dev/null 2>&1; then
			continue
		fi
		printf 'pre-push-verification-level: REFUSED %s subject=%s\n' "$sha" "$subject" >&2
		printf '  a pushed commit subject must say what it PROVED: [pending], [selftest], [test], [mutation], [oracle] or [live].\n' >&2
		printf '  merge, revert and fixup commits are exempt. Land private-index commits only after\n' >&2
		printf '  GIT_INDEX_FILE=<idx> git hook run commit-msg -- <msgfile> exits 0 for the same message.\n' >&2
		return 4
	done
	return 0
}

pre_push() {
	# pre_push REMOTE REPO: check every pushed range from stdin
	remote="${1:-origin}" repo="$2" rc=0 line=""
	while IFS= read -r line || [ -n "$line" ]; do
		# shellcheck disable=SC2086
		set -- $line
		[ $# -eq 4 ] || continue
		lsha="$2" rsha="$4"
		case "$lsha" in
			0000000000000000000000000000000000000000) continue ;; # deletion: nothing to judge
		esac
		case "$rsha" in
			0000000000000000000000000000000000000000)
				base="--remotes=$remote"
				;;
			*) base="$rsha" ;;
		esac
		# shellcheck disable=SC2086
		check_range "$repo" $base "$lsha" || rc=$?
	done
	return "$rc"
}

do_check() {
	# do_check REPO: the installed member must exist, be executable and equal
	# this source; name anything stale, mirroring installer --check language.
	repo="$1"
	hooks=$(git -C "$repo" rev-parse --git-path hooks 2>/dev/null) || {
		printf 'pre-push-verification-level: %s is not a git repo\n' "$repo" >&2
		return 2
	}
	case "$hooks" in /*) dest="$hooks/$MEMBER" ;; *) dest="$repo/$hooks/$MEMBER" ;; esac
	if [ ! -x "$dest" ]; then
		printf 'pre-push-verification-level: MISSING installed member: %s\n' "$dest" >&2
		return 3
	fi
	if ! cmp -s "$SELF" "$dest"; then
		printf 'pre-push-verification-level: STALE installed member: %s differs from %s\n' "$dest" "$SELF" >&2
		return 3
	fi
	printf 'pre-push-verification-level: hooks fresh in %s\n' "$repo"
	return 0
}

do_selftest() {
	# Sourced here, not at the top: the installed hook (and the fixture copies below) run without kitlib beside them.
	. "${SELF%/*}/kitlib-tmp.sh"
	kitlib_tmp root vlevel-selftest || exit 2
	pass=0 fail=0
	ok() { printf 'selftest: PASS %s\n' "$1"; pass=$((pass + 1)); }
	bad() { printf 'selftest: FAIL %s\n' "$1"; fail=$((fail + 1)); }

	mkfixture() {
		# mkfixture NAME: bare origin + work clone with the member installed
		# as the pre-push hook; echoes the work dir.
		name="$1"
		git init -q --bare "$root/$name.git" || return 1
		git init -q -b main "$root/$name" || return 1
		(cd "$root/$name" && git config user.email t@t && git config user.name t \
			&& git commit -q --allow-empty -m "seed [test]" \
			&& git remote add origin "$root/$name.git" \
			&& git push -q origin main) || return 1
		cp "$SELF" "$root/$name/.git/hooks/pre-push" || return 1
		chmod +x "$root/$name/.git/hooks/pre-push" || return 1
		printf '%s' "$root/$name"
	}

	# (a) level-less commit-tree push: refused, origin unchanged
	w=$(mkfixture a) || { bad "fixture a setup"; w=""; }
	if [ -n "$w" ]; then
		before=$(git --git-dir="$root/a.git" rev-parse refs/heads/main)
		nt=$(cd "$w" && tree=$(git rev-parse "HEAD^{tree}") && git commit-tree "$tree" -p HEAD -m "quiet landing without a level") || nt=""
		(cd "$w" && git update-ref refs/heads/main "$nt")
		out=$(cd "$w" && git push origin main 2>&1); rc=$?
		after=$(git --git-dir="$root/a.git" rev-parse refs/heads/main)
		if [ "$rc" -ne 0 ] && [ "$after" = "$before" ]; then
			case "$out" in *"$nt"*) ok "(a) level-less commit-tree refused naming sha, origin unchanged" ;; *) bad "(a) refused but sha not named" ;; esac
		else
			bad "(a) level-less commit-tree push not refused (rc=$rc origin moved)"
		fi
	fi

	# (b) same commit with [pending]: pushed
	w=$(mkfixture b) || { bad "fixture b setup"; w=""; }
	if [ -n "$w" ]; then
		nt=$(cd "$w" && tree=$(git rev-parse "HEAD^{tree}") && git commit-tree "$tree" -p HEAD -m "quiet landing [pending]") || nt=""
		(cd "$w" && git update-ref refs/heads/main "$nt" && git push -q origin main 2>/dev/null); rc=$?
		after=$(git --git-dir="$root/b.git" rev-parse refs/heads/main)
		if [ "$rc" -eq 0 ] && [ "$after" = "$nt" ]; then ok "(b) [pending] commit-tree pushed"; else bad "(b) [pending] commit-tree not pushed"; fi
	fi

	# (c) merge commit without a level: pushed
	w=$(mkfixture c) || { bad "fixture c setup"; w=""; }
	if [ -n "$w" ]; then
		(cd "$w" && git checkout -qb side && git commit -q --allow-empty -m "side work [test]" \
			&& git checkout -q main && git merge -q --no-ff -m "Merge branch 'side'" side \
			&& git push -q origin main 2>/dev/null); rc=$?
		if [ "$rc" -eq 0 ]; then ok "(c) levelless merge pushed"; else bad "(c) levelless merge refused"; fi
	fi

	# (d) empty range passes
	w=$(mkfixture d) || { bad "fixture d setup"; w=""; }
	if [ -n "$w" ]; then
		sha=$(cd "$w" && git rev-parse HEAD)
		if printf 'refs/heads/main %s refs/heads/main %s\n' "$sha" "$sha" | (cd "$w" && sh "$SELF" --pre-push origin --repo "$w"); then
			ok "(d) empty range passes"
		else
			bad "(d) empty range refused"
		fi
	fi

	# mutant: member skipped -> (a) is NOT refused (the catcher is gone)
	w=$(mkfixture m) || { bad "mutant fixture setup"; w=""; }
	if [ -n "$w" ]; then
		rm "$w/.git/hooks/pre-push"
		nt=$(cd "$w" && tree=$(git rev-parse "HEAD^{tree}") && git commit-tree "$tree" -p HEAD -m "quiet landing without a level") || nt=""
		(cd "$w" && git update-ref refs/heads/main "$nt" && git push -q origin main 2>/dev/null); rc=$?
		if [ "$rc" -eq 0 ]; then ok "mutant without member fails (a): push unrefused"; else bad "mutant unexpectedly refused (a)"; fi
	fi

	printf 'selftest: %d passed, %d failed\n' "$pass" "$fail"
	[ "$fail" -eq 0 ]
}

MODE="" REPO="" BASE="" TIP="" REMOTE="origin"
while [ $# -gt 0 ]; do
	case "$1" in
		--repo) REPO=${2:-}; shift 2 ;;
		--base) BASE=${2:-}; shift 2 ;;
		--tip) TIP=${2:-}; shift 2 ;;
		--pre-push) MODE=prepush; shift ;;
		--check) MODE=check; shift ;;
		--selftest) MODE=selftest; shift ;;
		--) shift; break ;;
		-*) printf 'pre-push-verification-level: unknown argument %s\n' "$1" >&2; exit 2 ;;
		*) REMOTE="$1"; shift ;;
	esac
done
case "$MODE" in
	prepush)
		[ -n "$REPO" ] || REPO=$(git rev-parse --show-toplevel 2>/dev/null) || {
			printf 'pre-push-verification-level: --pre-push needs --repo DIR or a checkout cwd\n' >&2
			exit 2
		}
		pre_push "$REMOTE" "$REPO"
		;;
	check) do_check "${1:-${REPO:-.}}" ;;
	selftest) do_selftest ;;
	*)
		# No mode flags: behave as the installed pre-push member (git calls
		# the hook as "pre-push <name> <url>" with push lines on stdin). An
		# explicit --repo/--base/--tip triple selects the direct check.
		if [ -n "$REPO" ] && [ -n "$BASE" ] && [ -n "$TIP" ]; then
			check_range "$REPO" "$BASE" "$TIP"
		else
			[ -n "$REPO" ] || REPO=$(git rev-parse --show-toplevel 2>/dev/null) || {
				printf 'usage: pre-push-verification-level.sh --repo DIR --base SHA --tip SHA | [--pre-push [REMOTE] [--repo DIR]] | --check [REPO] | --selftest\n' >&2
				exit 2
			}
			pre_push "$REMOTE" "$REPO"
		fi
		;;
esac
