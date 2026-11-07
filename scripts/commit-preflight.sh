#!/bin/sh
# Run source staged-file checks and INSTALLED staged pre-commit members.
# With --message, prepare the fresh gate outside Git's index lock after these
# checks pass. commit-msg then verifies the unchanged candidate; without a
# message this remains cheap author feedback, not commit admission.
# Opt-in exception: [--tests FILE...] runs those files in the verdict's export
# layout (stamped HEAD archive plus the overlay, fresh `git init -q`, long
# TMPDIR, the gate's suite-metrics runner under heavy); a failure is
# REFUSED EXPORT_TEST_FAILED FILE.
# Without --message, Deploy-Step previews the obligation; stale-worktree,
# reversal authority and commit-notes are explicitly NOT_JUDGED.
# Exits 0 when executed checks pass (not commit admission), 1 findings or broken
# installed gates, 2 setup failure. No installed kit is UNKNOWN, not PASS, and
# leaves the exit code unchanged. Supply the real message for note coverage.
# Notes use both the native release floor and HEAD delta: an existing fragment
# is not coverage for a follow-on commit that contributes no new note.
# Reservation and bead/message policy remain the real commit/push guards.
# ShellCheck follows the full effective-index helper closure and staged config,
# using fresh-gate's koalaman/shellcheck:v0.9.0, default severity, -x -P /archive.
# Docker and its cached image are required; unavailable is UNJUDGED, never a
# local-version green fallback or an image download during cheap feedback.
# An omp-kit preflight verb should wrap this entrypoint, not fork it.
set -eu
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
PYTHONDONTWRITEBYTECODE=1 "$here/commit-preflight.py" "$@"

# Preserve literal path arguments while selecting the existing CLI's message
# and --files list. --tests remains the Python runner's responsibility.
prepare_gate() {
	message=
	mode=
	first=1
	for arg in "$@"; do
		if [ "$first" -eq 1 ]; then set --; first=0; fi
		case "$arg" in
			--message) mode=message ;;
			--files) mode=files ;;
			--tests) mode=tests ;;
			*)
				case "$mode" in
					message) message=$arg; mode= ;;
					files) set -- "$@" "$arg" ;;
				esac
				;;
		esac
	done
	[ -n "$message" ] || return 0
	if [ "$#" -gt 0 ]; then
		sh "$here/check-commit-gate.sh" --prepare "$message" --files "$@"
	else
		sh "$here/check-commit-gate.sh" --prepare "$message"
	fi
}
prepare_gate "$@"
