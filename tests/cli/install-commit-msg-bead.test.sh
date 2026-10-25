#!/bin/sh
# install-commit-msg-bead.test.sh — COMMIT1 installer contract (ompkit-2w7h).
# Fixture repos: one with no commit-msg hook, one with a plain bash hook.
# Asserts dispatcher creation, bespoke preservation + chaining, pre-push
# member install (shared-main always, pushed-beads unless opted out), and
# nonzero exit whenever a member would be inactive.
set -u
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"

INSTALLER=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/install-commit-msg-bead.sh
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd -P)
# Owned fixture root, removed on exit and on HUP/INT/TERM (kitlib, J-2026-10-22-06).
# shellcheck source=scripts/kitlib-tmp.sh
. "$(dirname -- "$INSTALLER")/kitlib-tmp.sh"
KITLIB_TMP_ROOT="${TMPDIR:-$REPO_TMP}" kitlib_tmp TMP install-bead-test || exit 1
TMP=$(CDPATH='' cd -- "$TMP" && pwd -P) || exit 1

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
	# Shared-main hooks require main regardless of the host's init.defaultBranch.
	git -C "$dir" branch -M main
	printf '%s' "$dir"
}

# 1. absent hook: dispatcher created, member runs (id-less refused). An empty
#    tracker file makes the refusal hermetic: without BEADS_DB the hook finds
#    whatever tracker the caller's cwd resolves (none in an exported tree).
EMPTY_DB="$TMP/empty.db"
: > "$EMPTY_DB"
A=$(new_repo absent)
sh "$INSTALLER" "$A" > /dev/null 2>&1
ok "$?" "0" "absent-install-rc"
MSG="$TMP/msg-a"
printf 'fix widgets with no identity\n' > "$MSG"
# Git invokes hooks from the target repo; do not inspect the caller's shared index.
(CDPATH='' cd -- "$A" && BEADS_DB="$EMPTY_DB" sh "$A/.git/hooks/commit-msg" "$MSG") > /dev/null 2>&1
ok "$?" "4" "absent-chain-refuses"

# 2. plain bash hook: moved aside, both run (marker written, bead enforced)
B=$(new_repo plain)
mkdir -p "$B/.git/hooks"
cat > "$B/.git/hooks/commit-msg" <<'HOOK'
#!/bin/sh
printf MARKED >> "$1"
HOOK
chmod +x "$B/.git/hooks/commit-msg"
sh "$INSTALLER" "$B" > /dev/null 2>&1
ok "$?" "0" "plain-install-rc"
printf 'fix widgets with no identity\n' > "$MSG"
(CDPATH='' cd -- "$B" && BEADS_DB="$EMPTY_DB" sh "$B/.git/hooks/commit-msg" "$MSG") > /dev/null 2>&1
ok "$?" "4" "plain-chain-refuses"
grep -q "MARKED" "$MSG"
ok "$?" "0" "plain-bespoke-also-ran"
printf 'fix widgets ompkit-2w7h\n' > "$TMP/msg-b"
(CDPATH='' cd -- "$B" && BEADS_DB="$TMP/absent.db" sh "$B/.git/hooks/commit-msg" "$TMP/msg-b") > /dev/null 2>&1
ok "$?" "0" "plain-chain-skips-no-tracker"

