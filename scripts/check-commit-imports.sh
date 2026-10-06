#!/bin/sh
# check-commit-imports.sh — FLY2-3 dangling-import gate (ompkit-uzgf).
# Usage: check-commit-imports.sh --repo DIR --base SHA --tip SHA
# Every non-merge commit in base..tip must import only files present in its
# own tree. Reads git objects only; the working tree is never touched.
# Refuses (exit 4) naming the first offending sha and path.
# Import extraction is line-oriented (lines over 2000 chars skipped) with
# exclusive classes, so no backtracking bomb on minified files.
set -u

REPO=""
BASE=""
TIP=""
while [ $# -gt 0 ]; do
	case "$1" in
		--repo) REPO=${2:-}; shift 2 ;;
		--base) BASE=${2:-}; shift 2 ;;
		--tip) TIP=${2:-}; shift 2 ;;
		--) shift; break ;;
		*) printf 'check-commit-imports: unknown argument %s\n' "$1" >&2; exit 2 ;;
	esac
done
 if [ -z "$REPO" ] || [ -z "$BASE" ] || [ -z "$TIP" ]; then printf 'check-commit-imports: --repo DIR --base SHA --tip SHA required\n' >&2; exit 2; fi

# Resolve a ./x or ../x spec against the importing file's directory.
resolve_spec() {
	dir=$1
	spec=$2
	case "$spec" in
		./*) printf '%s' "$dir/${spec#./}" ;;
		../*) printf '%s' "${dir%/*}/${spec#../}" ;;
		*) return 1 ;;
	esac
}

# All findings accumulate in $OUT (pipelines run in subshells, so no
# early return across a pipe); a non-empty file is the refusal.
check_commit() {
	sha=$1
	files=$(git -C "$REPO" diff-tree --root --no-commit-id --name-only -r --diff-filter=AM "$sha" -- '*.ts' '*.tsx' '*.mts' 2>/dev/null) || return 0
	[ -z "$files" ] && return 0
	printf '%s\n' "$files" | while IFS= read -r file; do
		[ -n "$file" ] || continue
		dir=${file%/*}
		[ "$dir" = "$file" ] && dir="."
		git -C "$REPO" show "$sha:$file" 2>/dev/null | awk 'length($0) < 2000' | grep -Eo "from[[:space:]]*['\"][.][^'\"]+['\"]|^import[[:space:]]*['\"][.][^'\"]+['\"]" 2>/dev/null | grep -Eo "['\"][.][^'\"]+['\"]" | tr -d "\"'" | sort -u | while IFS= read -r spec; do
			[ -n "$spec" ] || continue
			target=$(resolve_spec "$dir" "$spec") || continue
			found=""
			for candidate in "$target" "$target.ts" "$target.tsx" "$target.mts" "$target/index.ts"; do
				if git -C "$REPO" cat-file -e "$sha:$candidate" 2>/dev/null; then
					found=1
					break
				fi
			done
			if [ -z "$found" ]; then
				printf '%s imports missing %s (from %s)\n' "$sha" "$spec" "$file" >> "$OUT"
			fi
		done
	done
}

OUT=${TMPDIR:-$REPO/var/agent-tmp}/check-commit-imports.$$.out
mkdir -p "${OUT%/*}" || { printf 'check-commit-imports: cannot stage findings\n' >&2; exit 2; }
: > "$OUT"
trap 'rm -f "$OUT"' EXIT HUP INT TERM
for sha in $(git -C "$REPO" rev-list --no-merges "$BASE..$TIP" 2>/dev/null); do
	check_commit "$sha"
done
if [ -s "$OUT" ]; then
	head -5 "$OUT" >&2
	rm -f "$OUT"
	exit 4
fi
rm -f "$OUT"
exit 0
