#!/bin/sh
# check-commit-notes.sh MSGFILE — commit-msg member (SHIFTLEFT1, ompkit-1wgy).
# The push notes gate (scripts/check-pushed-notes.sh) refuses a commit that
# touches shipped paths unless it carries one `Bead: <id>` trailer with a
# changelog.d/<slug>.md or changelog.d/<id>.md fragment, or one
# `[no-changelog] <reason>` line. This applies the same rule to the staged
# tree at commit time (GIT_INDEX_FILE is respected, so `--only` is judged as
# committed). A fragment naming the commit hash cannot exist yet; that form
# stays a push-time remedy.
set -u
msg=${1:?usage: check-commit-notes.sh MSGFILE}
# Only a repo that keeps changelog fragments runs the pushed-notes gate; elsewhere (jev,
# localbench, uds, zestroku, cfsios have no changelog.d) this member must never refuse.
git cat-file -e HEAD:changelog.d 2>/dev/null || exit 0

first=""
for path in $(git diff --cached --no-renames --name-only); do
	case "$path" in
		src/*|rules/*|scripts/*|extensions/*|installer/*) first=$path; break ;;
	esac
done
[ -n "$first" ] || exit 0

body=$(grep -v '^#' "$msg" || true)
waivers=$(printf '%s\n' "$body" | grep -c -E '^[[:space:]]*\[no-changelog\][[:space:]]*.+[^[:space:]]' || true)
if [ "$waivers" -gt 1 ]; then
	echo "commit-notes: REFUSED: this commit has multiple [no-changelog] reasons; the push gate will refuse it" >&2
	exit 1
fi
[ "$waivers" -eq 0 ] || exit 0

trailer='^[[:space:]]*Bead:[[:space:]]*[^[:space:]]+[[:space:]]*$'
beads=$(printf '%s\n' "$body" | grep -c -E "$trailer" || true)
if [ "$beads" -ne 1 ]; then
	echo "commit-notes: REFUSED: this commit touches shipped paths ($first) but has no single 'Bead: <id>' trailer or '[no-changelog] <reason>' line; the push gate will refuse it" >&2
	exit 1
fi
bead=$(printf '%s\n' "$body" | grep -E "$trailer" | head -n 1 | sed -e 's/^[[:space:]]*Bead:[[:space:]]*//' -e 's/[[:space:]]*$//')
slug=$(printf '%s' "$bead" | sed 's/.*-//')
for name in "$slug.md" "$bead.md"; do
	if git cat-file -e ":changelog.d/$name" 2>/dev/null || git cat-file -e "HEAD:changelog.d/$name" 2>/dev/null; then
		exit 0
	fi
done
echo "commit-notes: REFUSED: Bead: $bead has no changelog fragment staged or committed: changelog.d/$slug.md; the push gate will refuse it" >&2
exit 1
