#!/bin/sh
# doc-drift-check.sh — PUB1a doc-drift gate
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.106.1).
# A push that changes the CLI surface without touching its docs is refused,
# naming the undocumented surface. The surface is derived from the command
# registry (src/commands.ts COMMANDS export) at each revision via throwaway
# git worktrees — never from grep of source text. A pure-internal change
# (identical surface) passes quietly even with no doc change.
# Prints added surface lines; exit 1 on drift, 0 when clean.
# Usage: doc-drift-check.sh BASE HEAD [REPO]
set -u

fail() {
	printf 'doc-drift: %s\n' "$1" >&2
	exit 2
}
refuse() {
	printf 'doc-drift: %s\n' "$1" >&2
	exit 1
}

BASE=${1:-}
HEAD=${2:-}
REPO=${3:-.}
if [ -z "$BASE" ] || [ -z "$HEAD" ]; then
	fail "usage: doc-drift-check.sh BASE HEAD [REPO]"
fi
command -v git >/dev/null 2>&1 || fail "git is required"
command -v bun >/dev/null 2>&1 || fail "bun is required"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/doc-drift.XXXXXX") || fail "cannot create work dir"
trap 'rm -rf "$WORK"; git -C "$REPO" worktree prune 2>/dev/null' EXIT INT TERM

surface() {
	rev=$1
	out=$2
	git -C "$REPO" worktree add --detach --quiet "$WORK/$rev" "$rev" 2>/dev/null || fail "cannot materialize $rev"
	reg="$WORK/$rev/src/commands.ts"
	if [ ! -f "$reg" ]; then
		printf 'doc-drift: no registry at %s, skipping surface check\n' "$rev" >&2
		: > "$out"
		return 0
	fi
	# shellcheck disable=SC2016
	BUN_REG="$reg" bun -e '
const registry = await import(process.env.BUN_REG);
const walk = (commands, prefix) => {
  for (const command of commands ?? []) {
    const path = prefix ? `${prefix} ${command.name}` : command.name;
    for (const flag of command.flags ?? []) console.log(`${path}|flag:${flag.name}`);
    console.log(`${path}|usage:${command.usage ?? ""}`);
    walk(command.subcommands, path);
  }
};
walk(registry.COMMANDS, "");
' > "$out" 2>/dev/null || fail "cannot derive surface at $rev"
}

surface "$BASE" "$WORK/base.surface"
surface "$HEAD" "$WORK/head.surface"

sort -u "$WORK/base.surface" -o "$WORK/base.sorted"
sort -u "$WORK/head.surface" -o "$WORK/head.sorted"
added=$(comm -13 "$WORK/base.sorted" "$WORK/head.sorted") || true
if [ -z "$added" ]; then
	printf 'doc-drift: OK (no surface change)\n'
	exit 0
fi
docs_changed=$(git -C "$REPO" diff --name-only "$BASE" "$HEAD" -- docs/ 2>/dev/null | head -1) || true
if [ -n "$docs_changed" ]; then
	printf 'doc-drift: OK (surface changed, docs touched)\n'
	exit 0
fi
printf 'undocumented surface:\n%s\n' "$added" >&2
refuse "CLI surface changed with no docs/ change in $BASE..$HEAD"
