#!/bin/sh
# doc-status.test.sh — PUB1b gate contract
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.106.2).
# Builds fixture doc trees; every verdict comes from the checker's exit code
# plus its complete output. Planted: a dangling superseded-by is RED.
set -u

CHECK=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/doc-status-check.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/doc-status-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0
check() {
	desc=$1
	shift
	if "$@" >/dev/null 2>&1; then
		pass=$((pass + 1))
	else
		printf 'FAIL: %s\n' "$desc"
		fail=$((fail + 1))
	fi
}
check_fail() {
	desc=$1
	shift
	if "$@" >/dev/null 2>&1; then
		printf 'FAIL (expected refusal): %s\n' "$desc"
		fail=$((fail + 1))
	else
		pass=$((pass + 1))
	fi
}

front() {
	status=$1
	target=$2
	printf -- '---\nstatus: %s\n' "$status"
	if [ -n "$target" ]; then
		printf 'superseded-by: %s\n' "$target"
	fi
	printf -- '---\n\n# Doc\n'
}

mktree() {
	name=$1
	repo="$TMP/$name"
	rm -rf "$repo"
	mkdir -p "$repo/docs"
	printf '%s' "$repo"
}

# Clean tree: current root + docs, one draft, one linked superseded pair.
repo=$(mktree clean)
front current "" > "$repo/README.md"
front current "" > "$repo/docs/usage.md"
front draft "" > "$repo/docs/plan.md"
front superseded "docs/usage.md" > "$repo/docs/old.md"
check "clean tree passes" sh "$CHECK" "$repo"

# Missing status is RED.
repo=$(mktree missing)
printf '# No front matter\n' > "$repo/docs/bare.md"
check_fail "missing status refused" sh "$CHECK" "$repo"

# Dangling superseded-by is RED (planted).
repo=$(mktree dangling)
front superseded "docs/gone.md" > "$repo/docs/old.md"
if sh "$CHECK" "$repo" 2>&1 | grep -q "points nowhere"; then
	pass=$((pass + 1))
else
	printf 'FAIL (dangling target unnamed): dangling superseded-by\n'
	fail=$((fail + 1))
fi

# Superseded without a target is RED.
repo=$(mktree notarget)
front superseded "" > "$repo/docs/old.md"
check_fail "targetless superseded refused" sh "$CHECK" "$repo"

# Index regenerates deterministically: twice, no diff, superseded grouped.
repo=$(mktree index)
front current "" > "$repo/README.md"
front draft "" > "$repo/docs/plan.md"
front superseded "docs/plan.md" > "$repo/docs/old.md"
check "index run passes" sh "$CHECK" "$repo" --index
cp "$repo/docs/INDEX.md" "$TMP/once.md"
check "index rerun passes" sh "$CHECK" "$repo" --index
if cmp -s "$TMP/once.md" "$repo/docs/INDEX.md"; then
	pass=$((pass + 1))
else
	printf 'FAIL (index not idempotent)\n'
	fail=$((fail + 1))
fi
if grep -q "## Superseded" "$repo/docs/INDEX.md" && grep -q "old.md -> docs/plan.md" "$repo/docs/INDEX.md"; then
	pass=$((pass + 1))
else
	printf 'FAIL (superseded group missing)\n'
	fail=$((fail + 1))
fi

printf 'doc-status gate: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
