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
# COMMITMERGE1 (ompkit-1ra0d.130): the commit-msg members folded here report once
# under this aggregator code with every finding listed. The checks keep their exact
# logic; what changes is that they are findings under one refusal, not four codes:
# 40-omp-kit-commit-msg-bead, 41-omp-kit-commit-msg-vlevel, 46-omp-kit-commit-notes,
# 48-omp-kit-deploy-step. Kept hazards (30-on-main, 40-ref-txn-bead, 49-stale-worktree,
# 49-pysafe and the rest the bead names) keep their own codes.
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
hook_source=""
if [ "$prepare" -eq 0 ]; then hook_source="${1:-}"; fi
case "$msg" in /*) ;; *) msg="$(pwd -P)/$msg" ;; esac

here=$(CDPATH='' cd -- "$(dirname "$0")" && pwd -P)
if [ -f "$here/kitlib-tmp.sh" ]; then
	# shellcheck source=scripts/kitlib-tmp.sh
	. "$here/kitlib-tmp.sh"
elif [ -f "$here/scripts/kitlib-tmp.sh" ]; then
	# shellcheck source=scripts/kitlib-tmp.sh
	. "$here/scripts/kitlib-tmp.sh"
fi
if [ -f "$here/kitlib-findings.sh" ]; then
	# shellcheck source=scripts/kitlib-findings.sh
	. "$here/kitlib-findings.sh"
elif [ -f "$here/scripts/kitlib-findings.sh" ]; then
	# shellcheck source=scripts/kitlib-findings.sh
	. "$here/scripts/kitlib-findings.sh"
fi
AGG_GATE="55-omp-kit-commit-gate"
agg_failed=0
agg_work=""
if command -v kitlib_tmp >/dev/null 2>&1; then
	kitlib_tmp agg_work commit-gate-folded || agg_work=""
fi
agg_helper() {
	if [ -f "$here/scripts/$1" ]; then printf '%s' "$here/scripts/$1"; return 0; fi
	if [ -f "$here/$1" ]; then printf '%s' "$here/$1"; return 0; fi
	return 1
}
agg_run() {
	_helper_name=$1; _code=$2; _remedy=$3; shift 3
	_helper_path=""
	if ! _helper_path=$(agg_helper "$_helper_name"); then
		printf 'commit-gate: WARNING aggregated helper %s missing beside %s; rerun scripts/install-commit-msg-bead.sh to restore folded checks (proceeding without it)\n' "$_helper_name" "$AGG_GATE" >&2
		return 0
	fi
	if [ -z "$agg_work" ]; then
		printf 'commit-gate: REFUSED cannot create owned scratch for aggregated checks\n' >&2
		agg_failed=$((agg_failed + 1))
		return 0
	fi
	_errf="$agg_work/err"
	: > "$_errf" 2>/dev/null || _errf="/dev/null"
	_rc=0
	sh "$_helper_path" "$@" 2>"$_errf" || _rc=$?
	if [ "$_rc" -ne 0 ]; then
		_last=$(grep -m1 -E 'REFUSE|refusing|FAIL|error|DEPLOY_STEP_MISSING|verification-level|commit-notes' "$_errf" 2>/dev/null | tr '\t' ' ')
		if [ -z "$_last" ]; then _last=$(grep -v '^$' "$_errf" 2>/dev/null | head -n 1 | tr '\t' ' '); fi
		if [ -z "$_last" ]; then _last="exit $_rc with no message"; fi
		cat "$_errf" >&2
		if command -v kitlib_finding >/dev/null 2>&1; then
			kitlib_finding "$AGG_GATE" "$_code" "$_last" "$_remedy" "-"
		else
			printf 'FINDING\t%s\t%s\t%s\t%s\t-\n' "$AGG_GATE" "$_code" "$_last" "$_remedy"
		fi
		agg_failed=$((agg_failed + 1))
	fi
	rm -f "$agg_work/err"
}
agg_commit_msg_checks() {
	_bead_extra="$hook_source"
	if [ -z "$_bead_extra" ]; then
		_subject=$(grep -m1 -v '^#' "$msg" 2>/dev/null)
		case "$_subject" in
			"Merge "*)
				_bead_extra="merge"
				;;
		esac
	fi
	if [ -n "$_bead_extra" ]; then
		agg_run commit-msg-bead.sh 40-omp-kit-commit-msg-bead "name an existing bead id the tracker resolves" "$msg" "$_bead_extra"
	else
		agg_run commit-msg-bead.sh 40-omp-kit-commit-msg-bead "name an existing bead id the tracker resolves" "$msg"
	fi
	agg_run commit-msg-verification-level.sh 41-omp-kit-commit-msg-vlevel "end the subject with [test], [selftest], [live] or [pending]" "$msg"
	agg_run check-commit-notes.sh 46-omp-kit-commit-notes "write changelog.d/<bead-without-ompkit-prefix>.md with user-facing bullets" "$msg"
	agg_run check-deploy-step.sh 48-omp-kit-deploy-step "add Deploy-Step: <command> or Deploy-Step: none (<reason>)" "$msg"
}
if [ "$prepare" -eq 0 ]; then
	agg_commit_msg_checks
	if [ "$agg_failed" -ne 0 ]; then exit 1; fi
fi

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
if [ "$prepare" -eq 1 ]; then
	agg_commit_msg_checks
fi
if [ -f "$reader" ] && command -v python3 >/dev/null 2>&1; then
	root=$(git rev-parse --show-toplevel)
	case "$msg" in /*) ;; *) msg="$(pwd -P)/$msg" ;; esac
	# Preserve relative alternate-index paths when entering the reader directory.
	case "${GIT_INDEX_FILE:-}" in ''|/*) ;; *) GIT_INDEX_FILE="$(pwd -P)/$GIT_INDEX_FILE"; export GIT_INDEX_FILE ;; esac
	if [ "$prepare" -eq 1 ]; then
		red_rc=0
		(CDPATH='' cd -- "$(dirname "$reader")" && python3 -B check-red-main.py "$root" "$base" "$msg") || red_rc=$?
		if [ "$red_rc" -ne 0 ]; then
			agg_failed=$((agg_failed + 1))
			if [ "$agg_failed" -gt 1 ]; then exit 1; fi
			exit "$red_rc"
		fi
	else
		(CDPATH='' cd -- "$(dirname "$reader")" && python3 -B check-red-main.py "$root" "$base" "$msg") || exit $?
	fi
else
	echo "commit-gate: UNKNOWN release verdict (reader unavailable)" >&2
fi
[ -x "$gate" ] || { if [ "$agg_failed" -ne 0 ]; then exit 1; fi; exit 0; }

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
if [ "$rc" -ne 0 ] || [ "$agg_failed" -ne 0 ]; then
	if [ "$agg_failed" -ne 0 ]; then rc=1; fi
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
