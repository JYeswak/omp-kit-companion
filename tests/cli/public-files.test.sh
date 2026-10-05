#!/bin/sh
# public-files.test.sh — PUB1e checker contract
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.106.5).
# Fixture checkouts with planted missing files and a complete set;
# every verdict comes from the checker's exit code plus its complete output.
set -u

CHECK=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/public-files-check.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/public-files-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0

mkfull() {
	repo=$1
	rm -rf "$repo"
	mkdir -p "$repo/.github/ISSUE_TEMPLATE"
	for file in SECURITY.md CONTRIBUTING.md CODEOWNERS .github/pull_request_template.md .github/dependabot.yml .github/ISSUE_TEMPLATE/bug.md; do
		printf '# neutral\n' > "$repo/$file"
	done
}

# 1. planted: deleting SECURITY.md makes the check report it
mkfull "$TMP/repo"
rm "$TMP/repo/SECURITY.md"
if sh "$CHECK" "$TMP/repo" > "$TMP/out" 2>&1; then
	fail=$((fail + 1)); printf 'FAIL planted: rc=0\n'
else
	got_rc=$?
	if [ "$got_rc" = "1" ] && grep -q "SECURITY.md" "$TMP/out"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL planted: rc=%s out<<<%s>>>\n' "$got_rc" "$(cat "$TMP/out")"; fi
fi

# 2. complete set passes
mkfull "$TMP/repo"
if sh "$CHECK" "$TMP/repo" > "$TMP/out" 2>&1; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL complete: rc!=0 out<<<%s>>>\n' "$(cat "$TMP/out")"
fi

# 3. Rust repo without deny config is reported; with it passes
mkfull "$TMP/rust"
printf '[package]\n' > "$TMP/rust/Cargo.toml"
if sh "$CHECK" "$TMP/rust" > "$TMP/out" 2>&1; then
	fail=$((fail + 1)); printf 'FAIL rust-missing: rc=0\n'
else
	if grep -q "deny.toml" "$TMP/out"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL rust-missing: no deny mention\n'; fi
fi
printf '# neutral\n' > "$TMP/rust/deny.toml"
if sh "$CHECK" "$TMP/rust" > "$TMP/out" 2>&1; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL rust-present: rc!=0\n'
fi

printf 'public-files: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
