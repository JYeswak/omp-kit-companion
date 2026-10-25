#!/bin/sh
# check-pushed-notes.sh -- release-notes coverage for a pushed range.
#
# Usage: check-pushed-notes.sh --repo DIR [--base SHA] --tip SHA --archive-dir DIR
#
# Validate candidate fragment grammar, then use the same immutable-range
# coverage checker as release. Folded references and direct-commit provenance
# must not have a second, divergent interpretation in the push hook.
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
		-h|--help) echo "usage: check-pushed-notes.sh --repo DIR [--base SHA] --tip SHA --archive-dir DIR" >&2; exit 0 ;;
		*) echo "usage: check-pushed-notes.sh --repo DIR [--base SHA] --tip SHA --archive-dir DIR" >&2; exit 2 ;;
	esac
done
if [ -z "$REPO" ] || [ -z "$TIP" ] || [ -z "$ARCHIVE_DIR" ]; then
	echo "usage: check-pushed-notes.sh --repo DIR [--base SHA] --tip SHA --archive-dir DIR" >&2
	exit 2
fi
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd -P)
if [ -z "$BASE" ]; then
	source_sha=$(git -C "$REPO" rev-parse --verify --end-of-options "$TIP^{commit}") || exit 1
	repository=$(cd "$REPO" && GH_REPO='' gh repo view --json nameWithOwner --jq .nameWithOwner) || exit 1
	BASE=$(cd "$REPO" && python3 "$SCRIPT_DIR/release_reuse.py" notes-floor --repository "$repository" --source-sha "$source_sha") || exit 1
	printf 'notes coverage: remote base absent; checking from published ancestor %s\n' "$BASE"
fi


# shellcheck source=scripts/kitlib-tmp.sh
. "$SCRIPT_DIR/kitlib-tmp.sh"
KITLIB_TMP_ROOT=$ARCHIVE_DIR/..
scratch='' # assigned by kitlib_tmp via eval
kitlib_tmp scratch pushed-notes || exit 1
validation="$scratch/validation"
mkdir -p "$validation/changelog.d"
cp "$ARCHIVE_DIR/CHANGELOG.md" "$validation/CHANGELOG.md"
# Validation owns a different repository; never let hook selectors redirect it.
git_redirects='GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES'
# shellcheck disable=SC2086
(unset $git_redirects; git -C "$validation" init -q)
for frag in "$ARCHIVE_DIR"/changelog.d/*.md; do
	[ -f "$frag" ] || continue
	cp "$frag" "$validation/changelog.d/"
done
# shellcheck disable=SC2086
if ! (unset $git_redirects; cd "$validation" && sh "$SCRIPT_DIR/release-notes.sh" fold >/dev/null); then
	echo "notes validation: candidate changelog fragments are not promotable" >&2
	exit 1
fi

(cd "$REPO" && sh "$SCRIPT_DIR/release-notes.sh" check --base-ref "$BASE" --head "$TIP")