# 2b. fail-closed bespoke with a sibling impl: both move, chain stays green.
# The wrapper resolves its impl by dirname of itself and refuses when absent
# (2026-10-06 incident); the installer must move "<type>-*" siblings along.
C=$(new_repo sibling)
rm -f "$C/.git/hooks/commit-msg"
mkdir -p "$C/.git/hooks"
cat > "$C/.git/hooks/commit-msg" <<'HOOK'
#!/bin/sh
dir=$(CDPATH="" cd -- "$(dirname -- "$0")" && pwd)
[ -x "$dir/commit-msg-impl.sh" ] || exit 1
exit 0
HOOK
chmod +x "$C/.git/hooks/commit-msg"
printf '#!/bin/sh\nexit 0\n' > "$C/.git/hooks/commit-msg-impl.sh"
chmod +x "$C/.git/hooks/commit-msg-impl.sh"
sh "$INSTALLER" "$C" > /dev/null 2>&1
ok "$?" "0" "sibling-install-rc"
if [ -x "$C/.git/hooks/hooks.d/commit-msg/10-commit-msg" ] && [ -x "$C/.git/hooks/hooks.d/commit-msg/commit-msg-impl.sh" ]; then rc=0; else rc=1; fi
ok "$rc" "0" "sibling-moved-along"
if [ ! -e "$C/.git/hooks/commit-msg-impl.sh" ]; then rc=0; else rc=1; fi
ok "$rc" "0" "sibling-not-duplicated"
printf '[test] fix widgets with no identity\n' > "$TMP/msg-c"
(CDPATH='' cd -- "$C" && BEADS_DB="$TMP/definitely-absent.db" sh "$C/.git/hooks/commit-msg" "$TMP/msg-c") > /dev/null 2>&1
ok "$?" "0" "sibling-chain-green"

# 2c. path-sensitive bespoke (passes at hooks root, fails once moved):
# the move regresses it, so the probe refuses and the installer rolls back.
D=$(new_repo pathbound)
rm -f "$D/.git/hooks/commit-msg"
mkdir -p "$D/.git/hooks"
cat > "$D/.git/hooks/commit-msg" <<'HOOK'
#!/bin/sh
case "$0" in */hooks/commit-msg) exit 0;; *) exit 1;; esac
HOOK
chmod +x "$D/.git/hooks/commit-msg"
sh "$INSTALLER" "$D" > "$TMP/o-refuse" 2>&1
ok "$?" "1" "regressed-install-rc"
grep -q "ROLLBACK" "$TMP/o-refuse"
ok "$?" "0" "rollback-announced"
if [ -x "$D/.git/hooks/commit-msg" ] && [ ! -e "$D/.git/hooks/hooks.d/commit-msg/40-omp-kit-commit-msg-bead" ]; then rc=0; else rc=1; fi
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
if [ -x "$E/.git/hooks/hooks.d/commit-msg/40-omp-kit-commit-msg-bead" ]; then rc=0; else rc=1; fi
ok "$rc" "0" "refusing-member-present"

# 3. pre-push members installed and dispatcher executable
if [ -x "$A/.git/hooks/pre-push" ] && [ -x "$A/.git/hooks/hooks.d/pre-push/40-omp-kit-pushed-beads" ] && [ -x "$A/.git/hooks/hooks.d/pre-push/30-omp-kit-on-main" ]; then rc=0; else rc=1; fi
ok "$rc" "0" "prepush-installed"
# The member resolves its repo from the cwd (pre-push protocol), so run the
# chain from inside the fixture like a real push does.
printf 'refs/heads/main %s refs/heads/main %s\n' "$(git -C "$A" rev-parse HEAD)" "$(git -C "$A" rev-parse HEAD)" | (CDPATH='' cd -- "$A" && sh "$A/.git/hooks/pre-push") > /dev/null 2>&1
ok "$?" "0" "prepush-empty-range"

# 4. non-repo refused nonzero
sh "$INSTALLER" "$TMP/nope" > /dev/null 2>&1
ok "$?" "2" "nonrepo-refused"

