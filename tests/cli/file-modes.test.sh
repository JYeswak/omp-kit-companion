#!/bin/sh
# file-modes.test.sh — committed executable-bit contract.
# Scripts the fleet executes directly (shebang, hook, symlink target) must be
# committed 100755, or fresh clones break (ID1 boxes 3-4 grade FAIL).
# Live repo: judges the committed tree (HEAD), never the worktree, so a dirty
# chmod never masks a committed 100644. Exact `git archive` export (nested
# anywhere, no object store, no OMP_KIT_CASE_CWD): tar preserves the committed
# executable bit, so the exported files ARE the committed modes; no ambient
# Git object store is consulted, so an enclosing checkout cannot mask a
# committed 100644 either.
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P) || exit 1
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$ROOT/tests/cli/git-env-fixtures.sh"
# Reuse package-release.test.ts's archive provenance: export-subst records the
# immutable revision. Archive or live is decided by that stamp alone — never by
# OMP_KIT_CASE_CWD, which fresh-gate does not export.
revision=$(bun -e 'const p = await Bun.file(process.argv[1]).json(); if (typeof p.source_revision !== "string") process.exit(1); process.stdout.write(p.source_revision);' "$ROOT/package.json") || exit 1
pass=0
fail=0
check() {
	if [ "$1" = "100755" ]; then
		pass=$((pass + 1))
	else
		fail=$((fail + 1)); printf 'FAIL mode: %s committed as %s, want 100755\n' "$2" "${1:-missing}"
	fi
}
if [ "$revision" != "\$Format:%H\$" ]; then
	case "$revision" in ''|*[!0123456789abcdef]*) printf 'FAIL source: invalid archive revision\n' >&2; exit 1 ;; esac
	[ "${#revision}" -eq 40 ] || { printf 'FAIL source: incomplete archive revision\n' >&2; exit 1; }
	[ -z "${OMP_KIT_CASE_SOURCE_SHA:-}" ] || [ "$OMP_KIT_CASE_SOURCE_SHA" = "$revision" ] || {
		printf 'FAIL source: selected revision differs from immutable archive\n' >&2; exit 1;
	}
	for file in scripts/br-shim.sh scripts/agent-spawn-env.sh scripts/agent-trailer-hook.sh scripts/close-guard.sh; do
		if [ ! -e "$ROOT/$file" ]; then
			check missing "$file"
		elif [ -x "$ROOT/$file" ]; then
			check 100755 "$file"
		else
			check 100644 "$file"
		fi
	done
else
	top=$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null) || exit 1
	[ "$top" = "$ROOT" ] || { printf 'FAIL source: refusing enclosing Git worktree\n' >&2; exit 1; }
	subject=$(git -C "$ROOT" rev-parse --verify --end-of-options "${OMP_KIT_CASE_SOURCE_SHA:-HEAD}^{commit}" 2>/dev/null) || {
		printf 'FAIL source: committed subject unavailable\n' >&2; exit 1;
	}
	for file in scripts/br-shim.sh scripts/agent-spawn-env.sh scripts/agent-trailer-hook.sh scripts/close-guard.sh; do
		check "$(git -C "$ROOT" ls-tree "$subject" -- "$file" 2>/dev/null | awk '{ print $1 }')" "$file"
	done
fi

printf 'file-modes: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
