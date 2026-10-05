#!/bin/sh
# agent-trailer.test.sh — ID1 commit trailer contract
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.108).
# Drives the hook body directly plus a real git commit through it;
# every verdict comes from exit codes and file contents.
set -u

HOOK=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/agent-trailer-hook.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/agent-trailer-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0

# 1. trailer appended from AGENT_NAME
printf 'subject line\n' > "$TMP/msg"
AGENT_NAME=TrailerTest sh "$HOOK" "$TMP/msg"
if grep -q "^Agent: TrailerTest$" "$TMP/msg"; then pass=$((pass + 1));
else fail=$((fail + 1)); printf 'FAIL append\n'; fi

# 2. existing trailer untouched
printf 'subject\n\nAgent: SomeoneElse\n' > "$TMP/msg"
AGENT_NAME=TrailerTest sh "$HOOK" "$TMP/msg"
if [ "$(grep -c "^Agent:" "$TMP/msg")" = "1" ]; then pass=$((pass + 1));
else fail=$((fail + 1)); printf 'FAIL existing\n'; fi

# 3. no identity leaves the message untouched
printf 'subject line\n' > "$TMP/msg"
env -u AGENT_NAME sh "$HOOK" "$TMP/msg"
if [ "$(cat "$TMP/msg")" = "subject line" ]; then pass=$((pass + 1));
else fail=$((fail + 1)); printf 'FAIL anon\n'; fi

# 4. real commit through the installed hook carries the trailer
repo="$TMP/repo"
mkdir -p "$repo"
git -C "$repo" init -q
git -C "$repo" config user.email "test@example.invalid"
git -C "$repo" config user.name "worker-1"
mkdir -p "$repo/.git/hooks"
cp "$HOOK" "$repo/.git/hooks/prepare-commit-msg"
printf 'x\n' > "$repo/f.txt"
git -C "$repo" add f.txt
AGENT_NAME=TrailerLive git -C "$repo" commit -qm "[test] trailer live" --no-verify 2>/dev/null
if git -C "$repo" log -1 --format=%B | grep -q "^Agent: TrailerLive$"; then pass=$((pass + 1));
else
	fail=$((fail + 1)); printf 'FAIL live\n'
fi

printf 'agent-trailer: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