# 5. --check: fresh members pass; an older source names each stale member
# (planted: the installed hook predates the digit-less fix).
sh "$INSTALLER" --check "$A" > /dev/null 2>&1
ok "$?" "0" "check-fresh-rc"
mkdir -p "$TMP/oldkit/scripts"
cp "$INSTALLER" "$TMP/oldkit/scripts/install-commit-msg-bead.sh"
printf '#!/bin/sh\n# old hook predating the fix\nexit 0\n' > "$TMP/oldkit/scripts/commit-msg-bead.sh"
printf '# old checker\n' > "$TMP/oldkit/scripts/check-pushed-beads.sh"
printf '# old shared-main guard\n' > "$TMP/oldkit/scripts/check-pushed-on-main.sh"
sh "$TMP/oldkit/scripts/install-commit-msg-bead.sh" --check "$A" > "$TMP/o-stale" 2>&1
ok "$?" "3" "check-stale-rc"
grep -q "STALE installed member: $A/.git/hooks/hooks.d/commit-msg/40-omp-kit-commit-msg-bead" "$TMP/o-stale"
ok "$?" "0" "check-stale-named"
grep -q "STALE installed member: $A/.git/hooks/hooks.d/pre-push/30-omp-kit-on-main" "$TMP/o-stale"
ok "$?" "0" "check-stale-on-main-named"
# 5b. --check names a missing staged-imports pre-commit member
rm -f "$A/.git/hooks/hooks.d/pre-commit/45-omp-kit-staged-imports"
sh "$INSTALLER" --check "$A" > "$TMP/o-missing" 2>&1
ok "$?" "3" "check-missing-staged-imports-rc"
grep -q "MISSING installed member: $A/.git/hooks/hooks.d/pre-commit/45-omp-kit-staged-imports" "$TMP/o-missing"
ok "$?" "0" "check-missing-staged-imports-named"
sh "$INSTALLER" "$A" > /dev/null 2>&1
ok "$?" "0" "check-missing-reinstall-rc"
# 5c. --check names a missing commit-notes commit-msg member
rm -f "$A/.git/hooks/hooks.d/commit-msg/46-omp-kit-commit-notes"
sh "$INSTALLER" --check "$A" > "$TMP/o-missing-notes" 2>&1
ok "$?" "3" "check-missing-commit-notes-rc"
grep -q "MISSING installed member: $A/.git/hooks/hooks.d/commit-msg/46-omp-kit-commit-notes" "$TMP/o-missing-notes"
ok "$?" "0" "check-missing-commit-notes-named"
sh "$INSTALLER" "$A" > /dev/null 2>&1
ok "$?" "0" "check-missing-notes-reinstall-rc"
# 5d. --check names missing staged-fragments and staged-regexploit members
rm -f "$A/.git/hooks/hooks.d/pre-commit/47-omp-kit-staged-fragments" "$A/.git/hooks/hooks.d/pre-commit/48-omp-kit-staged-regexploit"
sh "$INSTALLER" --check "$A" > "$TMP/o-missing-staged" 2>&1
ok "$?" "3" "check-missing-staged-validators-rc"
grep -q "MISSING installed member: $A/.git/hooks/hooks.d/pre-commit/47-omp-kit-staged-fragments" "$TMP/o-missing-staged"
ok "$?" "0" "check-missing-staged-fragments-named"
grep -q "MISSING installed member: $A/.git/hooks/hooks.d/pre-commit/48-omp-kit-staged-regexploit" "$TMP/o-missing-staged"
ok "$?" "0" "check-missing-staged-regexploit-named"
sh "$INSTALLER" "$A" > /dev/null 2>&1
ok "$?" "0" "check-missing-staged-reinstall-rc"
# 5e. --check names a missing staged-pysafe member and a stale checker copy
rm -f "$A/.git/hooks/hooks.d/pre-commit/49-omp-kit-staged-pysafe"
printf '# drift\n' >> "$A/.git/hooks/hooks.d/pre-commit/pysafe_check.py"
sh "$INSTALLER" --check "$A" > "$TMP/o-missing-pysafe" 2>&1
ok "$?" "3" "check-missing-staged-pysafe-rc"
grep -q "MISSING installed member: $A/.git/hooks/hooks.d/pre-commit/49-omp-kit-staged-pysafe" "$TMP/o-missing-pysafe"
ok "$?" "0" "check-missing-staged-pysafe-named"
grep -q "STALE installed member: $A/.git/hooks/hooks.d/pre-commit/pysafe_check.py" "$TMP/o-missing-pysafe"
ok "$?" "0" "check-stale-pysafe-checker-named"
sh "$INSTALLER" "$A" > /dev/null 2>&1
ok "$?" "0" "check-missing-pysafe-reinstall-rc"
modes=1
[ -x "$A/.git/hooks/hooks.d/pre-commit/49-omp-kit-staged-pysafe" ] && [ ! -x "$A/.git/hooks/hooks.d/pre-commit/pysafe_check.py" ] && [ ! -x "$A/.git/hooks/hooks.d/pre-commit/pysafe.py" ] && modes=0
ok "$modes" "0" "pysafe-helpers-not-executable"
rm -f "$A/.git/hooks/hooks.d/pre-push/kitlib-tmp.sh" "$A/.git/hooks/hooks.d/reference-transaction/kitlib-tmp.sh" "$A/.git/hooks/hooks.d/commit-msg/kitlib-tmp.sh"
sh "$INSTALLER" --check "$A" > "$TMP/o-missing-kitlib" 2>&1
ok "$?" "3" "check-missing-kitlib-tmp-rc"
grep -q "MISSING installed member: $A/.git/hooks/hooks.d/pre-push/kitlib-tmp.sh" "$TMP/o-missing-kitlib"
ok "$?" "0" "check-missing-kitlib-tmp-named"
grep -q "MISSING installed member: $A/.git/hooks/hooks.d/reference-transaction/kitlib-tmp.sh" "$TMP/o-missing-kitlib"
ok "$?" "0" "check-missing-ref-txn-kitlib-tmp-named"
grep -q "MISSING installed member: $A/.git/hooks/hooks.d/commit-msg/kitlib-tmp.sh" "$TMP/o-missing-kitlib"
ok "$?" "0" "check-missing-commit-msg-kitlib-tmp-named"
sh "$INSTALLER" "$A" > /dev/null 2>&1
ok "$?" "0" "check-missing-kitlib-tmp-reinstall-rc"
sh "$INSTALLER" --check "$A" > "$TMP/o-kitlib-restored" 2>&1
ok "$?" "0" "check-kitlib-tmp-reinstall-healthy"
printf '# drift\n' >> "$A/.git/hooks/hooks.d/commit-msg/kitlib-tmp.sh"
sh "$INSTALLER" --check "$A" > "$TMP/o-stale-commit-msg-kitlib" 2>&1
ok "$?" "3" "check-stale-commit-msg-kitlib-tmp-rc"
grep -q "STALE installed member: $A/.git/hooks/hooks.d/commit-msg/kitlib-tmp.sh" "$TMP/o-stale-commit-msg-kitlib"
ok "$?" "0" "check-stale-commit-msg-kitlib-tmp-named"
sh "$INSTALLER" "$A" > /dev/null 2>&1
sh "$INSTALLER" --check "$A" > "$TMP/o-commit-msg-kitlib-restored" 2>&1
ok "$?" "0" "check-stale-commit-msg-kitlib-tmp-repaired"
# 5f. --check names a missing staged-kitlib member and a stale ratchet engine
#     copy; a reinstall restores them, helpers non-executable (ompkit-qwqh1)
rm -f "$A/.git/hooks/hooks.d/pre-commit/51-omp-kit-staged-kitlib"
printf '# drift\n' >> "$A/.git/hooks/hooks.d/pre-commit/kitlib_ratchet_core.py"
sh "$INSTALLER" --check "$A" > "$TMP/o-missing-kitlib-ratchet" 2>&1
ok "$?" "3" "check-missing-staged-kitlib-rc"
grep -q "MISSING installed member: $A/.git/hooks/hooks.d/pre-commit/51-omp-kit-staged-kitlib" "$TMP/o-missing-kitlib-ratchet"
ok "$?" "0" "check-missing-staged-kitlib-named"
grep -q "STALE installed member: $A/.git/hooks/hooks.d/pre-commit/kitlib_ratchet_core.py" "$TMP/o-missing-kitlib-ratchet"
ok "$?" "0" "check-stale-ratchet-core-named"
sh "$INSTALLER" "$A" > /dev/null 2>&1
ok "$?" "0" "check-missing-kitlib-ratchet-reinstall-rc"
modes=1
[ -x "$A/.git/hooks/hooks.d/pre-commit/51-omp-kit-staged-kitlib" ] && [ ! -x "$A/.git/hooks/hooks.d/pre-commit/kitlib_ratchet.py" ] && [ ! -x "$A/.git/hooks/hooks.d/pre-commit/kitlib_ratchet_core.py" ] && modes=0
ok "$modes" "0" "kitlib-ratchet-helpers-not-executable"

