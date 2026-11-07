#!/bin/sh
# install-commit-msg-bead.lib.sh — shared COMMIT1 cases (ompkit-2w7h).
# Sourced by the raw-install, repair and integration test entries.
# Asserts dispatcher creation, bespoke preservation + chaining, pre-push
# member install (shared-main always, pushed-beads unless opted out), and
# nonzero exit whenever a member would be inactive.
set -u
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"

INSTALLER=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/install-commit-msg-bead.sh
# Owned fixture root, removed on exit and on HUP/INT/TERM (kitlib, J-2026-10-22-06).
KITLIB="$(dirname -- "$INSTALLER")/kitlib-tmp.sh"
# shellcheck source=scripts/kitlib-tmp.sh
. "$KITLIB"
kitlib_tmp TMP install-bead-test || exit 1
TMP=$(CDPATH='' cd -- "$TMP" && pwd -P) || exit 1
export TMPDIR="$TMP"

pass=0
fail=0
ok() {
	if [ "$1" = "$2" ]; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: got %s want %s\n' "$3" "$1" "$2"; fi
}

new_repo() {
	dir="$TMP/$1"
	if [ -n "${RAW_BASELINE:-}" ]; then
		cp -R "$RAW_BASELINE" "$dir" || return 1
	else
		mkdir -p "$dir" || return 1
		git -C "$dir" init -q 2>/dev/null || return 1
		git -C "$dir" config user.email "test@invalid.example" || return 1
		git -C "$dir" config user.name "Test" || return 1
		# Start without host-template policies; each bespoke case installs its
		# own hook, and every managed member comes from the real installer.
		rm -f "$dir/.git/hooks/commit-msg" "$dir/.git/hooks/commit-msg-"* \
			"$dir/.git/hooks/pre-commit" "$dir/.git/hooks/pre-push" "$dir/.git/hooks/reference-transaction"
		git -C "$dir" -c core.hooksPath=/dev/null commit -q --allow-empty --message "root" 2>/dev/null || return 1
		# Shared-main hooks require main regardless of the host's init.defaultBranch.
		git -C "$dir" branch -M main || return 1
	fi
	printf '%s' "$dir"
}

installed_repo() {
	dir="$TMP/$1"
	cp -R "$INSTALLED_BASELINE" "$dir" || return 1
	printf '%s' "$dir"
}

# 1. absent hook: dispatcher created, member runs (id-less refused). An empty
#    tracker file makes the refusal hermetic: without BEADS_DB the hook finds
#    whatever tracker the caller's cwd resolves (none in an exported tree).
EMPTY_DB="$TMP/empty.db"
: > "$EMPTY_DB"
# Raw cases still perform their own first install, without reseeding Git.
RAW_BASELINE=
RAW_BASELINE=$(new_repo raw) || exit 1
A=$(new_repo absent) || exit 1
sh "$INSTALLER" "$A" > /dev/null 2>&1
baseline_install_rc=$?
[ "$baseline_install_rc" = "0" ] || { printf 'FAIL baseline install\n' >&2; exit 1; }
# Every check/repair case gets a private copy of this real, complete install.
INSTALLED_BASELINE=$A

