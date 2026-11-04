#!/bin/sh
# check-commit-gate.sh -- COMMITPARITY1 (ompkit-9d9fx, J-2026-11-01-02/-03): a commit-msg member that
# runs the push gate on the commit being made, so a commit that cannot publish never lands on the
# shared main (one history per repo, J-2026-10-15-11; one red commit there holds every later one).
#
# Parity by construction, not by a second copy of the checks: the would-be commit is built as an
# unreferenced object (git commit-tree on the staged tree with this commit's own message; no ref
# moves) and handed to the installed pre-push fresh-gate member, the same adapter a push runs,
# judged against the remote-tracking origin/main exactly as the next push would be. The other push
# members already have commit-time twins (commit-msg-bead, verification-level) or judge ref
# placement only (storage-root, on-main), so the fresh gate is the one left to mirror.
#
# A green run is recorded for the push: .git/omp-kit/commit-gate-pass/<key>, where the key binds the
# staged tree, the parent, the message as git will store it (git stripspace), the origin/main judged
# against and the blob id of the gate file itself. pre-push-gate.sh reuses a record only when the
# pushed tip matches every one of them, so committing and then publishing runs the gate once.
#
# Installed as hooks.d/commit-msg/55-omp-kit-commit-gate. Usage: check-commit-gate.sh MSGFILE
# Exit 0 when the push gate would admit (or there is nothing to mirror: no installed fresh-gate
# member, no origin/main, no HEAD, or a branch other than main), the gate's status otherwise.
set -u

msg=${1:-}
if [ -z "$msg" ] || [ ! -f "$msg" ]; then
	echo "commit-gate: usage: check-commit-gate.sh MSGFILE" >&2
	exit 2
fi

hooks=$(git rev-parse --git-path hooks 2>/dev/null) || exit 0
case "$hooks" in /*) ;; *) hooks="$(git rev-parse --show-toplevel)/$hooks" ;; esac
gate="$hooks/hooks.d/pre-push/40-omp-kit-fresh-gate"
[ "$(git symbolic-ref -q HEAD 2>/dev/null)" = refs/heads/main ] || exit 0
head=$(git rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null) || exit 0
base=$(git rev-parse -q --verify 'refs/remotes/origin/main^{commit}' 2>/dev/null) || exit 0

# REDMAINLAND1: surface existing main failures before judging this commit's range.
# The installed reader lives under scripts/ so its store/metrics imports retain
# their source layout. A source invocation uses the adjacent reader instead.
here=$(CDPATH='' cd -- "$(dirname "$0")" && pwd -P)
reader="$here/scripts/check-red-main.py"
[ -f "$reader" ] || reader="$here/check-red-main.py"
if [ -f "$reader" ] && command -v python3 >/dev/null 2>&1; then
	root=$(git rev-parse --show-toplevel)
	case "$msg" in /*) ;; *) msg="$(pwd -P)/$msg" ;; esac
	# Preserve relative alternate-index paths when entering the reader directory.
	case "${GIT_INDEX_FILE:-}" in ''|/*) ;; *) GIT_INDEX_FILE="$(pwd -P)/$GIT_INDEX_FILE"; export GIT_INDEX_FILE ;; esac
	(CDPATH='' cd -- "$(dirname "$reader")" && python3 -B check-red-main.py "$root" "$base" "$msg") || exit $?
else
	echo "commit-gate: UNKNOWN release verdict (reader unavailable)" >&2
fi
[ -x "$gate" ] || exit 0

# git write-tree honors GIT_INDEX_FILE, so `commit --only` is judged as it will be committed.
tree=$(git write-tree) || { echo "commit-gate: REFUSED cannot write the staged tree" >&2; exit 1; }
candidate=$(git commit-tree "$tree" -p "$head" -F "$msg") || { echo "commit-gate: REFUSED cannot build the candidate commit" >&2; exit 1; }

url=$(git remote get-url origin 2>/dev/null) || url=
started=$(date +%s)
rc=0
# OMP_KIT_RELEASE_VERDICT=0: a green push gate starts the release's full suite for the pushed sha;
# the candidate here is an unreferenced object that may never ship, so no suite starts for it.
printf 'refs/heads/main %s refs/heads/main %s\n' "$candidate" "$base" | OMP_KIT_RELEASE_VERDICT=0 "$gate" origin "$url" || rc=$?
took=$(( $(date +%s) - started ))
if [ "$rc" -ne 0 ]; then
	printf 'commit-gate: REFUSED in %ss: the push gate refuses this commit against origin/main %s, so it would block every later commit on main. Fix the finding above and commit again.\n' "$took" "$(printf '%s' "$base" | cut -c1-10)" >&2
	exit "$rc"
fi
printf 'commit-gate: GREEN in %ss (push gate on the staged commit against origin/main %s)\n' "$took" "$(printf '%s' "$base" | cut -c1-10)" >&2
# The record is an optimisation only: when it cannot be written the push simply runs the gate again.
gate_id=$(git hash-object "$gate") || exit 0
message_id=$(git stripspace < "$msg" | git hash-object --stdin) || exit 0
key=$(printf 'commit-gate-v1\n%s\n%s\n%s\n%s\n%s\n' "$tree" "$head" "$base" "$message_id" "$gate_id" | git hash-object --stdin) || exit 0
records="$(git rev-parse --absolute-git-dir)/omp-kit/commit-gate-pass"
if mkdir -p "$records" 2>/dev/null; then
	find "$records" -type f -mtime +1 -delete 2>/dev/null || :
	printf 'tree=%s\nparent=%s\nbase=%s\nmessage=%s\ngate=%s\nrecorded=%s\n' "$tree" "$head" "$base" "$message_id" "$gate_id" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$records/$key" || :
fi
exit 0