# 6. rollback restores a member it overwrote, byte-for-byte, and leaves no
#    backup behind (planted: the old installer deleted it, localbench 2026-10-16)
F=$(new_repo restore)
mkdir -p "$F/.git/hooks/hooks.d/commit-msg"
printf '#!/bin/sh\n# older member\nexit 0\n' > "$F/.git/hooks/hooks.d/commit-msg/40-omp-kit-commit-msg-bead"
chmod +x "$F/.git/hooks/hooks.d/commit-msg/40-omp-kit-commit-msg-bead"
cat > "$F/.git/hooks/commit-msg" <<'HOOK'
#!/bin/sh
case "$0" in */hooks/commit-msg) exit 0;; *) exit 1;; esac
HOOK
chmod +x "$F/.git/hooks/commit-msg"
sh "$INSTALLER" "$F" > /dev/null 2>&1
ok "$?" "1" "restore-rollback-rc"
grep -q "older member" "$F/.git/hooks/hooks.d/commit-msg/40-omp-kit-commit-msg-bead"
ok "$?" "0" "restore-member-restored"
rc=0
for leftover in "$F/.git/hooks/hooks.d/commit-msg"/.undo.*; do [ -e "$leftover" ] && rc=1; done
ok "$rc" "0" "restore-no-backup-left"