group_absent() {
A=$(installed_repo absent) || exit 1

# 1a. The installed pre-commit chain refuses an unpinned init and admits a
#     fixture-local database path through the same staged member.
printf 'run(["br", "init"]);\n' > "$A/unsafe.ts"
git -C "$A" add unsafe.ts
out=$(CDPATH='' cd -- "$A" && sh "$A/.git/hooks/pre-commit" 2>&1)
rc=$?
ok "$rc" "1" "br-init-installed-chain-refuses"
if printf '%s' "$out" | grep -Fq "unsafe.ts:1:" && printf '%s' "$out" | grep -Fq "unpinned-br-init"; then rc=0; else rc=1; fi
ok "$rc" "0" "br-init-installed-chain-names-site"
printf 'run(["br", "init", "--db", join(dir, ".beads", "beads.db")]);\n' > "$A/unsafe.ts"
git -C "$A" add unsafe.ts
out=$(CDPATH='' cd -- "$A" && sh "$A/.git/hooks/pre-commit" 2>&1)
rc=$?
ok "$rc" "0" "br-init-installed-chain-admits-pinned"
printf 'brun(["create", "probe"], dir);\n' > "$A/unsafe.ts"
git -C "$A" add unsafe.ts
out=$(CDPATH='' cd -- "$A" && sh "$A/.git/hooks/pre-commit" 2>&1)
rc=$?
ok "$rc" "1" "inherited-br-call-installed-chain-refuses"
if printf '%s' "$out" | grep -Fq "unsafe.ts:1:" && printf '%s' "$out" | grep -Fq "inherited-br-call"; then rc=0; else rc=1; fi
ok "$rc" "0" "inherited-br-call-installed-chain-names-site"
printf 'brun(["create", "probe"], dir, { BEADS_DB: join(dir, ".beads", "beads.db") });\n' > "$A/unsafe.ts"
git -C "$A" add unsafe.ts
out=$(CDPATH='' cd -- "$A" && sh "$A/.git/hooks/pre-commit" 2>&1)
rc=$?
ok "$rc" "0" "inherited-br-call-installed-chain-admits-bound"
git -C "$A" reset -q -- unsafe.ts


MSG="$TMP/msg-a"
printf 'fix widgets with no identity\n' > "$MSG"
# Git invokes hooks from the target repo; do not inspect the caller's shared index.
(CDPATH='' cd -- "$A" && BEADS_DB="$EMPTY_DB" sh "$A/.git/hooks/commit-msg" "$MSG") > /dev/null 2>&1
ok "$?" "4" "absent-chain-refuses"
}

group_plain() {
MSG="$TMP/msg-a"

# 2. plain bash hook: moved aside, both run (marker written, bead enforced)
B=$(new_repo plain) || exit 1
mkdir -p "$B/.git/hooks"
cat > "$B/.git/hooks/commit-msg" <<'HOOK'
#!/bin/bash
read -r marker < <(printf 'MARKED\n')
printf '%s' "$marker" >> "$1"
HOOK
chmod +x "$B/.git/hooks/commit-msg"
sh "$INSTALLER" "$B" > /dev/null 2>&1
ok "$?" "0" "plain-install-rc"
printf 'fix widgets with no identity\n' > "$MSG"
(CDPATH='' cd -- "$B" && BEADS_DB="$EMPTY_DB" sh "$B/.git/hooks/commit-msg" "$MSG") > /dev/null 2>&1
ok "$?" "4" "plain-chain-refuses"
grep -q "MARKED" "$MSG"
ok "$?" "0" "plain-bespoke-also-ran"
printf 'fix widgets ompkit-2w7h [test]\n' > "$TMP/msg-b"
(CDPATH='' cd -- "$B" && BEADS_DB="$TMP/absent.db" sh "$B/.git/hooks/commit-msg" "$TMP/msg-b") > /dev/null 2>&1
ok "$?" "0" "plain-chain-skips-no-tracker"
}

group_sibling() {

# 2b. fail-closed bespoke with a sibling impl: both move, chain stays green.
# The wrapper resolves its impl by dirname of itself and refuses when absent
# (2026-10-06 incident); the installer must move "<type>-*" siblings along.
C=$(new_repo sibling) || exit 1
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
}

group_pathbound() {

# 2c. path-sensitive bespoke (passes at hooks root, fails once moved):
# the move regresses it, so the probe refuses and the installer rolls back.
D=$(new_repo pathbound) || exit 1
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
}

group_refusing() {

# 2d. always-refusing bespoke: pre-existing refusal is preserved, install
# succeeds (the installer only rolls back regressions it caused itself).
E=$(new_repo refusing) || exit 1
rm -f "$E/.git/hooks/commit-msg"
mkdir -p "$E/.git/hooks"
printf '#!/bin/sh\nexit 1\n' > "$E/.git/hooks/commit-msg"
chmod +x "$E/.git/hooks/commit-msg"
sh "$INSTALLER" "$E" > /dev/null 2>&1
ok "$?" "0" "refusing-install-rc"
if [ -x "$E/.git/hooks/hooks.d/commit-msg/40-omp-kit-commit-msg-bead" ]; then rc=0; else rc=1; fi
ok "$rc" "0" "refusing-member-present"
}

