#!/bin/sh
# Git pre-push stdin adapter for scripts/fresh-gate.sh.
# The gate is always executed from the exact commit archive, never the working tree.
set -eu
ROOT=$(git rev-parse --show-toplevel)
# Git supplies repository selectors to hooks. ROOT is resolved first; fixture
# processes below must not inherit those selectors or config overrides.
for name in $(env | cut -d= -f1); do
	case "$name" in
		GIT_*) [ "$name" = GIT_TERMINAL_PROMPT ] || unset "$name" ;;
	esac
done
IFS=' '
read -r local_ref local_sha remote_ref remote_sha || exit 0
: "${remote_ref:-}"
# GATESCR1 (ompkit-fp72.40): the ref line above is the only stdin the gate reads. Every step after
# it, every checker contract and every suite fresh-gate runs, gets /dev/null: a test that reads
# stdin (omp -p's readPipedInput, a prompt, a credential helper) then sees EOF instead of blocking
# forever on a pipe whose writer never closes (a harness with pty off, a hand-fed hook).
exec </dev/null
# An inherited FRESH_GATE_SKIP_REGEX must never leak into a main judgment: a
# caller-side export would otherwise skip the regex budget on main. Clear it
# first, then set it only for scratch measurement refs.
unset FRESH_GATE_SKIP_REGEX
# ttsr-harness resolves repo-relative case paths against OMP_KIT_CASE_CWD (76a722f2). The
# archive below lives under var/agent-tmp, so without this every case path looks like scratch
# and scratch-is-not-a-home fires on real repo files (cases 375/376 RED, 2026-10-08).
export OMP_KIT_CASE_CWD="$ROOT"
# Scratch measurement refs skip ONLY the regex-budget judgment (the budget is
# judged on CI for the release candidate); every other check still runs, and
# main pushes are still fully judged.
case "${remote_ref:-}" in
	refs/heads/scratch/*) export FRESH_GATE_SKIP_REGEX="scratch measurement ref; main pushes still judged" ;;
esac
case "${local_ref:-}" in
	''|delete|*:delete) exit 0 ;;
esac
case "${local_sha:-}" in
	''|0000000000000000000000000000000000000000) exit 0 ;;
esac
# Each extract lives inside a reaper-owned dir (ompkit-fp72.40): the name carries this shell's pid
# and .owner records it, so a gate killed by SIGKILL (which skips the trap) leaves a dir the scratch
# reaper takes once this pid is dead, instead of an ownerless tree held for 72 h.
owned_dir() {
	dir=$(mktemp -d "$ROOT/var/agent-tmp/$1.$$.XXXXXX") || return 1
	start=$(ps -p $$ -o lstart= 2>/dev/null | sed 's/^ *//;s/ *$//')
	created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	if [ -n "$start" ]; then
		printf 'pid=%s\nprocess_start=%s\nlabel=%s\nrepo=%s\ncreated_at=%s\nargv0=%s\n' "$$" "$start" "$1" "$ROOT" "$created" "$0" > "$dir/.owner"
	else
		printf 'pid=%s\nlabel=%s\nrepo=%s\ncreated=%s\n' "$$" "$1" "$ROOT" "$created" > "$dir/.owner"
	fi
	mkdir "$dir/tree"
	printf '%s' "$dir"
}
archive_root=""
base_root=""
tag_root=""
gate_red=0
# Every non-directory goes (files, symlinks, sockets): a symlink left by a test fixture kept
# its parents non-empty, so the whole extract survived (pre-push-gate.vx9qma, 2026-10-12).
# A red gate keeps its log: archive_root/gate.log and .owner survive, everything else goes, so the
# failure can be read after the push is refused and the reaper still owns the dir (ompkit-fp72.40).
# The tag verdict dir holds no log: a refused tag prints its reason, then cleanup takes the whole dir.
cleanup() {
	for dir in ${archive_root:+"$archive_root"} ${base_root:+"$base_root"} ${tag_root:+"$tag_root"}; do
		[ -d "$dir" ] || continue
		chmod -R u+w "$dir" 2>/dev/null || true
		if [ "$gate_red" = 1 ] && [ "$dir" = "$archive_root" ]; then
			find "$dir" ! -type d ! -path "$dir/gate.log" ! -path "$dir/.owner" -delete 2>/dev/null || true
		else
			find "$dir" ! -type d -delete 2>/dev/null || true
		fi
		find "$dir" -depth -type d -empty -delete 2>/dev/null || true
	done
}
# TAGPUSHGATE1 (ompkit-t7cn7.2): a brand-new tag whose target is already on the
# pushed-to remote's main skips fresh-gate, but never the full-suite verdict.
# The verdict for the exact target commit is read back from its cache (cheap;
# no suite runs) and the tag is admitted only on VERDICT PASS. A cache miss is
# a missing build artifact: the push is refused with the command that produces
# the verdict, never a silent suite inside the push. Every other case runs the
# full gate unchanged: a branch push, a tag move (remote sha set), or a tag
# whose target is not on the remote's main. The remote is git's pre-push $1;
# when the chain runner drops argv ($1 empty) the gate falls back to origin
# and says so. The fetch names the literal refs/heads/main on that remote; a
# stale local ref is never trusted. A fetch or peel failure fails closed into
# the gate below.
# tag_reusable_verdict TARGET WORKDIR: status 0 only for a complete main-role PASS.
#
tag_reusable_verdict() {
	v_tree=$(git -C "$ROOT" rev-parse "$1^{tree}" 2>/dev/null) || return 1
	[ -f "$2/scripts/full-suite-verdict-store.py" ] || return 1
	python3 "$2/scripts/full-suite-verdict-store.py" require-pass \
		--repo "$ROOT" --tree "$v_tree" --role main --judge-root "$2" --suite-root "$2" >/dev/null
}
# tag_on_main_verdict NAME TARGET NOTE: admit or refuse the tag from the
# verdict readback. Returns nonzero only when the target cannot be judged this
# way (archive or checker missing); the caller then runs the full gate.
tag_on_main_verdict() {
	tag_root=$(owned_dir pre-push-gate-tag) || return 1
	if ! git -C "$ROOT" archive "$2" | tar -xf - -C "$tag_root/tree" 2>/dev/null; then cleanup; tag_root=""; return 1; fi
	if [ ! -f "$tag_root/tree/scripts/full-suite-verdict.sh" ] || [ ! -f "$tag_root/tree/scripts/full-suite-verdict-store.py" ] || [ ! -f "$tag_root/tree/scripts/fresh-gate.sh" ]; then cleanup; tag_root=""; return 1; fi
	if ! tag_reusable_verdict "$2" "$tag_root/tree"; then
		cleanup; tag_root=""
		printf 'pre-push-gate: REFUSED new tag %s: no reusable main-role full-suite verdict for %s; run sh scripts/full-suite-verdict.sh --repo %s --commit %s --judge-role main, then push the tag\n' "$1" "$2" "$ROOT" "$2" >&2
		exit 1
	fi
	verdict_rc=0
	verdict_out=$(sh "$tag_root/tree/scripts/full-suite-verdict.sh" --repo "$ROOT" --commit "$2" --judge-role main --archive-dir "$tag_root/tree" 2>&1) || verdict_rc=$?
	cleanup; tag_root=""
	if [ "$verdict_rc" = 0 ] && printf '%s\n' "$verdict_out" | grep -qE 'VERDICT (REUSED )?PASS'; then
		verdict_line=$(printf '%s\n' "$verdict_out" | grep -E 'VERDICT (REUSED )?PASS' | head -n 1)
		printf 'pre-push-gate: ADMIT new tag %s: %s is %s; %s\n' "$1" "$2" "$3" "$verdict_line"
		exit 0
	fi
	printf '%s\n' "$verdict_out" >&2
	case "$verdict_rc" in ''|*[!0-9]*|0) verdict_rc=1 ;; esac
	exit "$verdict_rc"
}
ZERO40=0000000000000000000000000000000000000000
case "${remote_ref:-}" in
	refs/tags/*)
		if [ "${remote_sha:-}" = "$ZERO40" ]; then
			push_remote=${1:-}
			if [ -z "$push_remote" ]; then
				push_remote=origin
				remote_note="admitted with remote unknown to the hook; judged against origin/main"
			else
				remote_note="an ancestor of $push_remote/main"
			fi
			tag_target=$(git -C "$ROOT" rev-parse "$local_sha^{commit}" 2>/dev/null) || tag_target=
			if [ -n "$tag_target" ] && git -C "$ROOT" fetch -q "$push_remote" refs/heads/main 2>/dev/null; then
				main_tip=$(git -C "$ROOT" rev-parse FETCH_HEAD 2>/dev/null) || main_tip=
				if [ -n "$main_tip" ] && git -C "$ROOT" merge-base --is-ancestor "$tag_target" "$main_tip" 2>/dev/null; then
					tag_on_main_verdict "${remote_ref#refs/tags/}" "$tag_target" "$remote_note"
				fi
			fi
		fi
		;;
esac
case "${remote_sha:-}" in
	0000000000000000000000000000000000000000|'')
		base=$(git -C "$ROOT" rev-list --max-parents=0 "$local_sha" | tail -n 1)
		if git -C "$ROOT" cat-file -e "$base^" 2>/dev/null; then base_ref=$base; else base_ref=; fi
		;;
	*) base_ref=$remote_sha ;;
esac
# GATESCR1 (ompkit-fp72.40): an interrupted run is red, not clean. The HUP/INT/TERM handler marks
# the run red BEFORE cleanup, so the failed parent keeps exactly .owner + gate.log while the
# extract tree is removed. Every descendant (fresh-gate, omp-kit heavy, bun and their children,
# including any that lead their own process group) is stopped first, so nothing recreates or holds
# the tree after cleanup and the handler finishes instead of waiting on a hung suite.
# stop_descendants: TERM the whole tree under this shell, snapshotted before any signal (a parent
# that dies first reparents its children to init, out of reach), plus every separate process group
# one of them leads; after a 5 s grace, KILL what is still running. Only processes this gate
# started are touched: the tree is rooted at $$ and the shell's own group (git's) is never signaled.
# shellcheck disable=SC2329,SC2317
stop_descendants() {
	tree=$(ps -A -o pid= -o ppid= -o pgid= 2>/dev/null | awk -v root="$$" '
		{ n++; pid[n] = $1; parent[$1] = $2; group[$1] = $3 }
		END {
			mine[root] = 1; grew = 1
			while (grew) { grew = 0; for (i = 1; i <= n; i++) { p = pid[i]; if (!(p in mine) && (parent[p] in mine)) { mine[p] = 1; grew = 1 } } }
			for (p in mine) if (p != root) print p, group[p]
		}')
	[ -n "$tree" ] || return 0
	own_group=$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ')
	pids=""
	while read -r p g; do
		pids="$pids $p"
		kill -s TERM "$p" 2>/dev/null || :
		if [ "$g" = "$p" ] && [ "$g" != "$own_group" ]; then kill -s TERM -- "-$g" 2>/dev/null || :; fi
	done <<EOF
$tree
EOF
	grace=0
	while [ "$grace" -lt 50 ]; do
		running=$(ps -A -o pid= -o stat= 2>/dev/null | awk -v want="$pids" '
			BEGIN { n = split(want, w, " "); for (i = 1; i <= n; i++) set[w[i]] = 1 }
			($1 in set) && $2 !~ /Z/ { print $1 }')
		[ -z "$running" ] && return 0
		sleep 0.1
		grace=$((grace + 1))
	done
	for p in $running; do kill -s KILL "$p" 2>/dev/null || :; done
	return 0
}
# shellcheck disable=SC2329,SC2317
on_signal() {
	trap - EXIT
	trap '' HUP INT TERM
	gate_red=1
	stop_descendants
	cleanup
	exit "$1"
}
# GATESCR1 start-up sweep: a gate killed by SIGKILL (or by its parent before the handler finished)
# leaves its extract behind. Each run first removes the extracts in this repo's var/agent-tmp whose
# recorded gate pid is no longer that process AND that no process holds open (lsof +D, bounded),
# logging each removal. Only the gate's own naming class is considered (pre-push-gate.<pid>.*,
# pre-push-gate-base.<pid>.*, fresh-gate.*), with the pid from .owner, or from the name when a run
# died before writing .owner; ownerless dirs without a pid stay with the scratch reaper. A pid
# recorded before this boot is not trusted as alive (pid reuse): such a dir goes only on the
# no-holder test plus the naming class. A red record (.owner + gate.log, no extract) is kept.
SWEEP_LSOF_TICKS=${OMP_KIT_GATE_SWEEP_LSOF_TICKS:-300}
# shellcheck disable=SC2329,SC2317
epoch_of() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || printf '0\n'; }
# shellcheck disable=SC2329,SC2317
owner_running() {
	ps -p "$1" >/dev/null 2>&1 || return 1
	if [ -n "$2" ]; then
		[ "$(ps -p "$1" -o lstart= 2>/dev/null | sed 's/^ *//;s/ *$//')" = "$2" ]
		return
	fi
	[ "$3" -ge "$boot" ]
}
# held DIR: status 0 when a process has a file or cwd under DIR, or lsof did not finish in time.
# shellcheck disable=SC2329,SC2317
held() {
	command -v lsof >/dev/null 2>&1 || return 0
	res=$(
		lsof -t +D "$1" 2>/dev/null &
		lp=$!
		( t=0; while [ "$t" -lt "$SWEEP_LSOF_TICKS" ] && kill -0 "$lp" 2>/dev/null; do sleep 0.1; t=$((t + 1)); done; [ "$t" -lt "$SWEEP_LSOF_TICKS" ] || kill -s TERM "$lp" 2>/dev/null ) >/dev/null 2>&1 &
		# This subshell runs under set -e: lsof's "nothing open" status 1 must not end it.
		lrc=0
		wait "$lp" || lrc=$?
		wait
		printf 'rc=%s\n' "$lrc"
	)
	[ "$res" != "rc=1" ]
}
# shellcheck disable=SC2329,SC2317
sweep_dead_extracts() {
	boot=$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/^{ sec = \([0-9]*\),.*/\1/p')
	[ -n "$boot" ] || boot=$(awk '$1 == "btime" { print $2 }' /proc/stat 2>/dev/null)
	[ -n "$boot" ] || boot=0
	for dir in "$ROOT"/var/agent-tmp/pre-push-gate.* "$ROOT"/var/agent-tmp/pre-push-gate-base.* "$ROOT"/var/agent-tmp/fresh-gate.*; do
		if [ ! -d "$dir" ] || [ -L "$dir" ]; then continue; fi
		name=${dir##*/}
		label=${name%%.*}
		rest=${name#*.}
		name_pid=${rest%%.*}
		[ "$name_pid" != "$rest" ] || name_pid=
		case "$name_pid" in *[!0-9]*) name_pid= ;; esac
		if [ -f "$dir/.owner" ]; then
			pid=$(sed -n 's/^pid=//p' "$dir/.owner" | head -n 1)
			start=$(sed -n 's/^process_start=//p' "$dir/.owner" | head -n 1)
			[ "$(sed -n 's/^label=//p' "$dir/.owner" | head -n 1)" = "$label" ] || continue
			[ -z "$name_pid" ] || [ "$name_pid" = "$pid" ] || continue
			created=$(epoch_of "$dir/.owner")
		else
			pid=$name_pid
			start=
			created=$(epoch_of "$dir")
		fi
		case "$pid" in ''|*[!0-9]*) continue ;; esac
		owner_running "$pid" "$start" "$created" && continue
		find "$dir" -mindepth 1 -maxdepth 1 ! -name .owner ! -name gate.log | grep -q . || continue
		if held "$dir"; then
			printf 'gate-sweep: kept %s: owner pid %s is gone but a process holds it (or lsof timed out)\n' "$dir" "$pid" >&2
			continue
		fi
		kib=$(du -sk "$dir" 2>/dev/null | cut -f1)
		chmod -R u+w "$dir" 2>/dev/null || :
		if [ "$label" = pre-push-gate ] && [ -f "$dir/.owner" ] && [ -f "$dir/gate.log" ]; then
			find "$dir" ! -type d ! -path "$dir/gate.log" ! -path "$dir/.owner" -delete 2>/dev/null || :
		else
			find "$dir" ! -type d -delete 2>/dev/null || :
		fi
		find "$dir" -depth -type d -empty -delete 2>/dev/null || :
		printf 'gate-sweep: removed extract %s (%s KiB): owner pid %s is gone and no process holds it\n' "$dir" "${kib:-?}" "$pid" >&2
	done
}
trap cleanup EXIT
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
sweep_dead_extracts || :
archive_root=$(owned_dir pre-push-gate) || { printf 'pre-push-gate: cannot stage archive\n' >&2; exit 1; }
# Both owned dirs are made here, in the shell that owns the trap: the body below runs in a subshell,
# and cleanup must know every dir it has to remove.
if [ -n "${base_ref:-}" ]; then
	base_root=$(owned_dir pre-push-gate-base) || { printf 'pre-push-gate: cannot stage base archive\n' >&2; exit 1; }
fi
# Everything from here to the gate runs in gate_body, whose whole output (every checker, not only
# fresh-gate) streams to the terminal and to archive_root/gate.log; a red at any step keeps the log.
gate_body() {
archive="$archive_root/tree"
git -C "$ROOT" archive "$local_sha" | tar -xf - -C "$archive"
set -- --archive-dir "$archive"
if [ -n "${base_ref:-}" ]; then
	changed=$(git -C "$ROOT" diff --name-only "$base_ref" "$local_sha")
else
	changed=$(git -C "$ROOT" diff-tree --root --no-commit-id --name-only -r "$local_sha")
fi
while IFS= read -r path; do
	[ -n "$path" ] && set -- "$@" --changed-file "$path"
done <<EOF
$changed
EOF
if [ -n "${base_ref:-}" ]; then
	set -- "$@" --base "$base_ref" --commit "$local_sha"
fi
gate_scripts="$archive"
if [ -n "${base_ref:-}" ]; then
	base_archive="$base_root/tree"
	git -C "$ROOT" archive "$base_ref" | tar -xf - -C "$base_archive" || { printf 'pre-push-gate: cannot extract base archive\n' >&2; exit 1; }
	gate_scripts="$base_archive"
fi
if [ -n "${base_ref:-}" ]; then
	merge_base=$(git -C "$ROOT" merge-base "$local_sha" "$base_ref") || { printf 'pre-push-gate: cannot find merge base\n' >&2; exit 1; }
	if [ "$merge_base" != "$base_ref" ]; then
		land_paths=$(git -C "$ROOT" diff --name-only "$base_ref" "$local_sha") || { printf 'pre-push-gate: cannot list pushed paths\n' >&2; exit 1; }
		if [ -n "$land_paths" ]; then
			# shellcheck disable=SC2086
			bun run --no-env-file --config=/dev/null "$gate_scripts/src/land-guard.ts" --repo "$ROOT" --base "$merge_base" --tip "$base_ref" --tree "$local_sha" --paths $land_paths || exit 1
		fi
	fi
fi
# TEMPGATE1 (ompkit-dhmzg): the pushed range adds no temp creation outside kitlib (range ratchet:
# untouched sites never block, new ones always do). Bounded by pysafe.py run; the checker comes
# from the base archive like regexploit below. Skipped until the base archive carries it (first landing).
if [ ! -f "$gate_scripts/scripts/tempsafe_check.py" ]; then
	printf 'SKIP tempsafe-range: checker absent from base archive\n' >&2
else
	printf '== tempsafe-range\n'
	if python3 -B "$gate_scripts/scripts/pysafe.py" run --timeout 300 -- python3 -B "$gate_scripts/scripts/tempsafe_check.py" --repo "$ROOT" ${base_ref:+--base "$base_ref"} --head "$local_sha"; then
		printf 'GREEN tempsafe-range\n'
	else
		rc=$?
		printf 'RED tempsafe-range producer_rc=%s: the range creates temp dirs outside kitlib (use ownedTmp from src/kitlib/tmp.ts, owned_tmp from scripts/kitlib_tmp.py, or kitlib_tmp from scripts/kitlib-tmp.sh; or justify the line inline with "tempsafe: <reason>")\n' "$rc" >&2
		exit "$rc"
	fi
fi
# KITLIB-RATCHET (ompkit-qwqh1): the pushed range adds no hand-rolled copy of a kitlib primitive
# (raw-spawn: a spawn outside kitlib_run.run / run(), a call-site `timeout N`). Same range ratchet,
# bound and base-archive source as tempsafe-range; skipped until the base archive carries it.
if [ ! -f "$gate_scripts/scripts/kitlib_ratchet.py" ]; then
	printf 'SKIP kitlib-range: checker absent from base archive\n' >&2
else
	printf '== kitlib-range\n'
	if python3 -B "$gate_scripts/scripts/pysafe.py" run --timeout 300 -- python3 -B "$gate_scripts/scripts/kitlib_ratchet.py" --repo "$ROOT" ${base_ref:+--base "$base_ref"} --head "$local_sha"; then
		printf 'GREEN kitlib-range\n'
	else
		rc=$?
		printf 'RED kitlib-range producer_rc=%s: the range hand-rolls a kitlib primitive or raises scripts/kitlib-ratchet-baseline.json (spawn through kitlib_run.run from scripts/kitlib_run.py or run() from src/kitlib/run.ts; the allowlist only shrinks, and a "kitlib: <reason>" pragma admits no site it does not count)\n' "$rc" >&2
		exit "$rc"
	fi
fi
# BRINITPIN1: new pushed-range br init sites must bind to the fixture's own
# tracker, because an unpinned init walks upward and locks an ancestor database.
# Run the base-archive checker so its policy cannot be changed by the candidate.
if [ ! -f "$gate_scripts/scripts/br_init_check.py" ]; then
	printf 'SKIP br-init-range: checker absent from base archive\n' >&2
else
	printf '== br-init-range\n'
	if python3 -B "$gate_scripts/scripts/pysafe.py" run --timeout 300 -- python3 -B "$gate_scripts/scripts/br_init_check.py" --repo "$ROOT" ${base_ref:+--base "$base_ref"} --head "$local_sha"; then
		printf 'GREEN br-init-range\n'
	else
		rc=$?
		printf 'RED br-init-range producer_rc=%s: the range adds an unpinned br init (pass --db <fixture/.beads/beads.db> or inline BEADS_DB for that path)\n' "$rc" >&2
		exit "$rc"
	fi
fi
# PORTGATE1: evaluate pushed additions against the base-archive checker and ratchet.
if [ ! -f "$gate_scripts/scripts/check-portable-paths.sh" ]; then
	printf 'SKIP portable-paths-range: checker absent from base archive\n' >&2
else
	printf '== portable-paths-range\n'
	if sh "$gate_scripts/scripts/check-portable-paths.sh" --repo "$ROOT" ${base_ref:+--base "$base_ref"} --head "$local_sha"; then
		printf 'GREEN portable-paths-range\n'
	else
		rc=$?
		printf 'RED portable-paths-range producer_rc=%s: new machine-local paths require resolution through the installed release or a documented config/env setting\n' "$rc" >&2
		exit "$rc"
	fi
fi
if [ -n "${base_ref:-}" ]; then
	python3.11 "$gate_scripts/scripts/regexploit-gate.py" --base "$base_ref" --head "$local_sha"
else
	python3.11 "$gate_scripts/scripts/regexploit-gate.py" --head "$local_sha"
fi
# Exercise the committed checker contracts before running the candidate tree's gate.
mkdir -p "$gate_scripts/var/agent-tmp"
for checker_test in \
	publishability.test.sh \
	doc-drift.test.sh \
	derived-check.test.sh \
	dispatch-check.test.sh \
	br-shim.test.sh \
	public-files.test.sh \
	commit-msg-bead.test.sh \
	check-pushed-beads.test.sh \
	release-train.test.sh \
	check-staged-br-init.test.sh
do
	test_path="$gate_scripts/tests/cli/$checker_test"
	if [ ! -f "$test_path" ]; then
		printf 'pre-push-gate: missing checker contract %s\n' "$checker_test" >&2
		exit 1
	fi
	printf '== checker-contract %s\n' "$checker_test"
	if TMPDIR="$gate_scripts/var/agent-tmp" sh "$test_path"; then
		printf 'GREEN checker-contract %s\n' "$checker_test"
	else
		rc=$?
		# GATE2: a contract red on the base tree is judged from the candidate
		# tree. The loop, the regexploit gate and fresh-gate.sh still come
		# from base; only this one rerun executes the candidate's test file.
		cand_path="$archive/tests/cli/$checker_test"
		if [ -n "${base_ref:-}" ] && [ -f "$cand_path" ]; then
			mkdir -p "$archive/var/agent-tmp"
			if TMPDIR="$archive/var/agent-tmp" sh "$cand_path" >/dev/null 2>&1; then
				printf 'BASE-RED checker-contract %s: base rc=%s, candidate green\n' "$checker_test" "$rc"
				continue
			fi
		fi
		printf 'RED checker-contract %s producer_rc=%s\n' "$checker_test" "$rc" >&2
		exit "$rc"
	fi
done
# COMMIT1: every pushed non-merge commit names a bead id that exists in the
# repo tracker. Reads git objects only, so commit-tree landings are checked.
# Skipped until the base archive carries the checker (first landing).
if [ ! -f "$gate_scripts/scripts/check-pushed-beads.sh" ]; then
	printf 'SKIP pushed-bead-ids: checker absent from base archive\n' >&2
elif [ -n "${base_ref:-}" ]; then
	printf '== pushed-bead-ids\n'
	if sh "$gate_scripts/scripts/check-pushed-beads.sh" --repo "$ROOT" --base "$base_ref" --tip "$local_sha"; then
		printf 'GREEN pushed-bead-ids\n'
	else
		rc=$?
		printf 'RED pushed-bead-ids producer_rc=%s\n' "$rc" >&2
		exit "$rc"
	fi
else
	printf 'SKIP pushed-bead-ids: no base to range against\n' >&2
fi
# FLY2-3: every pushed non-merge commit must import only files present in its
# own tree. Skipped until the base archive carries the checker (first landing).
if [ ! -f "$gate_scripts/scripts/check-commit-imports.sh" ]; then
	printf 'SKIP commit-imports: checker absent from base archive\n' >&2
elif [ -n "${base_ref:-}" ]; then
	printf '== commit-imports\n'
	if sh "$gate_scripts/scripts/check-commit-imports.sh" --repo "$ROOT" --base "$base_ref" --tip "$local_sha"; then
		printf 'GREEN commit-imports\n'
	else
		rc=$?
		printf 'RED commit-imports producer_rc=%s\n' "$rc" >&2
		exit "$rc"
	fi
else
	printf 'SKIP commit-imports: no base to range against\n' >&2
fi
# PUB1a: a push that changes the CLI surface without touching its docs is
# refused, naming the undocumented surface. Skipped until the base archive
# carries the checker (first landing).
if [ ! -f "$gate_scripts/scripts/doc-drift-check.sh" ]; then
	printf 'SKIP doc-drift: checker absent from base archive\n' >&2
elif [ -n "${base_ref:-}" ]; then
	printf '== doc-drift\n'
	if sh "$gate_scripts/scripts/doc-drift-check.sh" "$base_ref" "$local_sha" "$ROOT"; then
		printf 'GREEN doc-drift\n'
	else
		rc=$?
		printf 'RED doc-drift producer_rc=%s\n' "$rc" >&2
		exit "$rc"
	fi
else
	printf 'SKIP doc-drift: no base to range against\n' >&2
fi
# Not `exec`: exec replaces this shell, so the EXIT trap above never ran and every push leaked
# its archive extracts into var/agent-tmp (ompkit-fp72.40). The gate runs as a child.
# LAND1 (ompkit-rhy9.12): every publication needs the full-suite verdict for the exact candidate
# tree, not just the focused suites fresh-gate selected. The verdict script comes from the gate
# archive (base-authoritative, like every step above) and judges the candidate archive; its cache
# is keyed by candidate tree with check/runtime identity, so a repeated identical tree reuses the
# recorded verdict without rerunning. Skipped until the base archive carries the checker (first
# landing), like pushed-bead-ids, commit-imports and doc-drift above.
ledger_git=$(git -C "$ROOT" rev-parse --absolute-git-dir) || { printf 'pre-push-gate: cannot resolve git dir for fresh-gate ledger\n' >&2; exit 1; }
# NODOUBLEPASS1 (ompkit-bp50d): the focused gate reports what it ran GREEN on this tree; the verdict
# below runs only the complement. The report lives beside the archive, inside this gate's owned dir.
focused_passed="$archive_root/focused-passed.txt"
rm -f "$focused_passed"
FRESH_GATE_REPO="$ROOT" FRESH_GATE_LEDGER="$ledger_git/omp-kit/fresh-gate-runs.jsonl" FRESH_GATE_PASSED_OUT="$focused_passed" \
	sh "$gate_scripts/scripts/fresh-gate.sh" "$@"
if [ ! -f "$gate_scripts/scripts/full-suite-verdict.sh" ]; then
	printf 'SKIP full-suite-verdict: checker absent from base archive\n' >&2
else
	printf '== full-suite-verdict\n'
	set -- --repo "$ROOT" --commit "$local_sha" --judge-role base --archive-dir "$archive"
	[ -f "$focused_passed" ] && set -- "$@" --focused-passed "$focused_passed"
	if sh "$gate_scripts/scripts/full-suite-verdict.sh" "$@"; then
		printf 'GREEN full-suite-verdict\n'
	else
		rc=$?
		printf 'RED full-suite-verdict producer_rc=%s\n' "$rc" >&2
		exit "$rc"
	fi
fi
}
# The body runs as a plain subshell, not inside `||`: POSIX ignores set -e anywhere in an AND-OR
# list, so `( gate_body ) || st=$?` would let a failing early checker fall through. set +e is
# scoped to this group only; the subshell re-enables set -e for every step of the body. The status
# goes through a file because a pipeline reports tee's.
# GATESCR1: the body runs in the background and the shell waits for it, because a POSIX shell defers
# a trap until its foreground job ends: with a hung suite in the foreground, HUP/INT/TERM never ran
# the handler and the extract stayed (pids 4475, 2964, 2026-10-18). `wait` returns on the signal.
{ set +e; ( set -e; gate_body ); printf '%s\n' "$?" >"$archive_root/gate.rc"; } 2>&1 | tee "$archive_root/gate.log" &
wait "$!" || :
gate_rc=$(cat "$archive_root/gate.rc" 2>/dev/null) || gate_rc=1
case "$gate_rc" in ''|*[!0-9]*) gate_rc=1 ;; esac
[ "$gate_rc" = 0 ] || gate_red=1
# CI-SPEED (ompkit-bp50d): a green gate's log is the only record of its phase anatomy and of the
# full-suite join decision; keep it beside the fresh-gate ledger, local to this checkout, never committed.
log_git=$(git -C "$ROOT" rev-parse --absolute-git-dir 2>/dev/null) || log_git=""
if [ -f "$archive_root/gate.log" ] && [ -n "$log_git" ] && mkdir -p "$log_git/omp-kit/gate-logs" 2>/dev/null; then
	cp "$archive_root/gate.log" "$log_git/omp-kit/gate-logs/${local_sha:-unknown}.$(date -u +%Y%m%dT%H%M%SZ).log" 2>/dev/null || :
fi
trap - EXIT
cleanup
exit "$gate_rc"
