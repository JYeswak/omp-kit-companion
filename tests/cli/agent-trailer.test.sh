#!/bin/sh
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
# agent-trailer.test.sh — ID1 commit trailer contract
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.108; foreign-trailer refusal
# ompkit-fp72.99). Drives the hook body directly plus real git commits through
# an installed hooks.d chain; every verdict comes from exit codes and file
# contents.
set -u

SCRIPTS=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)
HOOK=$SCRIPTS/agent-trailer-hook.sh
INSTALLER=$SCRIPTS/install-agent-trailer-hook.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
. "$SCRIPTS/kitlib-tmp.sh"
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP agent-trailer-test || exit 1

pass=0
fail=0

# 1. trailer appended from AGENT_NAME
printf 'subject line\n' > "$TMP/msg"
AGENT_NAME=TrailerTest sh "$HOOK" "$TMP/msg"
if grep -q "^Agent: TrailerTest$" "$TMP/msg"; then pass=$((pass + 1));
else fail=$((fail + 1)); printf 'FAIL append\n'; fi

# 2. a trailer that already names the bound caller is accepted untouched,
# including surrounding whitespace and a differently cased key
for body in 'Agent: TrailerTest' '  agent:   TrailerTest  '; do
	printf 'subject\n\n%s\n' "$body" > "$TMP/msg"
	cp "$TMP/msg" "$TMP/msg.orig"
	AGENT_NAME=TrailerTest sh "$HOOK" "$TMP/msg"; rc=$?
	if [ "$rc" = "0" ] && cmp -s "$TMP/msg" "$TMP/msg.orig"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL matching [%s] rc=%s\n' "$body" "$rc"; fi
done

# 3. a trailer naming anyone else is refused with a named failure and the
# message is left as written; a near-miss is a different identity
for foreign in 'SomeoneElse' 'TrailerTest2' 'TrailerTes' 'trailertest'; do
	printf 'subject\n\nAgent: %s\n' "$foreign" > "$TMP/msg"
	cp "$TMP/msg" "$TMP/msg.orig"
	err=$(AGENT_NAME=TrailerTest sh "$HOOK" "$TMP/msg" 2>&1); rc=$?
	case "$err" in *AGENT_TRAILER_MISMATCH*"$foreign"*TrailerTest*) named=1 ;; *) named=0 ;; esac
	if [ "$rc" != "0" ] && [ "$named" = "1" ] && cmp -s "$TMP/msg" "$TMP/msg.orig"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL foreign [%s] rc=%s named=%s err=%s\n' "$foreign" "$rc" "$named" "$err"; fi
done

# 4. more than one Agent trailer is ambiguous and refused, even when every
# value names the caller
while read -r first second; do
	printf 'subject\n\nAgent: %s\nAgent: %s\n' "$first" "$second" > "$TMP/msg"
	cp "$TMP/msg" "$TMP/msg.orig"
	err=$(AGENT_NAME=TrailerTest sh "$HOOK" "$TMP/msg" 2>&1); rc=$?
	case "$err" in *AGENT_TRAILER_AMBIGUOUS*) named=1 ;; *) named=0 ;; esac
	if [ "$rc" != "0" ] && [ "$named" = "1" ] && cmp -s "$TMP/msg" "$TMP/msg.orig"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL ambiguous [%s %s] rc=%s named=%s\n' "$first" "$second" "$rc" "$named"; fi
done <<'EOF'
TrailerTest TrailerTest
TrailerTest SomeoneElse
SomeoneElse TrailerTest
EOF

# 5. no identity leaves the message untouched (never invents one), with or
# without an existing trailer, and judges nothing
printf 'subject line\n' > "$TMP/msg"
env -u AGENT_NAME sh "$HOOK" "$TMP/msg"
if [ "$(cat "$TMP/msg")" = "subject line" ]; then pass=$((pass + 1));
else fail=$((fail + 1)); printf 'FAIL anon\n'; fi
printf 'subject\n\nAgent: SomeoneElse\n' > "$TMP/msg"
cp "$TMP/msg" "$TMP/msg.orig"
env -u AGENT_NAME sh "$HOOK" "$TMP/msg"; rc=$?
if [ "$rc" = "0" ] && cmp -s "$TMP/msg" "$TMP/msg.orig"; then pass=$((pass + 1));
else fail=$((fail + 1)); printf 'FAIL anon existing rc=%s\n' "$rc"; fi