group_prepush() {
A=$(installed_repo absent) || exit 1

# 3. pre-push members installed and dispatcher executable
if [ -x "$A/.git/hooks/pre-push" ] && [ -x "$A/.git/hooks/hooks.d/pre-push/40-omp-kit-pushed-beads" ] && [ -x "$A/.git/hooks/hooks.d/pre-push/30-omp-kit-on-main" ]; then rc=0; else rc=1; fi
ok "$rc" "0" "prepush-installed"
# The member resolves its repo from the cwd (pre-push protocol), so run the
# chain from inside the fixture like a real push does.
printf 'refs/heads/main %s refs/heads/main %s\n' "$(git -C "$A" rev-parse HEAD)" "$(git -C "$A" rev-parse HEAD)" | (CDPATH='' cd -- "$A" && sh "$A/.git/hooks/pre-push") > /dev/null 2>&1
ok "$?" "0" "prepush-empty-range"
}

group_check() {
A=$(installed_repo absent) || exit 1

# 4. non-repo refused nonzero
sh "$INSTALLER" "$TMP/nope" > /dev/null 2>&1
ok "$?" "2" "nonrepo-refused"

# 5. --check: fresh members pass; an older source names each stale member
# (planted: the installed hook predates the digit-less fix).
sh "$INSTALLER" --check "$A" > /dev/null 2>&1
ok "$?" "0" "check-fresh-rc"
# Previously installed helpers escaped --check's duplicate list. The canonical
# manifest must name missing/stale copies and preserve helper/member modes on repair.
rm "$A/.git/hooks/hooks.d/pre-commit/portable_paths_check.py"
printf '\n# planted stale helper\n' >> "$A/.git/hooks/hooks.d/pre-commit/wallclock_check.py"
sh "$INSTALLER" --check "$A" > "$TMP/o-manifest-closure" 2>&1
ok "$?" "3" "check-canonical-closure-rc"
grep -q "MISSING installed member: $A/.git/hooks/hooks.d/pre-commit/portable_paths_check.py" "$TMP/o-manifest-closure"
ok "$?" "0" "check-canonical-portable-helper-named"
grep -q "STALE installed member: $A/.git/hooks/hooks.d/pre-commit/wallclock_check.py" "$TMP/o-manifest-closure"
ok "$?" "0" "check-canonical-wallclock-helper-named"
sh "$INSTALLER" "$A" > /dev/null 2>&1
ok "$?" "0" "canonical-closure-reinstall-rc"
sh "$INSTALLER" --check "$A" > /dev/null 2>&1
ok "$?" "0" "canonical-closure-reinstall-fresh"
modes=1
[ ! -x "$A/.git/hooks/hooks.d/pre-commit/portable_paths_check.py" ] && [ ! -x "$A/.git/hooks/hooks.d/pre-commit/wallclock_check.py" ] && [ -x "$A/.git/hooks/hooks.d/commit-msg/48-omp-kit-deploy-step" ] && modes=0
ok "$modes" "0" "canonical-closure-helper-member-modes"
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
}

group_imports() {
A=$(installed_repo absent) || exit 1
# 5b. --check names a missing staged-imports pre-commit member
rm -f "$A/.git/hooks/hooks.d/pre-commit/45-omp-kit-staged-imports"
sh "$INSTALLER" --check "$A" > "$TMP/o-missing" 2>&1
ok "$?" "3" "check-missing-staged-imports-rc"
grep -q "MISSING installed member: $A/.git/hooks/hooks.d/pre-commit/45-omp-kit-staged-imports" "$TMP/o-missing"
ok "$?" "0" "check-missing-staged-imports-named"
sh "$INSTALLER" "$A" > /dev/null 2>&1
ok "$?" "0" "check-missing-reinstall-rc"
}

group_notes() {
A=$(installed_repo absent) || exit 1
# 5c. --check names a missing commit-notes commit-msg member
rm -f "$A/.git/hooks/hooks.d/commit-msg/46-omp-kit-commit-notes"
sh "$INSTALLER" --check "$A" > "$TMP/o-missing-notes" 2>&1
ok "$?" "3" "check-missing-commit-notes-rc"
grep -q "MISSING installed member: $A/.git/hooks/hooks.d/commit-msg/46-omp-kit-commit-notes" "$TMP/o-missing-notes"
ok "$?" "0" "check-missing-commit-notes-named"
sh "$INSTALLER" "$A" > /dev/null 2>&1
ok "$?" "0" "check-missing-notes-reinstall-rc"
}

group_staged() {
A=$(installed_repo absent) || exit 1
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
}

