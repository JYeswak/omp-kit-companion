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
#      (never the working tree: editing the runner mid-run killed a 25-minute suite on 2026-10-31).
#
# A tree that already has a verdict is a cache hit and returns at once. Called with no arguments by
# the publisher after a successful push, or by hand before release-local.
#
# Usage: scripts/release-verdict.sh [--commit SHA] [--no-fetch]
# Exit: the verdict runner's status (0 PASS), 0 when another run will cover the commit, 2 usage.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
COMMIT=""
FETCH=1
while [ $# -gt 0 ]; do
	case "$1" in
		--commit) COMMIT=${2:-}; shift 2 ;;
		--no-fetch) FETCH=0; shift ;;
		-h|--help) sed -n '2,18p' "$0"; exit 0 ;;
		*) printf 'release-verdict: unknown argument: %s\n' "$1" >&2; exit 2 ;;
	esac
done
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
rc=0
while :; do
	rm -f "$WANTED"
	tree="$WORK/tree.$sha"
	mkdir -p "$tree"
	git -C "$ROOT" archive "$sha" | tar -xf - -C "$tree"
	printf 'release-verdict: judging %s with its own runner\n' "$sha"
	rc=0
	env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u BEADS_DB TMPDIR="$WORK" \
		sh "$tree/scripts/full-suite-verdict.sh" --repo "$ROOT" --commit "$sha" --judge-role main </dev/null || rc=$?
	printf 'release-verdict: %s producer_rc=%s\n' "$sha" "$rc"
	rm -rf "$tree"
	[ -s "$WANTED" ] || break
	next=$(cat "$WANTED")
	[ "$next" != "$sha" ] || break
	sha=$next
done
exit "$rc"
