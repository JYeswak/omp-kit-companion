#!/bin/sh
# doc-drift.test.sh — PUB1a gate contract
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.106.1).
# Builds fixture git repos with a minimal command registry at two revisions;
# every verdict comes from the checker's exit code plus its complete output.
set -u

CHECK=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/doc-drift-check.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/doc-drift-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0

mkregistry() {
	dir=$1
	shift
	mkdir -p "$dir/src"
	cat > "$dir/src/commands.ts" <<EOF
export const COMMANDS = [
  { name: "status", usage: "status", flags: [] }$(printf '%b' "$1")
];
EOF
}

mkrepo() {
	name=$1
	extra=$2
	docs=$3
	repo="$TMP/$name"
	rm -rf "$repo"
	mkdir -p "$repo"
	git -C "$repo" init -q
	git -C "$repo" config user.email "test@example.invalid"
	git -C "$repo" config user.name "worker-1"
	mkregistry "$repo" ""
	git -C "$repo" add -A
	git -C "$repo" commit -qm "[test] base fixture"
	mkregistry "$repo" "$extra"
	if [ "$docs" = "docs" ]; then
		mkdir -p "$repo/docs"
		printf '# new flag\n' > "$repo/docs/usage.md"
	elif [ "$docs" = "internal" ]; then
		printf '# internal refactor note\n' > "$repo/notes.txt"
	fi
	git -C "$repo" add -A
	git -C "$repo" commit -qm "[test] head fixture"
	printf '%s' "$repo"
}

# 1. planted: new flag, no doc change -> refused naming the surface
repo=$(mkrepo planted ',\n  { name: "serve", usage: "serve [--port PORT]", flags: [{ name: "--port" }] }' nodocs)
if sh "$CHECK" HEAD~1 HEAD "$repo" > "$TMP/out" 2>&1; then
	fail=$((fail + 1)); printf 'FAIL planted: rc=0\n'
else
	got_rc=$?
	if [ "$got_rc" = "1" ] && grep -q "serve|flag:--port" "$TMP/out"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL planted: rc=%s out<<<%s>>>\n' "$got_rc" "$(cat "$TMP/out")"; fi
fi

# 2. same surface change with a doc change -> passes
repo=$(mkrepo documented ',\n  { name: "serve", usage: "serve [--port PORT]", flags: [{ name: "--port" }] }' docs)
if sh "$CHECK" HEAD~1 HEAD "$repo" > "$TMP/out" 2>&1; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL documented: rc=%s\n' "$(cat "$TMP/out")"
fi

# 3. pure-internal change (identical surface) with no docs -> quiet
repo=$(mkrepo internal '' internal)
if sh "$CHECK" HEAD~1 HEAD "$repo" > "$TMP/out" 2>&1; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL internal: rc=%s\n' "$(cat "$TMP/out")"
fi

printf 'doc-drift: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
