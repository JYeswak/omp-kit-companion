#!/bin/sh
# derived-check.test.sh — DERIVE1 checker contract
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.119).
# Fixture config files with planted literal facts and quiet controls;
# every verdict comes from the checker's exit code plus its complete output.
set -u

CHECK=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/derived-check.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/derived-check-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0

# 1. planted version, path, count and pid facts all go RED with their probes
cat > "$TMP/bad.toml" <<'EOF'
omp_version = "18.6.1"
install_path = "/Users/josh/.local/opt/omp-kit"
profiles = 17
owner_pid = 9289
EOF
if sh "$CHECK" "$TMP/bad.toml" > "$TMP/out" 2>&1; then
	fail=$((fail + 1)); printf 'FAIL planted: rc=0\n'
else
	got_rc=$?
	out=$(cat "$TMP/out")
	found=0
	for want in "version: probe omp --version" "path: probe live enumeration" "count: probe live count" "pid: probe live process state"; do
		printf '%s' "$out" | grep -q "$want" || { fail=$((fail + 1)); printf 'FAIL planted: missing %s\n' "$want"; found=1; }
	done
	if [ "$got_rc" = "1" ] && [ "$found" = "0" ]; then pass=$((pass + 1));
	elif [ "$found" = "0" ]; then fail=$((fail + 1)); printf 'FAIL planted: rc=%s\n' "$got_rc"; fi
fi

# 2. decisions with reasons and probe calls stay quiet
cat > "$TMP/good.toml" <<'EOF'
max_parallel = 4 # decision: keep load under half the cores, 2026-10-05 SandyLake
current = "$(omp --version)"
profiles = 17 # reason: dashboard snapshot for humans, refreshed by probe
rapid = 5
EOF
if sh "$CHECK" "$TMP/good.toml" > "$TMP/out" 2>&1; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL quiet: rc!=0 out<<<%s>>>\n' "$(cat "$TMP/out")"
fi

# 3. no files fails closed with usage
if sh "$CHECK" > "$TMP/out" 2>&1; then
	fail=$((fail + 1)); printf 'FAIL no-args: rc=0\n'
else
	got_rc=$?
	if [ "$got_rc" = "2" ]; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL no-args: rc=%s\n' "$got_rc"; fi
fi

printf 'derived-check: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
