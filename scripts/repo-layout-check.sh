#!/bin/sh
# repo-layout-check.sh — PUB1f standard layout check
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.106.6).
# Reports deviations from the standard repo layout (docs/repo-layout.md) as
# WARN findings: missing src, tests, scripts or docs dirs, missing docs/adr,
# and a var/agent-tmp dir that is not gitignored. Without --strict the command
# exits 0; with --strict any deviation exits 1.
# Usage: repo-layout-check.sh [--strict] [REPO]
set -u

STRICT=0
if [ "${1:-}" = "--strict" ]; then
	STRICT=1
	shift
fi
ROOT=${1:-.}

warn() {
	printf 'layout: WARN %s\n' "$1" >&2
}

findings=0
for dir in src tests scripts docs docs/adr; do
	if [ ! -d "$ROOT/$dir" ]; then
		warn "missing dir $dir"
		findings=$((findings + 1))
	fi
done
if [ -d "$ROOT/var/agent-tmp" ]; then
	# Repo-local declaration only: the operator global gitignore also hides
	# scratch, but the repo must declare it itself.
	if grep -qE '(^|/)var/agent-tmp/?$|(^|/)agent-tmp/?$|(^|/)var/?$' "$ROOT/.gitignore" 2>/dev/null; then
		:
	else
		warn "var/agent-tmp exists but is not gitignored"
		findings=$((findings + 1))
	fi
fi

if [ "$findings" = "0" ]; then
	printf 'layout: OK\n'
	exit 0
fi
if [ "$STRICT" = "1" ]; then
	printf 'layout: FAIL (%s deviation(s))\n' "$findings" >&2
	exit 1
fi
printf 'layout: OK with %s WARN finding(s)\n' "$findings"
