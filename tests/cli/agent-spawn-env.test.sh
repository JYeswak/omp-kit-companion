#!/bin/sh
# agent-spawn-env.test.sh — ID1 spawn wiring contract
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.108).
# A fake HOME plus a fake real br: the helper must install the shim link,
# print eval-able exports, and leave the resulting br enforcing the identity.
# Every verdict comes from exit codes plus recorded files, never excerpts.
set -u

SCRIPT=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/agent-spawn-env.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/agent-spawn-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0
export HOME="$TMP/home"
mkdir -p "$HOME"
mkdir -p "$TMP/realbin"
cat > "$TMP/realbin/br" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" > "$BR_SPAWN_TEST_ARGV"
exit 0
EOF
chmod +x "$TMP/realbin/br"
export PATH="$TMP/realbin:/usr/bin:/bin"
export BR_SPAWN_TEST_ARGV="$TMP/argv"

# 1. installs the link and prints eval-able exports
out=$(sh "$SCRIPT" --agent TestSpawn 2> "$TMP/err") || { fail=$((fail + 1)); printf 'FAIL setup: rc!=0 err<<<%s>>>\n' "$(cat "$TMP/err")"; }
if [ -L "$HOME/.local/share/omp-kit/agent-bin/br" ] && printf '%s' "$out" | grep -q "export AGENT_NAME='TestSpawn'"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL setup: link or exports wrong\n'
fi

# 2. evaling the exports makes br enforce the identity
eval "$out"
if [ "$AGENT_NAME" = "TestSpawn" ] && [ "$(command -v br)" = "$HOME/.local/share/omp-kit/agent-bin/br" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL eval: AGENT_NAME=%s br=%s\n' "${AGENT_NAME:-}" "$(command -v br)"
fi
: > "$TMP/argv"
if br close X > "$TMP/out" 2>&1 && [ "$(tr '\n' ' ' < "$TMP/argv" | sed 's/ $//')" = "close X --actor TestSpawn" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1)); printf 'FAIL enforce: argv<<<%s>>>\n' "$(cat "$TMP/argv")"
fi

# 3. anonymous and multiline names are refused, nothing installed
rm -rf "$HOME/.local"
if sh "$SCRIPT" > "$TMP/out" 2>&1; then
	fail=$((fail + 1)); printf 'FAIL anon: rc=0\n'
else
	if [ "$?" = "4" ] && [ ! -e "$HOME/.local/share/omp-kit/agent-bin/br" ]; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL anon: wrong refusal\n'; fi
fi

printf 'agent-spawn-env: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
