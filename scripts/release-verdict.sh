#!/bin/sh
# scripts/release-verdict.sh: RELCLOCK1 (ompkit-774u.67), the release's full suite on the published head.
#
# Since GATESPEED1 (J-2026-10-31-09) a push no longer runs the complete suite; release-local refuses
# any source tree without a main-role full-suite PASS. This script produces that verdict ahead of the
# release, so the release reads it instead of waiting about 25 minutes:
#
#   1. resolve the commit (default: the remote-tracking origin/main after a fetch);
#   2. take a per-repo lock; when another run holds it, record the wanted commit and exit 0, and the
#      holder runs again for the newest published head before it releases the lock;
#   3. export the exact commit and run that commit's own scripts/full-suite-verdict.sh from the export
#      (never the working tree: editing the runner mid-run killed a 25-minute suite on 2026-10-31);
#   4. CULPRIT1 (ompkit-6xxhu): when the runner fails, run that export's scripts/verdict-culprit.py,
#      which bisects the failing test files over the commits since the last main-role PASS and logs
#      `release-verdict: CULPRIT <sha> <author> <bead>` or `release-verdict: CULPRIT none (<reason>)`,
#      plus a `PROPOSE: git revert ...` line (never run) when the head stayed red for a wave. The
#      culprit step never changes this script's exit status.
#   5. CIONLY1 (J-2026-11-03-34): beside the full suite, the export's own full-suite-verdict-store.py
#      `run-ci-only` judges the two files gate-ci-only.tsv keeps out of it (package-release.test.ts and
#      kit-update.test.ts) on a second export of the same commit, git-initialized with that commit as
#      release-local's ci-only-local stage prepares it, and records PASS/FAIL for the exact tree; a cut
#      reuses a PASS instead of running them (up to 900/2400 s) after build, sign and notarize. Its
#      output (every failing file's, in one run) is printed after the suite's. Exports without
#      run-ci-only (commits before it) skip this step silently; release-local then runs the files.
#
# A tree that already has a verdict is a cache hit and returns at once. Called with no arguments by
# the publisher after a successful push, or by hand before release-local.
#
# Usage: scripts/release-verdict.sh [--commit SHA] [--no-fetch]
# Exit: the verdict runner's status (0 PASS), else the ci-only step's when the runner passed; 0 when
# another run will cover the commit, 2 usage.
set -eu
# Run from a private copy (ompkit-6xxhu): a running sh reads its script as it goes, so a commit that
# rewrites this file while a verdict runs (e78aa29091 did, 2026-11-01) would feed the live run new bytes
# at old offsets. exec keeps the pid, so the lock still names this process; the copy unlinks itself
# at once (sh keeps reading the open file).
if [ -z "${RELEASE_VERDICT_ROOT:-}" ]; then
	RELEASE_VERDICT_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
	rv_state="$(git -C "$RELEASE_VERDICT_ROOT" rev-parse --absolute-git-dir)/omp-kit"
	mkdir -p "$rv_state"
	rv_copy="$rv_state/release-verdict.run.$$.sh"
	cp "$0" "$rv_copy"
	RELEASE_VERDICT_ROOT=$RELEASE_VERDICT_ROOT RELEASE_VERDICT_COPY=$rv_copy exec sh "$rv_copy" "$@"
fi
[ -z "${RELEASE_VERDICT_COPY:-}" ] || rm -f "$RELEASE_VERDICT_COPY"
ROOT=$RELEASE_VERDICT_ROOT
# Children (the suite runs fixture copies of this script) must take their own copy of their own repo.
unset RELEASE_VERDICT_ROOT RELEASE_VERDICT_COPY
COMMIT=""
FETCH=1
while [ $# -gt 0 ]; do
	case "$1" in
		--commit) COMMIT=${2:-}; shift 2 ;;
		--no-fetch) FETCH=0; shift ;;
		-h|--help) sed -n '2,31p' "$0"; exit 0 ;;
		*) printf 'release-verdict: unknown argument: %s\n' "$1" >&2; exit 2 ;;
	esac