group_pysafe() {
A=$(installed_repo absent) || exit 1
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
}

group_kitlib_missing() {
A=$(installed_repo absent) || exit 1
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
}

group_kitlib_stale() {
A=$(installed_repo absent) || exit 1
printf '# drift\n' >> "$A/.git/hooks/hooks.d/commit-msg/kitlib-tmp.sh"
sh "$INSTALLER" --check "$A" > "$TMP/o-stale-commit-msg-kitlib" 2>&1
ok "$?" "3" "check-stale-commit-msg-kitlib-tmp-rc"
grep -q "STALE installed member: $A/.git/hooks/hooks.d/commit-msg/kitlib-tmp.sh" "$TMP/o-stale-commit-msg-kitlib"
ok "$?" "0" "check-stale-commit-msg-kitlib-tmp-named"
sh "$INSTALLER" "$A" > /dev/null 2>&1
sh "$INSTALLER" --check "$A" > "$TMP/o-commit-msg-kitlib-restored" 2>&1
ok "$?" "0" "check-stale-commit-msg-kitlib-tmp-repaired"
}

group_kitlib_ratchet() {
A=$(installed_repo absent) || exit 1
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
}

group_br_init() {
A=$(installed_repo absent) || exit 1
# 5h. The exact-reversal commit-msg member is part of the installed contract.
# 5g. --check names a missing staged-br-init member and stale checker copy;
# reinstall restores the member and keeps its Python helper non-executable.
rm -f "$A/.git/hooks/hooks.d/pre-commit/53-omp-kit-staged-br-init"
printf '# drift\n' >> "$A/.git/hooks/hooks.d/pre-commit/br_init_check.py"
sh "$INSTALLER" --check "$A" > "$TMP/o-missing-br-init" 2>&1
ok "$?" "3" "check-missing-br-init-rc"
grep -q "MISSING installed member: $A/.git/hooks/hooks.d/pre-commit/53-omp-kit-staged-br-init" "$TMP/o-missing-br-init"
ok "$?" "0" "check-missing-br-init-named"
grep -q "STALE installed member: $A/.git/hooks/hooks.d/pre-commit/br_init_check.py" "$TMP/o-missing-br-init"
ok "$?" "0" "check-stale-br-init-checker-named"
sh "$INSTALLER" "$A" > /dev/null 2>&1
ok "$?" "0" "check-missing-br-init-reinstall-rc"
modes=1
[ -x "$A/.git/hooks/hooks.d/pre-commit/53-omp-kit-staged-br-init" ] && [ ! -x "$A/.git/hooks/hooks.d/pre-commit/br_init_check.py" ] && modes=0
ok "$modes" "0" "br-init-checker-helper-not-executable"
}

group_kitlib_reversal() {
A=$(installed_repo absent) || exit 1
# 5h. The exact-reversal commit-msg member is part of the installed contract.
rm -f "$A/.git/hooks/hooks.d/commit-msg/50-omp-kit-staged-kitlib-reversal"
sh "$INSTALLER" --check "$A" > "$TMP/o-missing-kitlib-reversal" 2>&1
ok "$?" "3" "check-missing-kitlib-reversal-rc"
grep -q "MISSING installed member: $A/.git/hooks/hooks.d/commit-msg/50-omp-kit-staged-kitlib-reversal" "$TMP/o-missing-kitlib-reversal"
ok "$?" "0" "check-missing-kitlib-reversal-named"
sh "$INSTALLER" "$A" > /dev/null 2>&1
ok "$?" "0" "check-missing-kitlib-reversal-reinstall"
}

group_restore() {


# 6. rollback restores a member it overwrote, byte-for-byte, and leaves no
#    backup behind (planted: the old installer deleted it, localbench 2026-10-16)
F=$(new_repo restore) || exit 1
mkdir -p "$F/.git/hooks/hooks.d/commit-msg"
printf '#!/bin/sh\n# older member\nexit 0\n' > "$F/.git/hooks/hooks.d/commit-msg/40-omp-kit-commit-msg-bead"
# 711 is not a plain 755, so a sloppy restore (a+x, 755) is caught.
chmod 711 "$F/.git/hooks/hooks.d/commit-msg/40-omp-kit-commit-msg-bead"
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
# The backup is made non-executable (other chain runners run every executable file in the directory);
# rollback still restores the member's exact original mode.
mode=$(python3 -c 'import os,sys; print(format(os.stat(sys.argv[1]).st_mode & 0o7777, "o"))' "$F/.git/hooks/hooks.d/commit-msg/40-omp-kit-commit-msg-bead")
[ "$mode" = 711 ]
ok "$?" "0" "restore-member-mode-exact: $mode"
}

