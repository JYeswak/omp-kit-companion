#!/bin/sh
# check-pushed-on-main.sh -- PUSHGUARD1 pre-push member (ompkit-rc-epic-land-fix-release-dogfood-rz5.139).
# One history per repo (J-2026-10-15-11): a push may move a remote main only to
# a commit already on this repo's shared local main. Private-index candidates
# (commit-tree -p origin/main, pushed as <sha>:refs/heads/main) are not on local
# main; they split every fleet repo into two histories (0 of 149 publishes
# succeeded in 48 h, 2026-10-15).
# Git runs it from the repo top level with pre-push lines on stdin:
#   <local ref> <local sha> <remote ref> <remote sha>
# A line whose remote ref is refs/heads/main passes only when its local sha is
# refs/heads/main or an ancestor of it. A deletion, a missing local main and an
# unverifiable sha are refused too. SNAPSHOTPUB1 AC2 (ompkit-v66l.14): creating or
# moving any other remote branch is refused (main only, no branches); 2026-10-25 an
# unadmitted off-main commit pushed to refs/heads/topic passed once the custody
# check moved to pre-commit. Deleting a stray remote branch and every non-branch
# ref (tags, notes) pass.
# Exit 0 when every line passes, 4 naming each refused sha.
set -u
main=$(git rev-parse -q --verify 'refs/heads/main^{commit}' 2>/dev/null) || main=""
rc=0
while read -r lref lsha rref rsha; do
	case "${rref:-}" in
		refs/heads/main) ;;
		refs/heads/*)
			case "$lsha" in
				*[!0]*)
					printf 'check-pushed-on-main: REFUSED %s (%s) -> %s: only main is published; a push to any other branch is never a publication (main only, no branches). Commit on main and push main.\n' \
						"$lsha" "$lref" "$rref" >&2
					rc=4 ;;
			esac
			continue ;;
		*) continue ;;
	esac
	reason=""
	case "$lsha" in
		*[!0]*)
			if [ -z "$main" ]; then
				reason="this repo has no local refs/heads/main to publish from"
			elif ! git merge-base --is-ancestor "$lsha" "$main" 2>/dev/null; then
				reason="not on this repo's shared main (refs/heads/main is $main)"
			fi
			;;
		*) reason="deleting the remote main is never a publication" ;;
	esac
	[ -z "$reason" ] && continue
	printf 'check-pushed-on-main: REFUSED %s (%s) -> %s (remote was %s): %s. One history per repo: commit on main (git commit --only -- <paths>) and push main itself (git push origin main; if origin moved, python3 ~/Developer/omp-kit/scripts/git_converge.py --repo <repo> --push). Never push a private-index candidate.\n' \
		"$lsha" "$lref" "$rref" "$rsha" "$reason" >&2
	rc=4
done
exit "$rc"
