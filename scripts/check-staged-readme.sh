#!/bin/sh
# check-staged-readme.sh — pre-commit member (READMESIZE1, ompkit-readme-changelog-currency-vrrn.1).
#
# The README rules (count claims, command reference, readme-update S1-bytes
# size) ran only at push time and in CI, so the commit that made README stale
# or full was accepted and the next pusher of shared main paid (2493fe2a88
# shipped a fifth skill with README still claiming "four skills"; every push
# then failed until 5907979c84 fixed the count). This member makes the author
# pay: whenever the staged paths include README.md, skills/**, rules/*.md,
# src/commands.ts or package.json, it runs scripts/readme-check.ts on the
# candidate INDEX tree (git write-tree, then archive; never the worktree) and
# refuses the commit with the finding. Commits staging only unrelated paths
# skip the check entirely, so an uncommitted oversized README in the worktree
# never affects them.
# Exit 0 pass (or no trigger staged), 1 refuse.
set -u
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
root=$(git rev-parse --show-toplevel) || { printf 'staged-readme: not inside a work tree\n' >&2; exit 1; }
# GIT_INDEX_FILE is respected, so `git commit --only` temporary indexes are
# judged, not the full index.
staged=$(git diff --cached --name-only) || { printf 'staged-readme: cannot read the staged paths\n' >&2; exit 1; }
triggered=0
while IFS= read -r path; do
	[ -n "$path" ] || continue
	case "$path" in
		README.md|package.json|src/commands.ts) triggered=1; break ;;
		skills/*) triggered=1; break ;;
		rules/*.md) triggered=1; break ;;
	esac
done <<EOF
$staged
EOF
[ "$triggered" = 1 ] || exit 0
checker="$here/readme-check.ts"
[ -f "$checker" ] || { printf 'staged-readme: REFUSED: installed readme checker missing beside %s; rerun scripts/install-commit-msg-bead.sh\n' "$(basename -- "$0")" >&2; exit 1; }
command -v bun >/dev/null 2>&1 || { printf 'staged-readme: REFUSED: bun is unavailable so readme-check cannot run on the candidate tree\n' >&2; exit 1; }
tree=$(git write-tree) || { printf 'staged-readme: cannot write the staged tree\n' >&2; exit 1; }
[ -f "$here/kitlib-tmp.sh" ] || { printf 'staged-readme: REFUSED: kitlib-tmp.sh missing beside %s; rerun scripts/install-commit-msg-bead.sh\n' "$(basename -- "$0")" >&2; exit 1; }
# shellcheck source=scripts/kitlib-tmp.sh
. "$here/kitlib-tmp.sh"
tmp='' # assigned by kitlib_tmp via eval
kitlib_tmp tmp staged-readme || { printf 'staged-readme: cannot stage the candidate tree\n' >&2; exit 1; }
git archive "$tree" | tar -xf - -C "$tmp" || { printf 'staged-readme: cannot extract the candidate tree\n' >&2; exit 1; }
if out=$(CDPATH='' cd -- "$root" && bun run --no-env-file --config=/dev/null "$checker" --root "$tmp" 2>&1); then
	exit 0
fi
printf 'staged-readme: REFUSED: readme-check rejects the candidate tree (worktree ignored)\n%s\n' "$out" >&2
exit 1
