#!/bin/sh
# check-commit-gate.sh -- COMMITPARITY1/GATELOCK1: judge the immutable candidate
# before Git takes index.lock; commit-msg only verifies that exact admission.
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
# Usage: check-commit-gate.sh --prepare MSGFILE [--files PATH...]
#        check-commit-gate.sh MSGFILE   (commit-msg: verify only)
# --files builds commit --only's HEAD plus named working bytes in a private
# index. Without it, snapshot the caller's effective index. No shared index
# lock is held during the push gate. A changed tree/parent/base/message/gate
# refuses; it never falls back to judging under Git's lock.
set -u

prepare=0
if [ "${1:-}" = --prepare ]; then prepare=1; shift; fi
msg=${1:-}
if [ -z "$msg" ] || [ ! -f "$msg" ]; then
	echo "commit-gate: usage: check-commit-gate.sh [--prepare] MSGFILE [--files PATH...]" >&2
	exit 2
fi
shift
case "$msg" in /*) ;; *) msg="$(pwd -P)/$msg" ;; esac

hooks=$(git rev-parse --git-path hooks 2>/dev/null) || exit 0
case "$hooks" in /*) ;; *) hooks="$(git rev-parse --show-toplevel)/$hooks" ;; esac
gate="$hooks/hooks.d/pre-push/40-omp-kit-fresh-gate"
[ "$(git symbolic-ref -q HEAD 2>/dev/null)" = refs/heads/main ] || exit 0
head=$(git rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null) || exit 0
base=$(git rev-parse -q --verify 'refs/remotes/origin/main^{commit}' 2>/dev/null) || exit 0


here=$(CDPATH='' cd -- "$(dirname "$0")" && pwd -P)
if [ "$prepare" -eq 1 ] && [ -x "$gate" ]; then
	# Copy before write-tree: even its cache refresh writes an index lock.
	# Immutable Git objects may be shared, the mutable index must not be.
	caller_index=$(git rev-parse --path-format=absolute --git-path index) || exit 1
	# shellcheck source=scripts/kitlib-tmp.sh
	. "$here/kitlib-tmp.sh"
	work=
	kitlib_tmp work commit-gate || exit 1
	if [ "${1:-}" = --files ]; then
		shift
		[ "$#" -gt 0 ] || exit 2
		export GIT_INDEX_FILE="$work/index"
		git read-tree "$head" &&
			git --literal-pathspecs add -A -- "$@" || exit 1
	elif [ "$#" -eq 0 ]; then
		export GIT_INDEX_FILE="$work/index"
		if [ -f "$caller_index" ]; then
			cp "$caller_index" "$GIT_INDEX_FILE" || exit 1
			git update-index --no-split-index || exit 1
		else
			git read-tree --empty || exit 1
		fi
	else
		echo "commit-gate: REFUSED unknown prepare arguments" >&2
		exit 2
	fi
fi
# REDMAINLAND1: surface existing main failures before judging this commit's range.
# The installed reader lives under scripts/ so its store/metrics imports retain
# their source layout. A source invocation uses the adjacent reader instead.
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
gate_id=$(git hash-object "$gate") || exit 1
message_id=$(git stripspace < "$msg" | git hash-object --stdin) || exit 1
key=$(printf 'commit-gate-v1\n%s\n%s\n%s\n%s\n%s\n' "$tree" "$head" "$base" "$message_id" "$gate_id" | git hash-object --stdin) || exit 1
records="$(git rev-parse --absolute-git-dir)/omp-kit/commit-gate-pass"
diagnostic=$(printf 'commit-gate-prepared-v1\n%s\n' "$message_id" | git hash-object --stdin) || exit 1
if [ "$prepare" -eq 0 ]; then
	if [ -f "$records/$key" ]; then
		echo "commit-gate: VERIFIED prepared tree $tree" >&2
		exit 0
	fi
	if [ -f "$records/prepared-$diagnostic" ]; then
		read -r judged_tree judged_head judged_base < "$records/prepared-$diagnostic"
		if [ "$judged_head" != "$head" ]; then
			echo "commit-gate: REFUSED HEAD changed since judgment: $judged_head -> $head" >&2
		elif [ "$judged_tree" != "$tree" ]; then
			echo "commit-gate: REFUSED INDEX_CHANGED since judged tree $judged_tree -> $tree; changed paths:" >&2
			git diff --name-only "$judged_tree" "$tree" >&2
		else
			echo "commit-gate: REFUSED base or gate changed since judgment (base $judged_base -> $base)" >&2
		fi
	else
		echo "commit-gate: REFUSED unjudged tree/message; run commit-preflight.sh --message FILE --files PATH... before git commit" >&2
	fi
	exit 1
fi
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
# Same push-reuse key as before. Publish atomically only after a complete PASS;
# the message-keyed pointer is diagnostic only, never admission authority.
mkdir -p "$records" || exit 1
find "$records" -type f -mtime +1 -delete 2>/dev/null || :
printf 'tree=%s\nparent=%s\nbase=%s\nmessage=%s\ngate=%s\nrecorded=%s\n' "$tree" "$head" "$base" "$message_id" "$gate_id" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$work/pass" || exit 1
mv "$work/pass" "$records/$key" || exit 1
printf '%s %s %s\n' "$tree" "$head" "$base" > "$work/prepared" || exit 1
mv "$work/prepared" "$records/prepared-$diagnostic" || exit 1
exit 0
