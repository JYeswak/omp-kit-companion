#!/bin/sh
# install-flags.test.sh — INSTALLFLAG1 contract (ompkit-t7cn7.9).
# Every scripts/install-*.sh refuses an argument it does not know (usage line
# on stderr, exit 2, nothing written), and install-pre-push-gate.sh offers a
# read-only --check matching install-commit-msg-bead.sh (exit 3 with STALE or
# MISSING lines when the installed member differs, exit 0 when fresh, no
# writes). Fixture repos are disposable: nothing here touches the live
# checkout's hooks (the installers resolve their own checkout as ROOT).
set -u
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
SCRIPTS=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)
REPO_TMP=$(CDPATH='' cd -- "$(dirname -- "$0")/../../var/agent-tmp" && pwd -P)
# Owned fixture root, removed on exit and on HUP/INT/TERM (kitlib, J-2026-10-22-06).
# shellcheck source=scripts/kitlib-tmp.sh
. "$SCRIPTS/kitlib-tmp.sh"
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP install-flags-test || exit 1
TMP=$(CDPATH='' cd -- "$TMP" && pwd -P) || exit 1

pass=0
fail=0
ok() {
	if [ "$1" = "$2" ]; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: got %s want %s\n' "$3" "$1" "$2"; fi
}
ok_grep() {
	if grep -q "$2" "$1"; then pass=$((pass + 1));
	else fail=$((fail + 1)); printf 'FAIL %s: %s not found in %s\n' "$3" "$2" "$1"; fi
}
snapshot() {
	# $1 = dir; stable byte-identity listing for "writes nothing" assertions.
	(cd "$1" && find . -type f -exec cksum {} + | sort)
}

new_repo() {
	dir="$TMP/$1"
	mkdir -p "$dir"
	git -C "$dir" init -q 2>/dev/null
	printf '%s' "$dir"
}

# --- fixture: repo with a populated hooks tree the installers must not touch.
R=$(new_repo refusing)
mkdir -p "$R/.git/hooks/hooks.d/pre-push" "$R/.git/hooks/hooks.d/pre-commit"
printf '#!/bin/sh\nexit 0\n' > "$R/.git/hooks/pre-push"
printf '#!/bin/sh\nexit 0\n' > "$R/.git/hooks/pre-commit"
printf 'dummy\n' > "$R/.git/hooks/hooks.d/pre-push/00-dummy"
chmod +x "$R/.git/hooks/pre-push" "$R/.git/hooks/pre-commit"
BEFORE=$(snapshot "$R")

# 1. every installer refuses an unknown flag with a usage line and exit 2.
n=0
for script in install-pre-push-gate install-commit-msg-bead install-extensions install-agent-trailer-hook install-pre-commit-storage-root-gate install-sync-check; do
	n=$((n + 1))
	out="$TMP/refuse-$n.log"
	if sh "$SCRIPTS/$script.sh" --bogus-xyz >"$out" 2>&1; then rc=0; else rc=$?; fi
	ok "$rc" "2" "$script-unknown-rc"
	ok_grep "$out" "Usage:" "$script-unknown-usage"
	ok_grep "$out" "unknown argument" "$script-unknown-names-flag"
done
ok "$(snapshot "$R")" "$BEFORE" "refusals-write-nothing"

# 2. refusals precede repo checks: no-repo cwd still gets usage + exit 2.
mkdir -p "$TMP/norepo"
for script in install-pre-push-gate install-agent-trailer-hook install-pre-commit-storage-root-gate; do
	out="$TMP/norepo-$script.log"
	if (CDPATH='' cd -- "$TMP/norepo" && sh "$SCRIPTS/$script.sh" --bogus-xyz >"$out" 2>&1); then rc=0; else rc=$?; fi
	ok "$rc" "2" "$script-norepo-rc"
	ok_grep "$out" "Usage:" "$script-norepo-usage"
done

