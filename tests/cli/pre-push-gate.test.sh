#!/bin/sh
# Keep each independent adapter contract family schedulable by the shared suite pool.
# Preserve one-hop affected-test edges for the shared fixture's production inputs:
# scripts/pre-push-gate.sh scripts/fresh-gate.sh scripts/check-commit-gate.sh
# scripts/full-suite-verdict.sh scripts/full-suite-verdict-store.py
# scripts/suite-metrics.py scripts/suite-hermetic-env.sh scripts/kitlib-tmp.sh
# scripts/kitlib_run.py scripts/kitlib_tmp.py scripts/pysafe.py
# scripts/regexploit-gate.py scripts/doc-drift-check.sh src/cli.ts src/land-guard.ts
# shellcheck source=tests/cli/pre-push-gate-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/pre-push-gate-fixtures.sh"
adapter_cases

# GATEBASE-NOTES1: exercise the real notes phase through commit --only, with
# Git's alternate index and hook selectors. Other phases have adapter_cases
# coverage above; this fixture keeps the incumbent notes function unchanged.
notes_hook_cases() (
	notes_repo="$TMP/notes-hook"
	copy_fixture "$REPO_SEED" "$notes_repo" || exit 1
	for dependency in check-pushed-notes.sh release-notes.sh release-notes.ts kitlib-tmp.sh; do
		cp "$KITREPO/scripts/$dependency" "$notes_repo/scripts/" || exit 1
	done
	mkdir -p "$notes_repo/changelog.d"
	printf '# Changelog\n\n## [Unreleased]\n\n## [0.0.0] - 2026-01-01\n\n- Initial release.\n' >"$notes_repo/CHANGELOG.md"
	printf '#!/bin/sh\nexit 0\n' >"$notes_repo/scripts/full-suite-verdict.sh"
	cat >"$TMP/notes-header" <<'SH'
#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd -P)
ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd -P)
SH
	# Same function extraction as fresh-gate.helpers.ts; execute production
	# notes/run_step, not an echo claiming the notes checker passed.
	if python3 - "$KITREPO/scripts/fresh-gate.sh" "$TMP" <<'PY'
from pathlib import Path
import sys
source, destination = Path(sys.argv[1]).read_text(), Path(sys.argv[2])
for name in ("run_step", "gate_notes"):
    start = source.index("\n" + name + "() {") + 1
    end = source.index("\n}\n", start) + 3
    (destination / name).write_text(source[start:end])
PY
	then
		:
	else
		exit 1
	fi
	cat >"$TMP/notes-driver" <<'SH'
while [ "$#" -gt 0 ]; do
	case "$1" in
		--archive-dir) ARCHIVE_DIR=$2; shift 2 ;;
		--base) BASE=$2; shift 2 ;;
		--commit) COMMIT=$2; shift 2 ;;
		--changed-file) shift 2 ;;
		*) exit 2 ;;
	esac
done
WORK="$ROOT/var/agent-tmp/notes-phase"
mkdir -p "$WORK"
printf 'NOTES-BOUNDARY cwd=%s ROOT=%s FRESH_GATE_REPO=%s GIT_DIR=%s GIT_INDEX_FILE=%s discovered=%s\n' \
	"$(pwd -P)" "$ROOT" "$FRESH_GATE_REPO" "${GIT_DIR-unset}" "${GIT_INDEX_FILE-unset}" \
	"$(git -C "$ROOT" rev-parse --absolute-git-dir)"
run_step notes gate_notes
# The real base gate's focused phase initializes the shared candidate archive
# for contributor-only test paths before the candidate gate starts.
git -C "$ARCHIVE_DIR" init --template= -q
SH
	# Frozen incumbent behavior: ROOT is its base archive (no .git yet).
	cat "$TMP/notes-header" "$TMP/run_step" >"$notes_repo/scripts/fresh-gate.sh"
	cat >>"$notes_repo/scripts/fresh-gate.sh" <<'SH'
