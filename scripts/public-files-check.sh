#!/bin/sh
# public-files-check.sh — PUB1e standard public files check
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.106.5).
# Lists standard public files missing from a repo checkout: SECURITY.md,
# CONTRIBUTING.md, CODEOWNERS, issue and PR templates, dependabot config,
# plus cargo-deny config where the repo is Rust (Cargo.toml present).
# Prints missing paths; exit 1 when any are missing, 0 when complete.
# Usage: public-files-check.sh [REPO]
set -u

ROOT=${1:-.}

missing=""
report() {
	if [ -e "$ROOT/$1" ]; then
		return 0
	fi
	missing="${missing}${missing:+ }$1"
	return 1
}

report SECURITY.md
report CONTRIBUTING.md
report CODEOWNERS
report .github/pull_request_template.md
report .github/dependabot.yml
issue_templates=$(find "$ROOT/.github/ISSUE_TEMPLATE" -maxdepth 1 -name '*.md' -o -maxdepth 1 -name '*.yml' 2>/dev/null | head -1) || true
if [ -z "$issue_templates" ]; then
	missing="${missing}${missing:+ }.github/ISSUE_TEMPLATE/"
fi
if [ -e "$ROOT/Cargo.toml" ] && [ ! -e "$ROOT/deny.toml" ] && [ ! -e "$ROOT/.cargo/deny.toml" ]; then
	missing="${missing}${missing:+ }deny.toml (Rust repo)"
fi

if [ -z "$missing" ]; then
	printf 'public-files: OK\n'
	exit 0
fi
printf 'public-files: MISSING %s\n' "$missing" >&2
exit 1