# 3. extra positionals are refused, not silently ignored.
if sh "$SCRIPTS/install-commit-msg-bead.sh" "$R" "$R" >"$TMP/extra1.log" 2>&1; then rc=0; else rc=$?; fi
ok "$rc" "2" "commit-msg-bead-extra-positional-rc"
ok_grep "$TMP/extra1.log" "Usage:" "commit-msg-bead-extra-positional-usage"
if sh "$SCRIPTS/install-sync-check.sh" "$R" "$R" >"$TMP/extra2.log" 2>&1; then rc=0; else rc=$?; fi
ok "$rc" "2" "sync-check-extra-positional-rc"
ok_grep "$TMP/extra2.log" "Usage:" "sync-check-extra-positional-usage"
if sh "$SCRIPTS/install-extensions.sh" --dry-run --bogus >"$TMP/extra3.log" 2>&1; then rc=0; else rc=$?; fi
ok "$rc" "2" "extensions-second-arg-rc"
ok_grep "$TMP/extra3.log" "Usage:" "extensions-second-arg-usage"
if sh "$SCRIPTS/install-pre-push-gate.sh" "$R" >"$TMP/extra4.log" 2>&1; then rc=0; else rc=$?; fi
ok "$rc" "2" "pre-push-install-positional-rc"
ok_grep "$TMP/extra4.log" "Usage:" "pre-push-install-positional-usage"
ok "$(snapshot "$R")" "$BEFORE" "extra-positionals-write-nothing"

# 4. pre-push --check: MISSING member reports and exits 3, writes nothing.
C=$(new_repo checkmissing)
mkdir -p "$C/.git/hooks/hooks.d/pre-push"
printf 'dummy\n' > "$C/.git/hooks/hooks.d/pre-push/00-dummy"
C_BEFORE=$(snapshot "$C")
if sh "$SCRIPTS/install-pre-push-gate.sh" --check "$C" >"$TMP/check-missing.log" 2>&1; then rc=0; else rc=$?; fi
ok "$rc" "3" "check-missing-rc"
ok_grep "$TMP/check-missing.log" "MISSING installed member" "check-missing-names-member"
ok "$(snapshot "$C")" "$C_BEFORE" "check-missing-writes-nothing"

# 5. pre-push --check: FRESH member exits 0 with the fresh line, writes nothing.
F=$(new_repo checkfresh)
mkdir -p "$F/.git/hooks/hooks.d/pre-push"
printf 'dummy\n' > "$F/.git/hooks/hooks.d/pre-push/00-dummy"
cp "$SCRIPTS/pre-push-gate.sh" "$F/.git/hooks/hooks.d/pre-push/40-omp-kit-fresh-gate"
F_BEFORE=$(snapshot "$F")
if sh "$SCRIPTS/install-pre-push-gate.sh" --check "$F" >"$TMP/check-fresh.log" 2>&1; then rc=0; else rc=$?; fi
ok "$rc" "0" "check-fresh-rc"
ok_grep "$TMP/check-fresh.log" "hooks fresh" "check-fresh-names-fresh"
ok "$(snapshot "$F")" "$F_BEFORE" "check-fresh-writes-nothing"

# 6. pre-push --check: STALE member exits 3 naming the drift, writes nothing.
printf '# stale-marker\n' >> "$F/.git/hooks/hooks.d/pre-push/40-omp-kit-fresh-gate"
F_STALE_BEFORE=$(snapshot "$F")
if sh "$SCRIPTS/install-pre-push-gate.sh" --check "$F" >"$TMP/check-stale.log" 2>&1; then rc=0; else rc=$?; fi
ok "$rc" "3" "check-stale-rc"
ok_grep "$TMP/check-stale.log" "STALE installed member" "check-stale-names-member"
ok_grep "$TMP/check-stale.log" "differs from" "check-stale-names-source"
ok "$(snapshot "$F")" "$F_STALE_BEFORE" "check-stale-writes-nothing"

# 7. pre-push --check against a non-repo refuses without writing.
# GIT_CEILING_DIRECTORIES stops upward discovery into the enclosing checkout,
# so the target really is a non-repo.
if GIT_CEILING_DIRECTORIES="$TMP" sh "$SCRIPTS/install-pre-push-gate.sh" --check "$TMP/norepo" >"$TMP/check-norepo.log" 2>&1; then rc=0; else rc=$?; fi
ok "$rc" "2" "check-norepo-rc"

printf 'install-flags: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
