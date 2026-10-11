#!/bin/sh
# check-pushed-notes.sh -- release-notes coverage for a pushed range.
#
# Usage: check-pushed-notes.sh --repo DIR --base SHA --tip SHA --archive-dir DIR
#
# For every single-parent commit in BASE..TIP touching shipped paths
# (src/|rules/|scripts/|extensions/|installer/), require one of: a single
# `Bead:` trailer with a matching changelog.d fragment, a `[no-changelog]`
# reason, or a fragment naming `(commit <short>)`. Merge commits are out of
# scope (first-parent walk). Fragments come from the candidate archive tree.
set -eu

REPO=
BASE=
TIP=
ARCHIVE_DIR=
while [ "$#" -gt 0 ]; do
	case "$1" in
		--repo) REPO=$2; shift 2 ;;
		--base) BASE=$2; shift 2 ;;
		--tip) TIP=$2; shift 2 ;;
		--archive-dir) ARCHIVE_DIR=$2; shift 2 ;;
		-h|--help) echo "usage: check-pushed-notes.sh --repo DIR --base SHA --tip SHA --archive-dir DIR" >&2; exit 0 ;;
		*) echo "usage: check-pushed-notes.sh --repo DIR --base SHA --tip SHA --archive-dir DIR" >&2; exit 2 ;;
	esac
done
[ -n "$REPO" ] && [ -n "$BASE" ] && [ -n "$TIP" ] && [ -n "$ARCHIVE_DIR" ] || {
	echo "usage: check-pushed-notes.sh --repo DIR --base SHA --tip SHA --archive-dir DIR" >&2
	exit 2
}

fragments=$(mktemp -d "$ARCHIVE_DIR/../pushed-notes.XXXXXX") || exit 1
trap 'rm -rf "$fragments"' EXIT HUP INT TERM
found=0
for frag in "$ARCHIVE_DIR"/changelog.d/*.md; do
	[ -f "$frag" ] || continue
	found=1
	cp "$frag" "$fragments/"
done
[ "$found" -eq 1 ] || {
	echo "notes coverage: no changelog.d fragments in candidate tree" >&2
	exit 1
}

fail=0
for hash in $(git -C "$REPO" rev-list --first-parent "$BASE..$TIP"); do
	parents=$(git -C "$REPO" rev-list --parents -n 1 "$hash" | wc -w)
	if [ "$parents" -ne 2 ]; then
		continue
	fi
	short=$(printf '%s' "$hash" | cut -c1-7)
	changed=$(git -C "$REPO" diff-tree --no-commit-id --no-renames --name-only -r "$hash")
	shipped=0
	for path in $changed; do
		case "$path" in
			src/*|rules/*|scripts/*|extensions/*|installer/*) shipped=1; break ;;
		esac
	done
	[ "$shipped" -eq 1 ] || continue
	body=$(git -C "$REPO" log --format=%B -n 1 "$hash")
	subject=$(printf '%s' "$body" | head -n 1)
	case "$subject" in
		*"(#"[0-9]*")")
			pr=$(printf '%s' "$subject" | sed -n 's/.*(#\([0-9][0-9]*\))$/\1/p')
			if grep -rl "(#$pr)" "$fragments" >/dev/null 2>&1; then
				echo "notes coverage: $short squash PR #$pr named by fragment"
				continue
			fi
			;;
	esac
	waivers=$(printf '%s' "$body" | grep -c -E '^[[:space:]]*\[no-changelog\][[:space:]]*.+[^[:space:]]' || true)
	if [ "$waivers" -gt 1 ]; then
		echo "notes coverage: $short has multiple [no-changelog] reasons" >&2
		fail=1
		continue
	fi
	if [ "$waivers" -eq 1 ]; then
		echo "notes coverage: $short covered by [no-changelog]"
		continue
	fi
	if grep -rl "(commit $short)" "$fragments" >/dev/null 2>&1; then
		echo "notes coverage: $short named by fragment"
		continue
	fi
	beads=$(printf '%s' "$body" | grep -c -E '^[[:space:]]*Bead:[[:space:]]*[^[:space:]]+[[:space:]]*$' || true)
	if [ "$beads" -ne 1 ]; then
		echo "notes coverage: $short touches shipped paths but has no Bead: trailer, [no-changelog] reason, or naming fragment" >&2
		fail=1
		continue
	fi
	bead=$(printf '%s' "$body" | grep -E '^[[:space:]]*Bead:[[:space:]]*[^[:space:]]+[[:space:]]*$' | head -n 1 | sed -e 's/^[[:space:]]*Bead:[[:space:]]*//' -e 's/[[:space:]]*$//')
	slug=$(printf '%s' "$bead" | sed 's/.*-//')
	if [ ! -f "$fragments/$slug.md" ] && [ ! -f "$fragments/$bead.md" ]; then
		echo "notes coverage: $short (Bead: $bead) has no changelog fragment: changelog.d/$slug.md" >&2
		fail=1
		continue
	fi
	echo "notes coverage: $short covered by Bead: $bead"
done
exit "$fail"
