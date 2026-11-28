#!/bin/sh
# stamp-release-line.sh -- rewrite the generated release line in README.md.
#
# A versionless latest-release link already points to the published release;
# never overwrite it. Historical source trees still carry numeric blocks.
#
# Usage: sh scripts/stamp-release-line.sh --version X.Y.Z [--readme PATH]
# Exit 0 stamped (or already exact), 1 misuse/missing markers, 2 bad version.
set -eu

VERSION=""
README=""
while [ "$#" -gt 0 ]; do
	case "$1" in
		--version) VERSION=${2:-}; shift 2 ;;
		--readme) README=${2:-}; shift 2 ;;
		*) echo "usage: stamp-release-line.sh --version X.Y.Z [--readme PATH]" >&2; exit 1 ;;
	esac
done
case "$VERSION" in
	''|*[!0-9.]*|.*|*.|*..*) echo "stamp-release-line: --version must be X.Y.Z" >&2; exit 2 ;;
esac
if ! printf '%s' "$VERSION" | grep -qE '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
	echo "stamp-release-line: --version must be X.Y.Z (got $VERSION)" >&2; exit 2
fi
if [ -z "$README" ]; then
	README=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)/README.md
fi
[ -f "$README" ] || { echo "stamp-release-line: no README at $README" >&2; exit 1; }

START="<!-- kit-release:start -->"
END="<!-- kit-release:end -->"
LINE="Current release: v$VERSION"
if ! grep -qF "$START" "$README"; then echo "stamp-release-line: start marker missing in $README; re-add the $START / $END block (Bead: ompkit-fp72.135.1.6) and retry" >&2; exit 1; fi
if ! grep -qF "$END" "$README"; then echo "stamp-release-line: end marker missing in $README; re-add the $START / $END block (Bead: ompkit-fp72.135.1.6) and retry" >&2; exit 1; fi

# Check the block itself, not a copy of the link elsewhere in the document.
if [ "$(awk -v start="$START" -v end="$END" '
	$0 == end   { inblock = 0 }
	inblock && NF { print }
	$0 == start { inblock = 1 }
' "$README")" = '[Latest release](https://github.com/JYeswak/omp-kit-companion/releases/latest)' ]; then
	echo "stamp-release-line: latest release link stays unchanged in $README"
	exit 0
fi

# shellcheck source=scripts/kitlib-tmp.sh
. "$(dirname -- "$0")/kitlib-tmp.sh"
work='' # assigned by kitlib_tmp via eval
kitlib_tmp work stamp-release-line
tmp=$work/readme
awk -v start="$START" -v end="$END" -v line="$LINE" '
	index($0, start) { inblock = 1; print; print line; next }
	index($0, end) { inblock = 0; print; next }
	!inblock { print }
' "$README" > "$tmp"
if cmp -s "$tmp" "$README"; then
	echo "stamp-release-line: already $LINE in $README"
else
	cat "$tmp" > "$README"
	echo "stamp-release-line: stamped $LINE in $README"
fi
kitlib_tmp_cleanup "$work"
