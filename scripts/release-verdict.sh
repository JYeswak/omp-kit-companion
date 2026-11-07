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
#   2b. read the exact-tree main record with the exported judge; a matching PASS
#       needs no suite lease. A missing verdict takes the machine-wide suite lease.
#   3. export the exact commit and run only its missing qualification with that commit's own runner
#      (never the working tree: editing the runner mid-run killed a 25-minute suite on 2026-10-31);
#
# A tree that already has a verdict is a cache hit and returns at once. Called with no arguments by
# the publisher after a successful push, or by hand before release-local.
#
# Usage: scripts/release-verdict.sh [--commit SHA] [--no-fetch]
# Exit: the verdict runner's status (0 PASS); 0 when
# another run will cover the commit, 2 usage, 75 when the suite lease refuses (queue full, wait bound).
set -eu
# Pin before the first Git/Python/tool lookup, including the private-copy bootstrap.
rv_root=${RELEASE_VERDICT_ROOT:-$(CDPATH='' cd -- "$(/usr/bin/dirname "$0")/.." && pwd -P)}
# shellcheck source=scripts/fixed-env.sh
. "$rv_root/scripts/fixed-env.sh"
if [ "${1:-}" = --check-env ]; then
	cd "$rv_root/scripts"
	exec python3 -B -m suite-metrics runtime-environment
fi
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
		-h|--help) sed -n '2,33p' "$0"; exit 0 ;;
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
# SUITESERIAL1 (ompkit-fp72.120.16.264): one full suite at a time machine-wide, whatever launched it. Each
# commit is judged under the suite lease (scripts/suite-lease.sh), held around its runner.
# The runner sees this enclosing lease and takes none. Release-verdict requests go first in the lease queue, so the
# release-local stage waiting on this run is never starved. A checkout whose JUDGING_FILES predate the lease
# runs without it (SUITE_LEASE_ABSENT); one whose closure lists scripts/suite-lease.sh refuses when it is missing.
rv_lease=0
if [ -f "$ROOT/scripts/suite-lease.sh" ]; then
	SUITE_LEASE_LIB="$ROOT/scripts"
	# shellcheck source=scripts/suite-lease.sh
	. "$ROOT/scripts/suite-lease.sh"
	rv_lease=1
else
	rv_closure=''
	if [ -f "$ROOT/scripts/suite-metrics.py" ]; then
		rv_closure=$(PYTHONPATH="$ROOT/scripts" python3 -B -m suite-metrics judging-files) || {
			printf 'release-verdict: the judging closure of %s is unreadable\n' "$ROOT" >&2; exit 1;
		}
	fi
	if printf '%s\n' "$rv_closure" | grep -qx 'scripts/suite-lease.sh'; then
		printf 'release-verdict: SUITE_LEASE_MISSING: scripts/suite-lease.sh is absent from %s, but its JUDGING_FILES list it\n' "$ROOT" >&2
		exit 1
	fi
	printf 'release-verdict: SUITE_LEASE_ABSENT: %s predates scripts/suite-lease.sh, so this run takes no suite lease\n' "$ROOT"
fi
# RELFAST1: wall-clock runner intervals, matching release-local's substep format.
substep_start() {
	rv_substep_t0=$(date +%s)
	printf '== substep %s start=%s\n' "$1" "$rv_substep_t0"
}
substep_end() {
	rv_substep_t1=$(date +%s)
	printf '== substep %s took %ss start=%s end=%s\n' "$1" "$((rv_substep_t1 - $2))" "$2" "$rv_substep_t1"
}
rc=0
while :; do
	rm -f "$WANTED"
	tree="$WORK/tree.$sha"
	substep_start verdict.archive-export
	mkdir -p "$tree"
	git -C "$ROOT" archive "$sha" | tar -xf - -C "$tree"
	substep_end verdict.archive-export "$rv_substep_t0"
	rv_tree=$(git -C "$ROOT" rev-parse "$sha^{tree}") || { printf 'release-verdict: cannot read the tree of %s\n' "$sha" >&2; rc=1; break; }
	# RELFAST1: use the same canonical validators as release-local, before queueing for CPU.
	# Only a successful exact PASS can skip work; FAIL, missing/corrupt evidence, changed
	# checker bytes, runtime or tree keep the original producer/refusal path.
	main_result=''
	substep_start verdict.store-lookup
	if [ -f "$tree/scripts/full-suite-verdict-store.py" ]; then
		main_result=$(env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u BEADS_DB -u BEADS_DIR TMPDIR="$WORK" \
			python3 -B "$tree/scripts/full-suite-verdict-store.py" require-pass --repo "$ROOT" \
			--tree "$rv_tree" --role main --judge-root "$tree" --suite-root "$tree" 2>/dev/null) || main_result=''
	fi
	substep_end verdict.store-lookup "$rv_substep_t0"
	if [ "$rv_lease" = 1 ] && [ "$main_result" != PASS ]; then
		lease_rc=0
		substep_start verdict.suite-lease-wait
		suite_lease_take release-verdict "$rv_tree" main "$sha" "${FULL_SUITE_VERDICT_CACHE_DIR:-}" 0 '' || lease_rc=$?
		substep_end verdict.suite-lease-wait "$rv_substep_t0"
		if [ "$lease_rc" != 0 ]; then
			printf 'release-verdict: %s not judged: no suite lease (rc=%s)\n' "$sha" "$lease_rc"
			rc=$lease_rc
			break
		fi
		printf 'release-verdict: suite lease %s for %s (%s)\n' "$SUITE_LEASE_STATE" "$sha" "$SUITE_LEASE_DETAIL"
	fi
	if [ "$main_result" = PASS ]; then
		printf 'release-verdict: reusing exact-tree main PASS for %s\n' "$sha"
	else
		printf 'release-verdict: judging %s with its own runner\n' "$sha"
	fi
	rc=0
	if [ "$main_result" != PASS ]; then
		substep_start verdict.main-judge
		env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u BEADS_DB -u BEADS_DIR TMPDIR="$WORK" \
			sh "$tree/scripts/full-suite-verdict.sh" --repo "$ROOT" --commit "$sha" --judge-role main </dev/null || rc=$?
		substep_end verdict.main-judge "$rv_substep_t0"
	fi
	printf 'release-verdict: %s producer_rc=%s\n' "$sha" "$rc"
	# Use the kit's MCP client, not am; missing mail infrastructure cannot change a verdict.
	if [ -d "$STATE/release-verdict-subscribers" ]; then
		bun "$ROOT/scripts/release-verdict-mail.ts" "$STATE" "$sha" "$rc" </dev/null ||
			printf 'release-verdict: mail wake failed for %s (verdict unchanged)\n' "$sha" >&2
	fi
	rm -rf "$tree"
	if [ "$rv_lease" = 1 ]; then suite_lease_release || :; fi
	[ -s "$WANTED" ] || break
	next=$(cat "$WANTED")
	[ "$next" != "$sha" ] || break
	sha=$next
done
exit "$rc"
