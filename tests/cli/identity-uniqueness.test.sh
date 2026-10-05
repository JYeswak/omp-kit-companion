#!/bin/sh
# identity-uniqueness.test.sh — ID1 uniqueness contract
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.108).
# A stub tmux serves canned pane lists; fixture identity dirs carry planted
# files. Every verdict comes from exit codes plus complete output.
set -u

CHECK=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/identity-uniqueness-check.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/identity-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0
mkdir -p "$TMP/bin"
cat > "$TMP/bin/tmux" <<'EOF'
#!/bin/sh
printf '%s' "$TMUX_PANES"
EOF
chmod +x "$TMP/bin/tmux"

# 1. planted: two live panes, one name
mkdir -p "$TMP/d1"
printf '{"name":"SharedName"}' > "$TMP/d1/101"
printf '{"name":"SharedName"}' > "$TMP/d1/102"
TMUX_PANES='s 0 0 %101
s 0 1 %102'
export TMUX_PANES
if sh "$CHECK" --identity-dir "$TMP/d1" --tmux-bin "$TMP/bin/tmux" > "$TMP/out" 2>&1; then
	fail=$((fail + 1)); printf 'FAIL shared: rc=0\n'
else
	if grep -q "identity: shared-name SharedName on live panes %101 %102" "$TMP/out"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL shared: wrong output\n'; fi
fi

# 2. planted: live pane with no file
mkdir -p "$TMP/d2"
printf '{"name":"OnlyName"}' > "$TMP/d2/101"
TMUX_PANES='s 0 0 %101
s 0 1 %103'
export TMUX_PANES
if sh "$CHECK" --identity-dir "$TMP/d2" --tmux-bin "$TMP/bin/tmux" > "$TMP/out" 2>&1; then
	fail=$((fail + 1)); printf 'FAIL nofile: rc=0\n'
else
	if grep -q "identity: no-file live pane %103" "$TMP/out"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL nofile: wrong output\n'; fi
fi

# 3. planted: file naming a dead agent
mkdir -p "$TMP/d3"
printf '{"name":"DeadAgent"}' > "$TMP/d3/199"
printf '{"name":"LiveAgent"}' > "$TMP/d3/101"
TMUX_PANES='s 0 0 %101'
export TMUX_PANES
if sh "$CHECK" --identity-dir "$TMP/d3" --tmux-bin "$TMP/bin/tmux" > "$TMP/out" 2>&1; then
	fail=$((fail + 1)); printf 'FAIL stale: rc=0\n'
else
	if grep -q "identity: stale-file 199 names DeadAgent, pane not live" "$TMP/out"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL stale: wrong output\n'; fi
fi

# 4. distinct names, all live with files: clean
mkdir -p "$TMP/d4"
printf '{"name":"AgentA"}' > "$TMP/d4/101"
printf '{"name":"AgentB"}' > "$TMP/d4/omp-test-0-1"
TMUX_PANES='s 0 0 %101
omp-test 0 1 %777'
export TMUX_PANES
if sh "$CHECK" --identity-dir "$TMP/d4" --tmux-bin "$TMP/bin/tmux" > "$TMP/out" 2>&1; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL clean: rc!=0 out<<<%s>>>\n' "$(cat "$TMP/out")"
fi

printf 'identity-uniqueness: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