group_idless() {

# 7. a full install over unpublished id-less history is refused before any
#    mutation (exit 5); --no-pushed-beads installs the forward-only set, which
#    still carries the shared-main member (it never judges old messages)
G=$(new_repo idless) || exit 1
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
}

group_stdin() {

# 8. a bespoke stdin-reading reference-transaction keeps working beside the
#    guard: the runner replays the update lines to each member (planted: the
#    old runner let the first reader starve the guard, localbench 2026-10-16)
H=$(new_repo stdin) || exit 1
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
}

group_upgrade() {

# 9. an installed runner of ours without stdin replay is upgraded in place
I=$(new_repo upgrade) || exit 1
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
}

group_pushreal() {

# 10. a real push through the installed chain: main publishes; a candidate
#     committed on origin's main but not on local main is refused, and the
#     remote keeps its main (planted: the private-index publication that split
#     zestroku into two histories, 1818d71, 2026-10-16)
J=$(new_repo pushreal) || exit 1
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
}

group_inert() {

# 11. an inert shared-main member (passes an off-main commit) is caught by the
#     live probe: the install rolls back and leaves no member behind
mkdir -p "$TMP/inertkit/scripts"
cp "$INSTALLER" "$TMP/inertkit/scripts/install-commit-msg-bead.sh"
# Derive the foreign-install dependency closure from the exact manifest consumed
# by installation and --check, including optional copied helpers and their data.
python3 - "$INSTALLER" "$TMP/inertkit" <<'PY'
import pathlib, shutil, sys
installer = pathlib.Path(sys.argv[1])
root = installer.parent.parent
destination = pathlib.Path(sys.argv[2])
manifest = installer.read_text().split("<<'INSTALLATION_MANIFEST'\n", 1)[1].split("\nINSTALLATION_MANIFEST", 1)[0]
rows = [line.split() for line in manifest.splitlines() if line.strip()]
if not rows or any(len(row) != 5 for row in rows):
    raise ValueError('invalid canonical installation manifest')
sources = {row[3] for row in rows}
for relative in sorted(sources - {'scripts/check-pushed-on-main.sh'}):
    target = destination / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(root / relative, target)
PY
printf '#!/bin/sh\nexit 0\n' > "$TMP/inertkit/scripts/check-pushed-on-main.sh"
K=$(new_repo inert) || exit 1
git -C "$K" branch -M main
sh "$TMP/inertkit/scripts/install-commit-msg-bead.sh" "$K" > "$TMP/o-inert" 2>&1
ok "$?" "1" "inert-member-rollback-rc"
if grep -q "shared-main member let an off-main commit move the remote main" "$TMP/o-inert"; then
	ok 0 0 "inert-member-named"
else
	ok 1 0 "inert-member-named"
	cat "$TMP/o-inert"
fi
if [ ! -e "$K/.git/hooks/hooks.d/pre-push/30-omp-kit-on-main" ]; then
	ok 0 0 "inert-member-removed"
else
	ok 1 0 "inert-member-removed"
fi
}