# 6. real commits in an owned disposable repository through the installed
# hooks.d chain: the installer is the real one, run from the repository it
# installs into
repo="$TMP/repo"
hooks="$repo/.git/hooks"
mkdir -p "$repo/scripts"
git init -q --template= "$repo"
git -C "$repo" config user.email "test@example.invalid"
git -C "$repo" config user.name "worker-1"
git -C "$repo" config core.hooksPath "$hooks"
mkdir -p "$hooks/hooks.d/prepare-commit-msg"
cp "$HOOK" "$INSTALLER" "$repo/scripts/"
# The chain runner contract: every executable NN-<name> member of
# hooks.d/<type> runs in sort order and any failure fails the hook.
cat > "$hooks/prepare-commit-msg" <<'EOF'
#!/bin/sh
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
rc=0
for hook in "$here"/hooks.d/prepare-commit-msg/[0-9][0-9]-*; do
	[ -x "$hook" ] || continue
	sh "$hook" "$@" || rc=$?
done
exit $rc
EOF
chmod +x "$hooks/prepare-commit-msg"
# another chain member proves the rest of the chain keeps running
printf '#!/bin/sh\nprintf ran >> "%s/other-hook.marker"\n' "$TMP" > "$hooks/hooks.d/prepare-commit-msg/10-other"
chmod +x "$hooks/hooks.d/prepare-commit-msg/10-other"
sh "$repo/scripts/install-agent-trailer-hook.sh" > "$TMP/install.out" 2>&1
if [ -x "$hooks/hooks.d/prepare-commit-msg/30-omp-kit-agent-trailer" ]; then pass=$((pass + 1));
else fail=$((fail + 1)); printf 'FAIL install\n'; cat "$TMP/install.out"; fi

# 6a. a commit with no trailer carries exactly one, naming the caller
AGENT_NAME=TrailerLive git -C "$repo" commit -q --allow-empty -m "[test] trailer live"
if [ "$(git -C "$repo" log -1 --format=%B | grep -c "^Agent: TrailerLive$")" = "1" ] \
	&& [ "$(git -C "$repo" log -1 --format=%B | grep -ci "^Agent:")" = "1" ]; then pass=$((pass + 1));
else fail=$((fail + 1)); printf 'FAIL live append\n'; fi

# 6b. a message that already names the caller is accepted once, not doubled
printf '[test] typed\n\nAgent: TrailerLive\n' > "$TMP/typed"
AGENT_NAME=TrailerLive git -C "$repo" commit -q --allow-empty -F "$TMP/typed"
if [ "$(git -C "$repo" log -1 --format=%B | grep -ci "^Agent:")" = "1" ]; then pass=$((pass + 1));
else fail=$((fail + 1)); printf 'FAIL live matching\n'; fi

# 6c. foreign and ambiguous trailers refuse the commit and leave the branch alone
tip=$(git -C "$repo" rev-parse HEAD)
for body in 'Agent: SomeoneElse' 'Agent: TrailerLive
Agent: TrailerLive'; do
	printf '[test] refused\n\n%s\n' "$body" > "$TMP/refused"
	err=$(AGENT_NAME=TrailerLive git -C "$repo" commit -q --allow-empty -F "$TMP/refused" 2>&1); rc=$?
	case "$err" in *AGENT_TRAILER_MISMATCH* | *AGENT_TRAILER_AMBIGUOUS*) named=1 ;; *) named=0 ;; esac
	if [ "$rc" != "0" ] && [ "$named" = "1" ] && [ "$(git -C "$repo" rev-parse HEAD)" = "$tip" ]; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL live refused rc=%s named=%s\n' "$rc" "$named"; fi
done

# 6d. the other chain member ran for the accepted and the refused commits
if [ "$(cat "$TMP/other-hook.marker" 2>/dev/null)" = "ranranranran" ]; then pass=$((pass + 1));
else fail=$((fail + 1)); printf 'FAIL chain members: %s\n' "$(cat "$TMP/other-hook.marker" 2>/dev/null)"; fi

printf 'agent-trailer: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
