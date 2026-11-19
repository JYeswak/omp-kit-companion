#!/bin/sh
# HOOKCHAIN1: the refresh must not break the verification-level pair in an active hook chain.
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$root/tests/cli/git-env-fixtures.sh"
# shellcheck source=scripts/kitlib-tmp.sh
. "$root/scripts/kitlib-tmp.sh"
kitlib_tmp TMP hook-chain-migrate || exit 1
export TMPDIR="$TMP"
unset BEADS_DIR
installer="$root/scripts/install-commit-msg-bead.sh"
repo="$TMP/work"
origin="$TMP/origin.git"
hooks="$repo/.githooks"
mirror="$repo/.git/omp-kit-hooks/hooks.d"
pre_push="$hooks/hooks.d/pre-push/41-omp-kit-pushed-vlevel"
legacy="$hooks/hooks.d/commit-msg/41-omp-kit-commit-msg-vlevel"

pass=0
fail=0
check() {
	name=$1; shift
	if "$@"; then pass=$((pass + 1)); printf 'ok - %s\n' "$name"
	else fail=$((fail + 1)); printf 'not ok - %s\n' "$name"; fi
}

git init -q --bare "$origin"
git -c init.templateDir= init -q -b main "$repo"
git -C "$repo" config user.name 'Fixture'
git -C "$repo" config user.email 'fixture@invalid.example'
git -C "$repo" remote add origin "$origin"
mkdir -p "$hooks/hooks.d/pre-push"
printf '# Owner files are not managed by the installer.\n' >"$hooks/README"
git -C "$repo" add .githooks/README
git -C "$repo" commit -qm 'test: seed owned fixture [test]'
git -C "$repo" push -q -u origin main
git -C "$repo" config core.hooksPath .githooks
sh "$installer" "$repo" >"$TMP/mirror.out" 2>&1 || { cat "$TMP/mirror.out"; exit 1; }

# Model a tracked pre-push member that still runs before the managed dispatcher.
# Its legacy commit-msg partner is an older local install, not an index entry.
cp "$root/scripts/pre-push-verification-level.sh" "$pre_push"
chmod +x "$pre_push"
git -C "$repo" add -- .githooks/hooks.d/pre-push/41-omp-kit-pushed-vlevel
before=$(git -C "$repo" rev-parse HEAD)
tree=$(git -C "$repo" write-tree)
tip=$(git -C "$repo" commit-tree "$tree" -p "$before" -m 'test: tracked hook fixture ompkit-03yyo [test]')
git -C "$repo" update-ref refs/heads/main "$tip" "$before"
cp "$root/scripts/commit-msg-verification-level.sh" "$legacy"
chmod +x "$legacy"

out="$TMP/refresh.out"
check 'refresh succeeds with an intact legacy pair and managed mirror' sh "$installer" "$repo" >"$out" 2>&1
if [ "$fail" -ne 0 ]; then cat "$out"; fi
check 'refresh leaves tracked pre-push member byte-identical' cmp -s "$pre_push" "$root/scripts/pre-push-verification-level.sh"
check 'refresh does not dirty tracked hook files' git -C "$repo" diff --exit-code -- .githooks
check 'real tagged push succeeds through the tracked chain and its mirror' git -C "$repo" push -q origin main
check 'bare origin received the exact tagged commit' test "$(git -C "$origin" rev-parse refs/heads/main)" = "$tip"

# Keep both root entries and the valid mirror, but plant the exact half-migration
# in the tracked root: active tracked push 41, neither old commit 41 nor folded 55.
if [ -e "$legacy" ]; then mv "$legacy" "$TMP/legacy.saved"; fi
printf '\n# Fixture: distinct pre-refresh mirror bytes must survive rollback.\n' >>"$mirror/pre-push/41-omp-kit-pushed-vlevel"
cp -p "$mirror/pre-push/41-omp-kit-pushed-vlevel" "$TMP/mirror-before"
rc=0
sh "$installer" "$repo" >"$TMP/planted.out" 2>&1 || rc=$?
check 'installer refuses the half-migration despite a complete mirror' test "$rc" -ne 0
check 'installer postcheck names the actual broken pair' grep -Fq "MISSING paired commit-msg member: $legacy" "$TMP/planted.out"
check 'rollback preserves the pre-existing mirror member' cmp -s "$mirror/pre-push/41-omp-kit-pushed-vlevel" "$TMP/mirror-before"
check 'rollback preserves the tracked push member and exact index' git -C "$repo" diff --exit-code HEAD -- .githooks
if [ "$fail" -ne 0 ]; then cat "$TMP/planted.out"; fi

# A tracked push member may already depend on a folded close in the outer
# chain. Install that shape from the actual managed copy, not a stub.
outer_commit="$hooks/hooks.d/commit-msg"
mkdir -p "$outer_commit/scripts"
cp -p "$mirror/commit-msg/55-omp-kit-commit-gate" "$mirror/commit-msg/kitlib-tmp.sh" \
	"$mirror/commit-msg/kitlib-findings.sh" "$outer_commit/"
cp -p "$mirror/commit-msg/scripts/"* "$outer_commit/scripts/"
check 'refresh keeps an existing folded pair coherent beside the mirror' sh "$installer" "$repo" >"$TMP/folded.out" 2>&1
if [ "$fail" -ne 0 ]; then cat "$TMP/folded.out"; fi
check 'outer folded close retains its pinned verification helper' cmp -s \
	"$outer_commit/scripts/commit-msg-verification-level.sh" "$root/scripts/commit-msg-verification-level.sh"
next_tip=$(git -C "$repo" commit-tree "$tree" -p "$tip" -m 'test: folded hook fixture ompkit-03yyo [test]')
git -C "$repo" update-ref refs/heads/main "$next_tip" "$tip"
check 'real tagged push succeeds with the outer folded pair' git -C "$repo" push -q origin main
check 'bare origin received the exact folded-pair commit' test "$(git -C "$origin" rev-parse refs/heads/main)" = "$next_tip"
printf 'hook-chain-migrate: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