done
# SUITESHIMPATH1 (ompkit-774u.60.1): the publisher runs this from a seat whose PATH puts the omp-kit
# agent-bin br shim first, which turns every fixture br call red. full-suite-verdict.sh refuses such a
# PATH, so drop it before calling the runner (shared with fresh-gate.sh, SHIMPATH2).
# shellcheck source=scripts/kitlib-shimpath.sh
. "$ROOT/scripts/kitlib-shimpath.sh"
kitlib_drop_agent_bin release-verdict
GIT_DIR_ABS=$(git -C "$ROOT" rev-parse --absolute-git-dir)
STATE="$GIT_DIR_ABS/omp-kit"
LOCK="$STATE/release-verdict.lock"
WANTED="$STATE/release-verdict.wanted"
mkdir -p "$STATE"
resolve_head() {
	if [ -n "$COMMIT" ]; then git -C "$ROOT" rev-parse --verify "$COMMIT^{commit}"; return; fi
	[ "$FETCH" = 0 ] || git -C "$ROOT" fetch -q origin main </dev/null || :
	git -C "$ROOT" rev-parse --verify refs/remotes/origin/main
}
sha=$(resolve_head) || { printf 'release-verdict: cannot resolve the commit\n' >&2; exit 2; }
# The lock directory names its holder's pid; a holder that is gone no longer holds it.
if ! mkdir "$LOCK" 2>/dev/null; then
	holder=$(cat "$LOCK/pid" 2>/dev/null) || holder=""
	if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
		printf '%s\n' "$sha" >"$WANTED"
		printf 'release-verdict: run %s holds the lock; it will judge %s next\n' "$holder" "$sha"
		exit 0
	fi
	rm -rf "$LOCK"
	mkdir "$LOCK" || { printf 'release-verdict: cannot take %s\n' "$LOCK" >&2; exit 1; }
fi
printf '%s\n' "$$" >"$LOCK/pid"
# shellcheck source=scripts/kitlib-tmp.sh
. "$ROOT/scripts/kitlib-tmp.sh"
kitlib_tmp WORK release-verdict || exit 1
kitlib_tmp_atexit "rm -rf \"$LOCK\""
# A cancelled verdict cancels its ci-only judge too; run-ci-only kills its bun process groups on TERM.
ci_pid=''
# shellcheck disable=SC2016 # expanded at exit, when ci_pid names the live judge (or is empty)
kitlib_tmp_atexit '[ -z "$ci_pid" ] || kill -TERM "$ci_pid" 2>/dev/null || :'
# culprit_step: name the commit that broke $sha (see step 4). Its output and status never decide ours.
culprit_step() {
	if [ ! -f "$tree/scripts/verdict-culprit.py" ]; then
		printf 'release-verdict: CULPRIT none (no culprit tool in %s)\n' "$sha"
		return 0
	fi
	culprit_out="$WORK/culprit.$sha.out"
	culprit_rc=0
	(cd "$tree" && env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u BEADS_DB TMPDIR="$WORK" \
		python3 -B scripts/verdict-culprit.py --repo "$ROOT" --commit "$sha") >"$culprit_out" </dev/null || culprit_rc=$?
	if grep -q '^CULPRIT ' "$culprit_out"; then
		grep -E '^(CULPRIT |PROPOSE: )' "$culprit_out" | sed 's/^/release-verdict: /'
	else
		printf 'release-verdict: CULPRIT none (culprit step failed rc=%s)\n' "$culprit_rc"
	fi
	return 0
}
rc=0
while :; do
	rm -f "$WANTED"
	tree="$WORK/tree.$sha"
	mkdir -p "$tree"
	git -C "$ROOT" archive "$sha" | tar -xf - -C "$tree"
	# Step 5 gets its own export: git-initializing the full suite's tree would change what its tests see.
	ci_tree="$WORK/ci-only.$sha"
	if grep -q '"run-ci-only"' "$tree/scripts/full-suite-verdict-store.py" 2>/dev/null; then
		mkdir -p "$ci_tree"
		git -C "$ROOT" archive "$sha" | tar -xf - -C "$ci_tree"
		env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u BEADS_DB TMPDIR="$WORK" \
			python3 -B "$ci_tree/scripts/full-suite-verdict-store.py" run-ci-only --repo "$ROOT" --commit "$sha" \
			</dev/null >"$WORK/ci-only.$sha.out" 2>&1 &
		ci_pid=$!
	fi
	printf 'release-verdict: judging %s with its own runner\n' "$sha"
	rc=0
	env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u BEADS_DB TMPDIR="$WORK" \
		sh "$tree/scripts/full-suite-verdict.sh" --repo "$ROOT" --commit "$sha" --judge-role main </dev/null || rc=$?
	printf 'release-verdict: %s producer_rc=%s\n' "$sha" "$rc"
	[ "$rc" = 0 ] || culprit_step || :
	if [ -n "$ci_pid" ]; then
		ci_rc=0
		wait "$ci_pid" || ci_rc=$?
		ci_pid=''
		cat "$WORK/ci-only.$sha.out"
		printf 'release-verdict: %s ci_only_rc=%s\n' "$sha" "$ci_rc"
		[ "$rc" != 0 ] || rc=$ci_rc
	fi
	rm -rf "$tree" "$ci_tree"
	[ -s "$WANTED" ] || break
	next=$(cat "$WANTED")
	[ "$next" != "$sha" ] || break
	sha=$next
done
exit "$rc"
