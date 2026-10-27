#!/bin/sh
# Fake shellcheck for slice-verify tests: fails a file containing SC_EVIL.
# Maps the docker -v SRC:/archive:ro mount the verb passes back to a real path.
src=""
want=""
prev=""
for arg in "$@"; do
	if [ "$prev" = "-v" ]; then
		src="${arg%%:*}"
		prev=""
		continue
	fi
	case "$arg" in
		-v) prev="-v" ;;
		/archive/*) want="$arg" ;;
	esac
done
rel="${want#/archive/}"
if [ -n "$rel" ] && [ -n "$src" ] && grep -q SC_EVIL "$src/$rel" 2>/dev/null; then
	echo "SC_EVIL planted finding in $rel"
	exit 1
fi
exit 0