gate_notes() {
	sh "$SCRIPT_DIR/check-pushed-notes.sh" --repo "$ROOT" --base "$BASE" --tip "$COMMIT" --archive-dir "$ARCHIVE_DIR"
}
SH
	cat "$TMP/notes-driver" >>"$notes_repo/scripts/fresh-gate.sh"
	git -C "$notes_repo" add -- scripts tests CHANGELOG.md || exit 1
	git -C "$notes_repo" commit -qm '[test] notes incumbent' || exit 1
	notes_base=$(git -C "$notes_repo" rev-parse HEAD)
	git -C "$notes_repo" update-ref refs/remotes/origin/main "$notes_base" || exit 1
	git -C "$notes_repo" branch -M main || exit 1
	git -C "$notes_repo" config core.hooksPath "$notes_repo/.git/hooks"
	mkdir -p "$notes_repo/.git/hooks/hooks.d/pre-push"
	cp "$ADAPTER" "$notes_repo/.git/hooks/hooks.d/pre-push/40-omp-kit-fresh-gate"
	cp "$KITREPO/scripts/check-commit-gate.sh" "$notes_repo/.git/hooks/commit-msg"
	chmod +x "$notes_repo/.git/hooks/commit-msg" "$notes_repo/.git/hooks/hooks.d/pre-push/40-omp-kit-fresh-gate"
	cat "$TMP/notes-header" "$TMP/run_step" "$TMP/gate_notes" "$TMP/notes-driver" >"$notes_repo/scripts/fresh-gate.sh"
	printf '#!/bin/sh\nexit 0\n# judging-path revision\n' >"$notes_repo/scripts/full-suite-verdict.sh"
	printf '### Fixed\n\n- Keep notes coverage bound to the pushing repository.\n' >"$notes_repo/changelog.d/313.md"
	git -C "$notes_repo" add -- changelog.d/313.md || exit 1
	# A pre-commit hook observes the real selectors before the commit-msg gate.
	cat >"$notes_repo/.git/hooks/pre-commit" <<'SH'
#!/bin/sh
printf 'HOOK-ENV cwd=%s GIT_DIR=%s GIT_INDEX_FILE=%s\n' "$(pwd -P)" "${GIT_DIR-unset}" "${GIT_INDEX_FILE-unset}"
[ -n "${GIT_DIR:-}" ] && [ -n "${GIT_INDEX_FILE:-}" ]
SH
	chmod +x "$notes_repo/.git/hooks/pre-commit"
	# Explicit GIT_DIR matches the installed hook chain; Git itself supplies
	# the alternate GIT_INDEX_FILE for --only (never a fabricated index).
	(cd "$notes_repo" && GIT_DIR=.git git commit --only -qm '[test] notes hook control' -m 'Bead: fixture-313' -- \
		scripts/fresh-gate.sh scripts/full-suite-verdict.sh changelog.d/313.md) >"$TMP/notes-hook.out" 2>&1
	notes_rc=$?
	cat "$TMP/notes-hook.out"
	if [ "$notes_rc" != 0 ] || [ "$(grep -Fc 'GREEN notes' "$TMP/notes-hook.out")" != 2 ]; then
		printf 'FAIL notes-hook-control: rc=%s; both roles must pass notes\n' "$notes_rc"
		exit 1
	fi
	printf 'PASS notes-hook-control: commit --only; base and candidate GREEN notes\n'
	# Both roles must still reject a later shipped change without its own
	# fragment. The adapter stops on base RED, so replay candidate separately.
	printf '# missing fragment\n' >>"$notes_repo/scripts/full-suite-verdict.sh"
	(cd "$notes_repo" && GIT_DIR=.git git commit --only -qm '[test] notes missing fragment' -m 'Bead: fixture-314' -- \
		scripts/full-suite-verdict.sh) >"$TMP/notes-negative-base.out" 2>&1
	notes_rc=$?
	cat "$TMP/notes-negative-base.out"
	if [ "$notes_rc" = 0 ] || ! grep -Fq 'RED notes producer_rc=1' "$TMP/notes-negative-base.out" \
		|| ! grep -Fq 'has no changelog fragment: changelog.d/314.md' "$TMP/notes-negative-base.out"; then
		printf 'FAIL notes-hook-negative-base: rc=%s\n' "$notes_rc"
		exit 1
	fi
	git -C "$notes_repo" add -- scripts/full-suite-verdict.sh || exit 1
	notes_tree=$(git -C "$notes_repo" write-tree)
	notes_tip=$(printf '[test] missing fragment\n\nBead: fixture-314\n' | git -C "$notes_repo" commit-tree "$notes_tree" -p HEAD)
	mkdir -p "$TMP/notes-negative-archive"
	git -C "$notes_repo" archive "$notes_tip" | tar -xf - -C "$TMP/notes-negative-archive" || exit 1
	git -C "$TMP/notes-negative-archive" init --template= -q
	(cd "$notes_repo" && FRESH_GATE_REPO="$notes_repo" sh "$TMP/notes-negative-archive/scripts/fresh-gate.sh" \
		--archive-dir "$TMP/notes-negative-archive" --base "$notes_base" --commit "$notes_tip") >"$TMP/notes-negative-candidate.out" 2>&1
	notes_rc=$?
	cat "$TMP/notes-negative-candidate.out"
	if [ "$notes_rc" = 0 ] || ! grep -Fq 'RED notes producer_rc=1' "$TMP/notes-negative-candidate.out" \
		|| ! grep -Fq 'has no changelog fragment: changelog.d/314.md' "$TMP/notes-negative-candidate.out"; then
		printf 'FAIL notes-hook-negative-candidate: rc=%s\n' "$notes_rc"
		exit 1
	fi
	printf 'PASS notes-hook-negative: missing fragment RED notes in both roles\n'
)
if notes_hook_cases; then pass=$((pass + 3)); else fail=$((fail + 1)); fi
printf 'pre-push-gate: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