# 7. a full install over unpublished id-less history is refused before any
#    mutation (exit 5); --no-pushed-beads installs the forward-only set, which
#    still carries the shared-main member (it never judges old messages)
G=$(new_repo idless)
mkdir -p "$G/.beads"
: > "$G/.beads/beads.db"
git -C "$G" commit -q --no-verify --allow-empty -m "unpublished with no identity"
sh "$INSTALLER" "$G" > "$TMP/o-idless" 2>&1
ok "$?" "5" "idless-full-refused"
if [ ! -e "$G/.git/hooks/hooks.d/commit-msg/40-omp-kit-commit-msg-bead" ] && [ ! -e "$G/.git/hooks/reference-transaction" ]; then rc=0; else rc=1; fi
ok "$rc" "0" "idless-nothing-mutated"
sh "$INSTALLER" --no-pushed-beads "$G" > /dev/null 2>&1
ok "$?" "0" "idless-forward-only-rc"
if [ -x "$G/.git/hooks/hooks.d/reference-transaction/40-omp-kit-ref-txn-bead" ] && [ -x "$G/.git/hooks/hooks.d/pre-push/30-omp-kit-on-main" ] && [ ! -e "$G/.git/hooks/hooks.d/pre-push/40-omp-kit-pushed-beads" ]; then rc=0; else rc=1; fi
ok "$rc" "0" "idless-forward-only-members"
sh "$INSTALLER" --check --no-pushed-beads "$G" > /dev/null 2>&1
ok "$?" "0" "idless-forward-only-check-fresh"

# 8. a bespoke stdin-reading reference-transaction keeps working beside the
#    guard: the runner replays the update lines to each member (planted: the
#    old runner let the first reader starve the guard, localbench 2026-10-16)
H=$(new_repo stdin)
mkdir -p "$H/.beads"
: > "$H/.beads/beads.db"
cat > "$H/.git/hooks/reference-transaction" <<'HOOK'
#!/bin/sh
cat >> "$(git rev-parse --git-dir)/bespoke-saw"
exit 0
HOOK
chmod +x "$H/.git/hooks/reference-transaction"
sh "$INSTALLER" --no-pushed-beads "$H" > /dev/null 2>&1
ok "$?" "0" "stdin-install-rc"
HB=$(git -C "$H" rev-parse HEAD)
HP=$(printf 'replayed update with no identity\n' | git -C "$H" commit-tree "$HB^{tree}" -p "$HB")
if git -C "$H" update-ref refs/heads/main "$HP" "$HB" 2> /dev/null; then rc=0; else rc=1; fi
ok "$rc" "1" "stdin-guard-refused"
ok "$(git -C "$H" rev-parse HEAD)" "$HB" "stdin-main-unmoved"
grep -q "$HP refs/heads/main" "$H/.git/bespoke-saw"
ok "$?" "0" "stdin-bespoke-saw-update"

