#!/bin/sh
# install-commit-msg-bead.test.sh — COMMIT1 installer contract (ompkit-2w7h).
# Fixture repos: one with no commit-msg hook, one with a plain bash hook.
# Asserts dispatcher creation, bespoke preservation + chaining, pre-push
# member install, and nonzero exit whenever a member would be inactive.
set -u

INSTALLER=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/install-commit-msg-bead.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd)
TMP=$(mktemp -d "${TMPDIR:-$REPO_TMP}/install-bead-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0
ok() {
	if [ "$1" = "$2" ]; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: got %s want %s\n' "$3" "$1" "$2"; fi
}

new_repo() {
	dir="$TMP/$1"
	mkdir -p "$dir"
	git -C "$dir" init -q 2>/dev/null
	git -C "$dir" config user.email "test@invalid.example"
	git -C "$dir" config user.name "Test"
	# Fixture repos must not inherit the global commit-msg hook template:
	# it would refuse the seed commit and masquerade as our bespoke cases.
	rm -f "$dir/.git/hooks/commit-msg" "$dir/.git/hooks/commit-msg-"*
	git -C "$dir" commit -q --allow-empty --message "root" 2>/dev/null
	printf '%s' "$dir"
}

# 1. absent hook: dispatcher created, member runs (id-less refused)
A=$(new_repo absent)
sh "$INSTALLER" "$A" > /dev/null 2>&1
ok "$?" "0" "absent-install-rc"
MSG="$TMP/msg-a"
printf 'fix widgets with no identity\n' > "$MSG"
sh "$A/.git/hooks/commit-msg" "$MSG" > /dev/null 2>&1
ok "$?" "4" "absent-chain-refuses"

# 2. plain bash hook: moved aside, both run (marker written, bead enforced)
B=$(new_repo plain)
mkdir -p "$B/.git/hooks"
printf '#!/bin/sh\nprintf MARKED >> "$1"\n' > "$B/.git/hooks/commit-msg"
chmod +x "$B/.git/hooks/commit-msg"
sh "$INSTALLER" "$B" > /dev/null 2>&1
ok "$?" "0" "plain-install-rc"
printf 'fix widgets with no identity\n' > "$MSG"
sh "$B/.git/hooks/commit-msg" "$MSG" > /dev/null 2>&1
ok "$?" "4" "plain-chain-refuses"
grep -q "MARKED" "$MSG"
ok "$?" "0" "plain-bespoke-also-ran"
printf 'fix widgets ompkit-2w7h\n' > "$TMP/msg-b"
BEADS_DB="$TMP/absent.db" sh "$B/.git/hooks/commit-msg" "$TMP/msg-b" > /dev/null 2>&1
ok "$?" "0" "plain-chain-skips-no-tracker"

# 2b. fail-closed bespoke with a sibling impl: both move, chain stays green.
# The wrapper resolves its impl by dirname of itself and refuses when absent
# (2026-10-06 incident); the installer must move "<type>-*" siblings along.
C=$(new_repo sibling)
rm -f "$C/.git/hooks/commit-msg"
mkdir -p "$C/.git/hooks"
printf '#!/bin/sh\ndir=$(CDPATH="" cd -- "$(dirname -- "$0")" && pwd)\n[ -x "$dir/commit-msg-impl.sh" ] || exit 1\nexit 0\n' > "$C/.git/hooks/commit-msg"
chmod +x "$C/.git/hooks/commit-msg"
printf '#!/bin/sh\nexit 0\n' > "$C/.git/hooks/commit-msg-impl.sh"
chmod +x "$C/.git/hooks/commit-msg-impl.sh"
sh "$INSTALLER" "$C" > /dev/null 2>&1
ok "$?" "0" "sibling-install-rc"
[ -x "$C/.git/hooks/hooks.d/commit-msg/10-commit-msg" ] && [ -x "$C/.git/hooks/hooks.d/commit-msg/commit-msg-impl.sh" ]
rc=$?
ok "$rc" "0" "sibling-moved-along"
[ ! -e "$C/.git/hooks/commit-msg-impl.sh" ]
ok "$?" "0" "sibling-not-duplicated"
printf '[test] fix widgets with no identity\n' > "$TMP/msg-c"
BEADS_DB="$TMP/definitely-absent.db" sh "$C/.git/hooks/commit-msg" "$TMP/msg-c" > /dev/null 2>&1
ok "$?" "0" "sibling-chain-green"

# 2c. path-sensitive bespoke (passes at hooks root, fails once moved):
# the move regresses it, so the probe refuses and the installer rolls back.
D=$(new_repo pathbound)
rm -f "$D/.git/hooks/commit-msg"
mkdir -p "$D/.git/hooks"
printf '#!/bin/sh\ncase "$0" in */hooks/commit-msg) exit 0;; *) exit 1;; esac\n' > "$D/.git/hooks/commit-msg"
chmod +x "$D/.git/hooks/commit-msg"
sh "$INSTALLER" "$D" > "$TMP/o-refuse" 2>&1
ok "$?" "1" "regressed-install-rc"
grep -q "ROLLBACK" "$TMP/o-refuse"
ok "$?" "0" "rollback-announced"
[ -x "$D/.git/hooks/commit-msg" ] && [ ! -e "$D/.git/hooks/hooks.d/commit-msg/40-omp-kit-commit-msg-bead" ]
rc=$?
ok "$rc" "0" "rollback-restored"
printf '[test] fix widgets with no identity\n' > "$TMP/msg-d"
sh "$D/.git/hooks/commit-msg" "$TMP/msg-d" > /dev/null 2>&1
ok "$?" "0" "rollback-bespoke-intact"

# 2d. always-refusing bespoke: pre-existing refusal is preserved, install
# succeeds (the installer only rolls back regressions it caused itself).
E=$(new_repo refusing)
rm -f "$E/.git/hooks/commit-msg"
mkdir -p "$E/.git/hooks"
printf '#!/bin/sh\nexit 1\n' > "$E/.git/hooks/commit-msg"
chmod +x "$E/.git/hooks/commit-msg"
sh "$INSTALLER" "$E" > /dev/null 2>&1
ok "$?" "0" "refusing-install-rc"
[ -x "$E/.git/hooks/hooks.d/commit-msg/40-omp-kit-commit-msg-bead" ]
ok "$?" "0" "refusing-member-present"

# 3. pre-push member installed and dispatcher executable
[ -x "$A/.git/hooks/pre-push" ] && [ -x "$A/.git/hooks/hooks.d/pre-push/40-omp-kit-pushed-beads" ]
ok "$?" "0" "prepush-installed"
# The member resolves its repo from the cwd (pre-push protocol), so run the
# chain from inside the fixture like a real push does.
printf 'refs/heads/main %s refs/heads/main %s\n' "$(git -C "$A" rev-parse HEAD)" "$(git -C "$A" rev-parse HEAD)" | (CDPATH='' cd -- "$A" && sh "$A/.git/hooks/pre-push") > /dev/null 2>&1
ok "$?" "0" "prepush-empty-range"

# 4. non-repo refused nonzero
sh "$INSTALLER" "$TMP/nope" > /dev/null 2>&1
ok "$?" "2" "nonrepo-refused"

printf 'install-commit-msg-bead: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