group_gatediag() {

# 12. GATEDIAG1 (ompkit-fp72.135.3.16): runner v4 collects every FINDING line from every member into one
#     envelope and exits once; a legacy refusing member becomes one MEMBER_REFUSED finding; planted: a
#     member that stops at its first finding reports one where two exist, and the selftest names it.
G=$(new_repo gatediag) || exit 1
git -C "$G" branch -M main
sh "$INSTALLER" --no-pushed-beads "$G" > "$TMP/o-gatediag" 2>&1
ok "$?" "0" "gatediag-install"
D="$G/.git/hooks/hooks.d/commit-msg"
# shellcheck disable=SC2016  # the fixture members are written verbatim; expansion happens when they run
printf '%s\n' '#!/bin/sh' 'here=$(CDPATH="" cd -- "$(dirname -- "$0")" && pwd -P)' '. "$here/kitlib-findings.sh"' 'kitlib_finding fx A "first" "r1" git x' 'kitlib_finding fx B "second" "r2"' 'exit 0' > "$D/60-fx-complete"
# shellcheck disable=SC2016
printf '%s\n' '#!/bin/sh' 'here=$(CDPATH="" cd -- "$(dirname -- "$0")" && pwd -P)' '. "$here/kitlib-findings.sh"' 'kitlib_finding stop A "first" "r1"' 'exit 1' 'kitlib_finding stop B "second" "r2"' > "$D/61-fx-stop"
printf '%s\n' '#!/bin/sh' 'echo "legacy: REFUSED: old style" >&2' 'exit 7' > "$D/62-fx-legacy"
chmod +x "$D/60-fx-complete" "$D/61-fx-stop" "$D/62-fx-legacy"
git -C "$G" commit -q --allow-empty -m 'feat: no level' > "$TMP/o-gd-commit" 2>&1
ok "$?" "1" "gatediag-one-exit"
ok "$(grep -c 'REFUSED: [0-9]* finding' "$TMP/o-gd-commit")" "1" "gatediag-one-envelope"
grep -q 'fx A: first' "$TMP/o-gd-commit" && grep -q 'fx B: second' "$TMP/o-gd-commit" && grep -q 'fix: git x' "$TMP/o-gd-commit"
ok "$?" "0" "gatediag-every-finding-with-fix"
grep -q '62-fx-legacy MEMBER_REFUSED: legacy: REFUSED: old style' "$TMP/o-gd-commit"
ok "$?" "0" "gatediag-legacy-member-is-one-finding"
# planted: the stop-at-first member reported only its first finding; a complete member reports both
ok "$(grep -c 'stop [AB]:' "$TMP/o-gd-commit")" "1" "gatediag-planted-stop-at-first-reports-one"
ok "$(grep -c 'fx [AB]:' "$TMP/o-gd-commit")" "2" "gatediag-complete-member-reports-two"

# Interpreter dispatch: a preserved bash member must reach its real refusal.
cat > "$D/63-fx-bash" <<'HOOK'
#!/bin/bash
read -r value < <(printf 'bash-ready\n')
[ "$value" = bash-ready ] || exit 9
printf 'FINDING\tbash\tBASH_POLICY\tactual bash refusal\tfix the policy\t-\n'
exit 6
HOOK
printf 'printf "plain-member-ran\\n"\n' > "$D/64-fx-plain"
chmod +x "$D/63-fx-bash" "$D/64-fx-plain"
# Recreate the message after the earlier plain-hook case appended its marker.
printf 'fix widgets ompkit-2w7h\nMARKED' > "$TMP/msg-b"
(CDPATH='' cd -- "$G" && BEADS_DB="$TMP/absent.db" sh "$G/.git/hooks/commit-msg" "$TMP/msg-b") > "$TMP/o-interpreters" 2>&1
ok "$?" "1" "interpreter-real-refusal-retained"
grep -q 'bash BASH_POLICY: actual bash refusal' "$TMP/o-interpreters"
ok "$?" "0" "bash-member-own-finding"
grep -q 'plain-member-ran' "$TMP/o-interpreters"
ok "$?" "0" "no-shebang-member-fallback"
}

group_atomic() {
# The Python contract resolves root/absent; never share it with A's mutations.
A=$(installed_repo absent) || exit 1

# Budgets hold under gate load: the installer alone ran past 30 s beside the other suites (2026-11-03).
# Pause a real shell reader before its final read. Installing must replace,
# never truncate, the managed member it is currently reading.
python3 - "$TMP" "$INSTALLER" <<'PY'
import concurrent.futures
import pathlib
import socket
import sys
sys.path.insert(0, str(pathlib.Path(sys.argv[2]).parent))
import kitlib_run
root, installer = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
repo = root / "absent"
member = repo / ".git/hooks/hooks.d/commit-msg/40-omp-kit-commit-msg-bead"
original = member.read_bytes()
with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
    for atomic in (True, False):
        with socket.socket() as server:
            server.bind(("127.0.0.1", 0))
            server.listen(1)
            server.settimeout(150)
            port = server.getsockname()[1]
            pause = 'import socket; s=socket.create_connection(("127.0.0.1", %d), timeout=150); s.recv(1); s.close()' % port
            body = "#!/bin/sh\npython3 -c '%s'\n" % pause
            body += "# padding forces a later shell read\n" * 8192
            body += "printf 'OLD_BYTES_FINISHED\\n'\n"
            member.write_text(body)
            result = pool.submit(kitlib_run.run, ["sh", str(member)], cwd=str(repo), deadline_s=180)
            with server.accept()[0] as conn:
                if atomic:
                    installed = kitlib_run.run(["sh", str(installer), str(repo)], deadline_s=120)
                    assert installed.rc == 0, (installed.stdout, installed.stderr)
                else:
                    # The old copy-in-place operation, the required negative.
                    member.write_bytes(original)
                conn.sendall(b"x")
            finished = result.result(timeout=200)
            survived = finished.rc == 0 and b"OLD_BYTES_FINISHED" in finished.stdout
            assert survived == atomic, (atomic, finished)
            print("atomic-running-member" if atomic else "copy-in-place-negative")
member.write_bytes(original)
PY
ok "$?" "0" "atomic-install-and-copy-negative"
}