# 9. an installed runner of ours without stdin replay is upgraded in place
I=$(new_repo upgrade)
mkdir -p "$I/.git/hooks/hooks.d/reference-transaction"
cat > "$I/.git/hooks/reference-transaction" <<'HOOK'
#!/bin/sh
# chain runner: run every executable NN-<name> member in hooks.d/<type> in
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
rc=0
for hook in "$here/hooks.d/$(basename -- "$0")"/[0-9][0-9]-*; do [ -x "$hook" ] && { sh "$hook" "$@" || rc=$?; }; done
exit $rc
HOOK
chmod +x "$I/.git/hooks/reference-transaction"
sh "$INSTALLER" --no-pushed-beads "$I" > "$TMP/o-upgrade" 2>&1
ok "$?" "0" "upgrade-install-rc"
grep -q "upgraded chain runner" "$TMP/o-upgrade"
ok "$?" "0" "upgrade-announced"

# 10. a real push through the installed chain: main publishes; a candidate
#     committed on origin's main but not on local main is refused, and the
#     remote keeps its main (planted: the private-index publication that split
#     zestroku into two histories, 1818d71, 2026-10-16)
J=$(new_repo pushreal)
git -C "$J" branch -M main
# The pushed-verification-level member refuses level-less subjects, so the
# fixture history carries a level before the push (VLEVEL-PUSH2 ompkit-xa5s.37).
git -C "$J" commit -q --amend --allow-empty --message "[test] root"
git init -q --bare "$TMP/pushreal-origin.git"
git -C "$J" remote add origin "$TMP/pushreal-origin.git"
sh "$INSTALLER" "$J" > /dev/null 2>&1
ok "$?" "0" "pushreal-install-rc"
git -C "$J" push -q origin main > /dev/null 2>&1
ok "$?" "0" "pushreal-main-published"
JB=$(git -C "$J" rev-parse main)
JX=$(printf 'private candidate on origin main\n' | git -C "$J" commit-tree "$JB^{tree}" -p "$JB")
(CDPATH='' cd -- "$J" && git push origin "$JX:refs/heads/main") > "$TMP/o-pushreal" 2>&1
ok "$?" "1" "pushreal-candidate-refused"
grep -q "check-pushed-on-main: REFUSED $JX" "$TMP/o-pushreal"
ok "$?" "0" "pushreal-refusal-named"
ok "$(git -C "$TMP/pushreal-origin.git" rev-parse main)" "$JB" "pushreal-origin-unmoved"

# 11. an inert shared-main member (passes an off-main commit) is caught by the
#     live probe: the install rolls back and leaves no member behind
mkdir -p "$TMP/inertkit/scripts"
for script in install-commit-msg-bead.sh commit-msg-bead.sh check-pushed-beads.sh ref-txn-bead.sh check-staged-imports.sh check-commit-imports.sh check-commit-notes.sh release-notes.ts limit-process-tree.sh check-staged-fragments.sh check-staged-regexploit.sh check-stale-worktree.sh check-staged-pysafe.sh check-staged-tempsafe.sh check-staged-kitlib.sh check-staged-readme.sh check-staged-sources.sh pysafe.py pysafe_check.py kitlib_ratchet_core.py tempsafe_check.py kitlib_ratchet.py sources.py kitlib_run.py kitlib_io.py kitlib_tmp.py readme-check.ts kitlib-tmp.sh; do
	cp "$(dirname -- "$INSTALLER")/$script" "$TMP/inertkit/scripts/$script"
done
cp "$(dirname -- "$INSTALLER")/pre-push-verification-level.sh" "$TMP/inertkit/scripts/pre-push-verification-level.sh"
printf '#!/bin/sh\nexit 0\n' > "$TMP/inertkit/scripts/check-pushed-on-main.sh"
K=$(new_repo inert)
git -C "$K" branch -M main
sh "$TMP/inertkit/scripts/install-commit-msg-bead.sh" "$K" > "$TMP/o-inert" 2>&1
ok "$?" "1" "inert-member-rollback-rc"
grep -q "shared-main member let an off-main commit move the remote main" "$TMP/o-inert"
ok "$?" "0" "inert-member-named"
[ ! -e "$K/.git/hooks/hooks.d/pre-push/30-omp-kit-on-main" ]
ok "$?" "0" "inert-member-removed"

printf 'install-commit-msg-bead: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
