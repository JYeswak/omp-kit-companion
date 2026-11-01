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
[ -x "$gate" ] || exit 0
[ "$(git symbolic-ref -q HEAD 2>/dev/null)" = refs/heads/main ] || exit 0
head=$(git rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null) || exit 0
base=$(git rev-parse -q --verify 'refs/remotes/origin/main^{commit}' 2>/dev/null) || exit 0

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
exit 0