# Workers own their fixtures, installer probe temp files, messages and outputs.
# Keep counters in the parent only after joining; a crashed worker cannot pass.
RESULTS="$TMP/results"
mkdir -p "$RESULTS" || exit 1
SUITE_TMP=$TMP
# A completed worker releases its slot immediately, not in launch order.
mkfifo "$RESULTS/completed" || exit 1
exec 3<> "$RESULTS/completed"
group_pids=
group_count=0
worker_failed=0

stop_groups() {
	for entry in $group_pids; do kill "${entry#*=}" 2>/dev/null || :; done
	for entry in $group_pids; do wait "${entry#*=}" 2>/dev/null || :; done
}
kitlib_tmp_atexit stop_groups

# shellcheck disable=SC2030 # run_group counts in its own subshell; the parent reads RESULTS/<group>.counts
run_group() (
	group=$1
	pass=0
	fail=0
	# Reset the inherited cleanup registry before allocating worker-owned temp.
	# shellcheck source=scripts/kitlib-tmp.sh
	. "$KITLIB"
	KITLIB_TMP_ROOT="$SUITE_TMP" kitlib_tmp TMP install-bead-group || exit 1
	export TMPDIR="$TMP"
	EMPTY_DB="$TMP/empty.db"
	: > "$EMPTY_DB"
	"$group"
	group_rc=$?
	printf '%s %s\n' "$pass" "$fail" > "$RESULTS/$group.counts"
	exit "$group_rc"
)

# shellcheck disable=SC2031 # sums the counters each run_group subshell wrote to RESULTS/<group>.counts
join_group() {
	IFS= read -r group <&3 || exit 1
	remaining=
	pid=
	for entry in $group_pids; do
		case "$entry" in
			"$group="*) pid=${entry#*=} ;;
			*) remaining="$remaining $entry" ;;
		esac
	done
	[ -n "$pid" ] || exit 1
	group_pids=$remaining
	if wait "$pid"; then
		:
	else
		group_rc=$?
		worker_failed=1
		printf 'FAIL %s: worker exited %s\n' "$group" "$group_rc"
	fi
	# The worker has exited before its counters and complete log are read.
	group_count=$((group_count - 1))
	cat "$RESULTS/$group.log" || worker_failed=1
	if [ -f "$RESULTS/$group.counts" ] &&
		IFS=' ' read -r group_pass group_fail < "$RESULTS/$group.counts"; then
		pass=$((pass + group_pass))
		fail=$((fail + group_fail))
	else
		worker_failed=1
		printf 'FAIL %s: worker did not publish assertion counts\n' "$group"
	fi
}

start_group() {
	(
		run_group "$1"
		rc=$?
		printf '%s\n' "$1" >&3
		exit "$rc"
	) > "$RESULTS/$1.log" 2>&1 &
	group_pids="$group_pids $1=$!"
	group_count=$((group_count + 1))
	# Fixed fan-out, independent of assertion count and host CPU discovery.
	if [ "$group_count" -ge 8 ]; then join_group; fi
}

run_installer_groups() {
	for group do start_group "$group"; done
	while [ "$group_count" -gt 0 ]; do join_group; done
	printf 'install-commit-msg-bead: %s pass %s fail\n' "$pass" "$fail"
	[ "$fail" = "0" ] && [ "$worker_failed" = "0" ]
}
