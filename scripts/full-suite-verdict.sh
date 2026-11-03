#!/bin/sh
# Every unquoted expansion in this file splits newline-separated archive-relative paths with no
# spaces.
# shellcheck disable=SC2086
# full-suite-verdict.sh -- require and cache the full-suite verdict for an exact candidate tree.
# (ompkit-rhy9.12)
#
# Usage:
#   scripts/full-suite-verdict.sh --repo ROOT --commit SHA [--judge-role base|main]
#     [--archive-dir DIR] [--cache-dir DIR] [--focused-passed FILE] [--rerun-reason TEXT]
#
# The complete declared repo suite runs against the exact-commit archive: every bun test under
# tests/cli and tests/fleet-guard, every shell suite tests/cli/*.test.sh, and every python suite
# tests/cli + tests/scripts (*_test.py, *.test.py). Focused selection, wall-budget deferral, SKIP
# and CI deferral never substitute: only a finished run with every enumerated suite green is PASS.
# Rows of scripts/gate-ci-only.tsv (read beside this script, like every gate script) name tests
# that cannot be hermetic on a dev Mac; they are excluded by declaration, printed, and recorded in
# the entry. A changed manifest changes the check identity below, so its verdicts never reuse.
#
# The verdict store is shared by clones of the same repository and configured outside every
# checkout. A record is keyed by exact candidate tree, judge role, complete judging-code identity,
# and runtime identity. `base` judges a proposed commit using the base revision's gate; `main`
# judges a commit already on main using its own gate. The two roles never satisfy each other's
# lookup.
# Only complete suite runs are recorded. Missing, corrupt, timed-out or incomplete evidence is a
# miss. A complete FAIL is reusable as FAIL but never as PASS. `--rerun-reason TEXT` reruns a
# cached FAIL and retains the superseded record and log.
# FULL_SUITE_VERDICT_CACHE_DIR overrides the configured store for isolated tests and operators.
# Otherwise scripts/full-suite-verdict-store.py uses
# $XDG_CONFIG_HOME/omp-kit/full-suite-verdict.json and $XDG_STATE_HOME/omp-kit/full-suite-verdicts.
# Files share FULL_SUITE_JOBS workers (default max(8, online cores - 4)).
# Unknown files run first, then longest recorded elapsed time for this judge/role.
# Suite bound: FULL_SUITE_TIMEOUT_SECS (default 1800). The suite runs at nice 10 inside the gate's
# own admission; it takes no heavy slot.
set -eu
umask 077
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd -P)
run_started_ms=$(python3 -c 'import time; print(time.time_ns() // 1000000)')
load_start=$(python3 -c 'import os,json; print(json.dumps(os.getloadavg()))')
ROOT=
COMMIT=
ARCHIVE_DIR=
CACHE_DIR=
RERUN_REASON=
RERUN=0
JUDGE_ROLE=base
TIMEOUT_SECS=${FULL_SUITE_TIMEOUT_SECS:-1800}
FOCUSED_PASSED=
usage() {
	echo "usage: full-suite-verdict.sh --repo ROOT --commit SHA [--judge-role base|main] [--archive-dir DIR] [--cache-dir DIR] [--focused-passed FILE] [--rerun-reason TEXT]" >&2
}

fail() {
	echo "FULL-SUITE: RED: $*" >&2
	return 1
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--repo) [ "$#" -ge 2 ] || { usage; exit 2; }; ROOT=$2; shift 2 ;;
		--commit) [ "$#" -ge 2 ] || { usage; exit 2; }; COMMIT=$2; shift 2 ;;
		--judge-role) [ "$#" -ge 2 ] || { usage; exit 2; }; JUDGE_ROLE=$2; shift 2 ;;
		--archive-dir) [ "$#" -ge 2 ] || { usage; exit 2; }; ARCHIVE_DIR=$2; shift 2 ;;
		--cache-dir) [ "$#" -ge 2 ] || { usage; exit 2; }; CACHE_DIR=$2; shift 2 ;;
		--rerun-reason) [ "$#" -ge 2 ] || { usage; exit 2; }; RERUN=1; RERUN_REASON=$2; shift 2 ;;
		--focused-passed) [ "$#" -ge 2 ] || { usage; exit 2; }; FOCUSED_PASSED=$2; shift 2 ;;
		-h|--help) usage; exit 0 ;;
		*) usage; exit 2 ;;
	esac
done
if [ -z "$ROOT" ] || [ -z "$COMMIT" ]; then
	usage
	exit 2
fi
if [ "$RERUN" = 1 ] && [ -z "$RERUN_REASON" ]; then
	fail "--rerun-reason needs a non-empty reason; the cached verdict is kept and nothing reruns"
	exit 1
fi
case "$TIMEOUT_SECS" in ''|*[!0-9]*|0) fail "FULL_SUITE_TIMEOUT_SECS must be a positive integer" ; exit 1 ;; esac
# No suite may block on stdin (pre-push hooks inherit a pipe whose writer never closes).
exec </dev/null
# HERMETIC1-B: discard caller authority before Git probes and suite execution, not the requested verdict.
unset GIT_DIR GIT_WORK_TREE BEADS_DB
case "$JUDGE_ROLE" in base|main) ;; *) fail "--judge-role must be base or main"; exit 2 ;; esac

command -v bun >/dev/null 2>&1 || { fail "bun is not on PATH; the full suite cannot run"; exit 1; }
command -v python3 >/dev/null 2>&1 || { fail "python3 is not on PATH; verdict evidence cannot be recorded"; exit 1; }

type=$(git -C "$ROOT" cat-file -t "$COMMIT" 2>/dev/null) || { fail "candidate $COMMIT is not a git object in $ROOT"; exit 1; }
[ "$type" = "commit" ] || { fail "candidate $COMMIT is a $type, not a commit"; exit 1; }
tree=$(git -C "$ROOT" rev-parse "$COMMIT^{tree}" 2>/dev/null) || { fail "candidate $COMMIT has no readable tree"; exit 1; }
case "$tree" in *[!0-9a-f]*|???????????????????????????????????????) fail "candidate tree hash is not hex: $tree"; exit 1 ;; esac
[ "${#tree}" -ge 40 ] || { fail "candidate tree hash is too short: $tree"; exit 1; }

# Judge identity is fixed across checkout and archive invocations. The helper owns identity,
# runtime, repository-store resolution and validation so every producer and reader agrees.
[ -f "$SCRIPT_DIR/full-suite-verdict.sh" ] || { fail "judging script is absent beside the gate"; exit 1; }
[ -f "$SCRIPT_DIR/full-suite-verdict-store.py" ] || { fail "verdict store helper is absent beside the gate"; exit 1; }
[ -f "$SCRIPT_DIR/fresh-gate.sh" ] || { fail "scripts/fresh-gate.sh is absent beside the gate"; exit 1; }
checks=$(python3 "$SCRIPT_DIR/suite-metrics.py" identity --root "$SCRIPT_DIR/.." --scope full) || {
	fail "the complete judging dependency identity is unreadable"; exit 1;
}
runtime=$(python3 "$SCRIPT_DIR/suite-metrics.py" runtime) || {
	fail "the complete judging runtime identity is unreadable"; exit 1;
}
if [ -z "$CACHE_DIR" ]; then CACHE_DIR=${FULL_SUITE_VERDICT_CACHE_DIR:-}; fi
if [ -n "$CACHE_DIR" ]; then
	entry=$(python3 "$SCRIPT_DIR/full-suite-verdict-store.py" path --repo "$ROOT" --tree "$tree" \
		--role "$JUDGE_ROLE" --checks "$checks" --runtime "$runtime" --judge-root "$SCRIPT_DIR/.." \
		--cache-dir "$CACHE_DIR") || { fail "cannot resolve the shared verdict record path"; exit 1; }
else
	entry=$(python3 "$SCRIPT_DIR/full-suite-verdict-store.py" path --repo "$ROOT" --tree "$tree" \
		--role "$JUDGE_ROLE" --checks "$checks" --runtime "$runtime" --judge-root "$SCRIPT_DIR/..") || {
		fail "cannot resolve the shared verdict record path"; exit 1;
	}
fi
CACHE_DIR=${entry%/*}
log_entry=${entry%.json}.log
incomplete_log="${entry%.json}.incomplete.$$.log"
timings_csv="${entry%.json}.timings.$$.csv"
mkdir -p "$CACHE_DIR" || { fail "verdict store is not writable: $CACHE_DIR"; exit 1; }

# A record is reusable only after the canonical store validates its role, judge/runtime identity,
# exact commit suite set, complete measured rows and paired log digest.
cached=MISS
if [ -f "$entry" ]; then
	if ! cached=$(python3 "$SCRIPT_DIR/full-suite-verdict-store.py" lookup --repo "$ROOT" \
		--tree "$tree" --role "$JUDGE_ROLE" --checks "$checks" --runtime "$runtime" \
		--judge-root "$SCRIPT_DIR/.." --commit "$COMMIT" --cache-dir "$CACHE_DIR"); then
		fail "shared verdict lookup failed"
		exit 1
	fi
fi
case "$cached" in
	PASS)
		echo "FULL-SUITE: VERDICT REUSED PASS tree=$tree role=$JUDGE_ROLE checks=$checks runtime=$runtime"
		exit 0 ;;
	FAIL*)
		if [ "$RERUN" = 1 ]; then
			# Preserve the complete superseded FAIL and its matching log before rerunning.
			superseded_digest=$(shasum -a 256 "$entry" | cut -d' ' -f1) || {
				fail "cached verdict is unreadable; the cached FAIL is kept and nothing reruns"; exit 1;
			}
			[ -n "$superseded_digest" ] || {
				fail "cached verdict is unreadable; the cached FAIL is kept and nothing reruns"; exit 1;
			}
			superseded_stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ) || {
				fail "the clock is unreadable; the cached FAIL is kept and nothing reruns"; exit 1;
			}
			SUPERSEDED_BASE="${entry%.json}.superseded-$superseded_stamp"
			cp "$entry" "$SUPERSEDED_BASE.json" || {
				fail "cannot keep the superseded verdict; the cached FAIL is kept and nothing reruns"; exit 1;
			}
			cp "$log_entry" "$SUPERSEDED_BASE.log" || {
				rm -f "$SUPERSEDED_BASE.json"
				fail "cannot keep the superseded log; the cached FAIL is kept and nothing reruns"; exit 1;
			}
			RERUN_ACTOR=${AGENT_NAME:-${USER:-unknown}}
			[ -n "$RERUN_ACTOR" ] || RERUN_ACTOR=unknown
			export SUPERSEDED_DIGEST="$superseded_digest" SUPERSEDED_FILE="$SUPERSEDED_BASE.json"
			echo "FULL-SUITE: RERUN reason='$RERUN_REASON' actor='$RERUN_ACTOR' superseded=$SUPERSEDED_BASE.json; running the complete suite again"
		else
			code=$(printf '%s' "$cached" | cut -d' ' -f2)
			case "$code" in ''|*[!0-9]*|0) code=1 ;; esac
			[ "$code" -gt 125 ] && code=1
			echo "FULL-SUITE: VERDICT REUSED FAIL tree=$tree role=$JUDGE_ROLE checks=$checks runtime=$runtime producer_rc=$code; the push is refused without rerun" >&2
			exit "$code"
		fi ;;
	MISS) echo "FULL-SUITE: cache miss for tree $tree role=$JUDGE_ROLE (no reusable verdict); running the complete suite" ;;
	*) fail "shared verdict lookup returned an invalid result"; exit 1 ;;
esac

# The exact-commit archive under judgment. A caller-supplied archive (the pre-push gate's
# candidate extract) is used as is; otherwise the candidate is exported from git objects only,
# never the working tree.
OWN_ARCHIVE=0
if [ -z "$ARCHIVE_DIR" ]; then
	WORK_PARENT="$ROOT/var/agent-tmp"
	mkdir -p "$WORK_PARENT" || { fail "cannot stage the candidate archive"; exit 1; }
	export KITLIB_TMP_ROOT="$WORK_PARENT"
	# shellcheck source=scripts/kitlib-tmp.sh
	. "$SCRIPT_DIR/kitlib-tmp.sh"
	kitlib_tmp ARCHIVE_DIR full-suite-verdict || { fail "cannot stage the candidate archive"; exit 1; }
	OWN_ARCHIVE=1
fi
cleanup_archive() {
	if [ "$OWN_ARCHIVE" = 1 ]; then kitlib_tmp_cleanup "$ARCHIVE_DIR" 2>/dev/null || :; fi
	return 0
}
if [ "$OWN_ARCHIVE" = 1 ] && ! git -C "$ROOT" archive "$COMMIT" | tar -xf - -C "$ARCHIVE_DIR"; then
	cleanup_archive
	fail "cannot export candidate $COMMIT"
	exit 1
fi
if [ ! -d "$ARCHIVE_DIR/tests" ]; then
	cleanup_archive
	fail "candidate archive has no tests/ tree"
	exit 1
fi

# Enumerate the complete declared suite from the archive. No focus selection, no wall-budget
# planner: everything runnable runs.
bun_files=""
if [ -d "$ARCHIVE_DIR/tests/cli" ]; then
	bun_files="$bun_files $(cd "$ARCHIVE_DIR" && find tests/cli -name '*.test.ts' -not -path '*/var/agent-tmp/*' | sort)"
fi
if [ -d "$ARCHIVE_DIR/tests/fleet-guard" ]; then
	bun_files="$bun_files $(cd "$ARCHIVE_DIR" && find tests/fleet-guard -name '*.test.ts' -not -path '*/var/agent-tmp/*' | sort)"
fi
shell_suites=""
if [ -d "$ARCHIVE_DIR/tests/cli" ]; then
	shell_suites=$(cd "$ARCHIVE_DIR" && find tests/cli -maxdepth 1 -name '*.test.sh' | sort)
fi
py_suites=""
for pydir in tests/cli tests/scripts; do
	if [ -d "$ARCHIVE_DIR/$pydir" ]; then
		found=$(cd "$ARCHIVE_DIR" && find "$pydir" -maxdepth 1 \( -name '*_test.py' -o -name '*.test.py' \) | sort)
		py_suites="$py_suites $found"
	fi
done
# Declared CI-only rows (hermeticity limits, never focus or budget deferral) are excluded by the
# manifest, printed, and recorded. Every other enumerated file runs.
excluded=""
kept_bun=""; kept_shell=""; kept_py=""
if [ -f "$SCRIPT_DIR/gate-ci-only.tsv" ]; then
	manifest="$SCRIPT_DIR/gate-ci-only.tsv"
	for candidate in $bun_files $shell_suites $py_suites; do
		[ -n "$candidate" ] || continue
		if awk -F '\t' -v p="$candidate" 'NR > 1 && $1 == p { found=1; exit 0 } END { exit found ? 0 : 1 }' "$manifest"; then
			excluded="$excluded $candidate"
			echo "full-suite: excluded $candidate (gate-ci-only manifest; CI runs it)"
		fi
	done
fi
for candidate in $bun_files; do
	[ -n "$candidate" ] || continue
	case " $excluded " in *" $candidate "*) ;; *) kept_bun="$kept_bun $candidate" ;; esac
done
for candidate in $shell_suites; do
	[ -n "$candidate" ] || continue
	case " $excluded " in *" $candidate "*) ;; *) kept_shell="$kept_shell $candidate" ;; esac
done
for candidate in $py_suites; do
	[ -n "$candidate" ] || continue
	case " $excluded " in *" $candidate "*) ;; *) kept_py="$kept_py $candidate" ;; esac
done
set -- $kept_bun; bun_count=$#
set -- $kept_shell; shell_count=$#
set -- $kept_py; py_count=$#
set -- $excluded; excluded_count=$#
echo "full-suite: bun=$bun_count shell=$shell_count python=$py_count excluded_ci_only=$excluded_count"
# NODOUBLEPASS1 (ompkit-bp50d): the focused gate judged part of this same tree already. Its report
# names the tree and every file it ran GREEN; those files are subtracted from the complete suite and
# recorded as covered, so the verdict still spans the declared suite while this run pays only for
# the complement. A report for another tree, or a name the archive does not enumerate, is printed
# and ignored: nothing is subtracted on trust.
covered_bun=""; covered_shell=""; covered_py=""; covered_ignored=""
# The join decision is recorded in the verdict json (focused_join), not only on stdout a caller may drop.
focused_join="no-report"
focused_metrics=""
if [ -n "$FOCUSED_PASSED" ]; then
	if [ ! -f "$FOCUSED_PASSED" ]; then
		focused_join="absent"
		echo "full-suite: focused-passed report $FOCUSED_PASSED is absent; running the complete suite"
	else
		report_tree=$(sed -n '1s/^tree //p' "$FOCUSED_PASSED")
		report_judge=$(sed -n 's/^judge //p' "$FOCUSED_PASSED" | head -n 1)
		report_runtime=$(sed -n 's/^runtime //p' "$FOCUSED_PASSED" | head -n 1)
		own_judge=$(python3 "$SCRIPT_DIR/suite-metrics.py" identity --root "$SCRIPT_DIR/.." --scope focused) || own_judge=""
		if [ "$report_tree" != "$tree" ]; then
			focused_join="tree-mismatch:${report_tree:-?}"
			echo "full-suite: focused-passed report is for tree ${report_tree:-?}, not candidate $tree; ignored, running the complete suite"
		elif [ "$report_judge" != "$own_judge" ] || [ -z "$report_judge" ]; then
			focused_join="judge-mismatch:${report_judge:-?}"
			echo "full-suite: focused-passed report was written by judge ${report_judge:-?}, not this gate's fresh-gate.sh ${own_judge:-?}; ignored, running the complete suite"
		elif [ "$report_runtime" != "$runtime" ]; then
			focused_join="runtime-mismatch:${report_runtime:-?}"
			echo "full-suite: focused-passed report ran on runtime ${report_runtime:-?}, not $runtime; ignored, running the complete suite"
		else
			focused_join="joined"
			rest_bun=""; rest_shell=""; rest_py=""
			reported=$(grep -v -E '^(tree|judge|runtime) ' "$FOCUSED_PASSED" | awk 'NF && !seen[$0]++')
			for candidate in $kept_bun; do
				case "
$reported
" in *"
$candidate
"*) covered_bun="$covered_bun $candidate" ;; *) rest_bun="$rest_bun $candidate" ;; esac
			done
			for candidate in $kept_shell; do
				case "
$reported
" in *"
$candidate
"*) covered_shell="$covered_shell $candidate" ;; *) rest_shell="$rest_shell $candidate" ;; esac
			done
			for candidate in $kept_py; do
				case "
$reported
" in *"
$candidate
"*) covered_py="$covered_py $candidate" ;; *) rest_py="$rest_py $candidate" ;; esac
			done
			for name in $reported; do
				case " $kept_bun $kept_shell $kept_py " in *" $name "*) ;; *) covered_ignored="$covered_ignored $name"; echo "full-suite: focused-passed names $name, not in the declared suite; ignored" ;; esac
			done
			if [ -n "$covered_bun$covered_shell$covered_py" ]; then
				if METRICS="$SCRIPT_DIR/suite-metrics.py" FILE="$FOCUSED_PASSED.timings.json" \
					COVERED="$covered_bun $covered_shell $covered_py" TREE="$tree" python3 - <<'PYEOF'
import importlib.util, json, os
try:
    spec = importlib.util.spec_from_file_location("metrics", os.environ["METRICS"])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with open(os.environ["FILE"]) as handle:
        rows = json.load(handle)
    wanted = os.environ["COVERED"].split()
    rows = [row for row in rows if row["path"] in wanted]
    assert module.complete_records(rows, wanted)
    assert all(row["rc"] == 0 and row["closure"]["tree"] == os.environ["TREE"] for row in rows)
except (OSError, ValueError, TypeError, KeyError, AssertionError):
    raise SystemExit(1)
PYEOF
				then
					focused_metrics="$FOCUSED_PASSED.timings.json"
					kept_bun=$rest_bun; kept_shell=$rest_shell; kept_py=$rest_py
				else
					focused_join="timing-record-missing"
					covered_bun=""; covered_shell=""; covered_py=""
					echo "full-suite: focused timing evidence absent or incomplete; running the complete suite"
				fi
			fi
			set -- $covered_bun; cb=$#; set -- $covered_shell; cs=$#; set -- $covered_py; cp=$#
			set -- $kept_bun; bun_count=$#
			set -- $kept_shell; shell_count=$#
			set -- $kept_py; py_count=$#
			echo "full-suite: covered by the focused pass on the same tree: bun=$cb shell=$cs python=$cp; complement bun=$bun_count shell=$shell_count python=$py_count"
		fi
	fi
fi
if [ "$bun_count" -eq 0 ] && [ "$shell_count" -eq 0 ] && [ "$py_count" -eq 0 ]; then
	if [ -n "$covered_bun$covered_shell$covered_py" ]; then
		echo "full-suite: the focused pass covered the whole declared suite; nothing left to run"
	else
		cleanup_archive
		fail "candidate archive enumerates no runnable suite"
		exit 1
	fi
fi

# Contributor-only paths (the Bun fallback in runtime-adapter.sh) require .git, so the archive
# gets one, like the focused gate. MANIFEST.tsv is generated when absent, like the focused gate.
[ -e "$ARCHIVE_DIR/.git" ] || git -C "$ARCHIVE_DIR" init -q
if [ ! -f "$ARCHIVE_DIR/MANIFEST.tsv" ] && [ -f "$ARCHIVE_DIR/scripts/build-manifest.sh" ]; then
	if (cd "$ARCHIVE_DIR" && sh scripts/build-manifest.sh --stdout >MANIFEST.tsv); then
		echo "full-suite manifest generation: OK"
	else
		cleanup_archive
		fail "manifest generation failed"
		exit 1
	fi
fi

# One timing-split pool: unknown files first, then longest processing time first.
ncpu=$(getconf _NPROCESSORS_ONLN 2>/dev/null) || ncpu=1
case "$ncpu" in ''|*[!0-9]*|0) ncpu=1 ;; esac
pool_default=$((ncpu - 4))
[ "$pool_default" -ge 8 ] || pool_default=8
# Legacy name retained until the foreign-dirty complement test is migrated by its owner.
# An explicit width is authoritative; load includes this release's own tests.
POOL_JOBS=${FULL_SUITE_JOBS:-${FULL_SUITE_SHELL_JOBS:-$pool_default}}
case "$POOL_JOBS" in ''|*[!0-9]*|0) cleanup_archive; fail "FULL_SUITE_JOBS must be a positive integer"; exit 1 ;; esac
pool_files=$((bun_count + shell_count + py_count))
if [ "$pool_files" -gt 0 ] && [ "$POOL_JOBS" -gt "$pool_files" ]; then POOL_JOBS=$pool_files; fi
SHELL_JOBS=$POOL_JOBS
echo "full-suite: global timing-split pool: $POOL_JOBS workers"

SUITE_OUT="${entry%.json}.running.$$.log"
# Runner-owned summaries, never parsed from the combined log: nested tests print the same
# markers, but cannot contribute to this invocation's counts (FULLSUITECOUNT1).
SUITE_STATUS="$SUITE_OUT.status"
# Runner-private shell stage state: per suite N (sorted order) a claim dir N.claim, its output N.out
# and its exit code N.rc. The deadline watchdog touches the timed-out mark before it kills anything
# and reads the runner subshell's own pid from RUNNER_PID.
SHELL_DIR="$SUITE_OUT.shell"
RUNNER_PID="$SUITE_OUT.runner"
timeout_mark="$SUITE_OUT.timed-out"
# Per-invocation claim state is never reused, even for a recorded rerun of one tree.
METRICS_DIR="$SUITE_OUT.files.$$"
METRICS_ROWS="$SUITE_OUT.files.$$.json"
METRICS_DECLARED="$SUITE_OUT.declared.$$"
if ! mkdir "$METRICS_DIR"; then cleanup_archive; fail "cannot create fresh suite measurement state"; exit 1; fi
for metric_path in $kept_bun $kept_shell $kept_py $covered_bun $covered_shell $covered_py; do printf '%s\n' "$metric_path"; done >"$METRICS_DECLARED"
rm -f "$SUITE_STATUS" "$RUNNER_PID" "$timeout_mark"
rm -rf "$SHELL_DIR"
if ! : >"$SUITE_OUT" || ! : >"$SUITE_STATUS" || ! mkdir "$SHELL_DIR"; then cleanup_archive; fail "cannot write suite evidence"; exit 1; fi
# finish_logs DEST: preserve unmerged per-file output before dropping private worker state.
finish_logs() {
	for fl_output in "$METRICS_DIR"/bun-*.out "$METRICS_DIR"/python-*.out; do
		[ -f "$fl_output" ] || continue
		{ echo "full-suite: unfinished worker output follows ($fl_output)"; cat "$fl_output"; } >>"$SUITE_OUT"
	done
	for fl_suite in ${unfinished:-}; do
		echo "full-suite: script-suite $fl_suite did not finish before the declared deadline; retained partial output follows" >>"$SUITE_OUT"
	done
	if [ -d "$SHELL_DIR" ]; then
		fl_i=0
		for fl_suite in $kept_shell; do
			fl_i=$((fl_i + 1))
			if [ ! -f "$SHELL_DIR/$fl_i.out" ]; then continue; fi
			if [ -f "$SHELL_DIR/$fl_i.rc" ]; then
				echo "full-suite: script-suite $fl_suite exited rc=$(cat "$SHELL_DIR/$fl_i.rc") but the run ended before recording it; its output follows"
			else
				echo "full-suite: script-suite $fl_suite did not finish; its partial output follows"
			fi
			cat "$SHELL_DIR/$fl_i.out"
		done >>"$SUITE_OUT"
		rm -rf "$SHELL_DIR"
	fi
	# Native bytes bypass the metric supervisor's pipes. Preserve their retained
	# file even when a suite killed that supervisor before it could write its row.
	for fl_output in "$METRICS_DIR"/*.native.log; do
		[ -f "$fl_output" ] || continue
		fl_record="${fl_output%.native.log}.json"
		if ! python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("complete") is True else 1)' "$fl_record" 2>/dev/null; then
			{ echo "full-suite: retained unfinished native output follows"; cat "$fl_output"; } >>"$SUITE_OUT"
		fi
	done
	mv -f "$SUITE_OUT" "$1"
	rm -f "$SUITE_STATUS" "$RUNNER_PID"
	rm -rf "$METRICS_DIR"
}
# shell_unfinished: native file execution, not merely the logging supervisor's
# exit status. The measurement survives removal of the shell worker claims.
shell_unfinished() {
	su_i=0
	for su_suite in $kept_shell; do
		su_i=$((su_i + 1))
		if [ -d "$SHELL_DIR/$su_i.claim" ] || [ -f "$METRICS_DIR/shell-$su_i.native.log" ]; then
			if ! python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); limit=int(sys.argv[2] or "0"); sys.exit(0 if r.get("complete") is True and (not limit or r["finished_ms"] <= limit) else 1)' "$METRICS_DIR/shell-$su_i.json" "${timeout_at_ms:-0}" 2>/dev/null; then printf ' %s' "$su_suite"; fi
		fi
	done
}

# One deadline for the whole suite: every phase runs to completion and appends to the evidence
# log, so a failing suite yields a complete FAIL record (cached RED) instead of an incomplete run.
# Timeout kills the suite's process tree, refuses, and records nothing, so a retry reruns.
run_suite() {
	(
		append_suite_status() {
			{
				printf '%s\n' "$@"
			} >>"$SUITE_STATUS"
		}
		# Publisher tracker selection must not redirect tests away from their own fixtures.
		# Tests can still select an explicit tracker after the suite child starts.
		unset BEADS_DB
		cd "$ARCHIVE_DIR"
		# This subshell's own pid ($$ names the verdict process here). The deadline's TERM round spares
		# it: the kitlib trap installed below re-raises a caught TERM at $$, which would kill the verdict
		# process before it reports. Its children get TERM; it ends on its own or gets KILL 5 s later.
		sh -c 'echo "$PPID"' >"$RUNNER_PID" || exit 1
		# SAVEFIRST1: this full-suite process is a sibling of fresh-gate, so its descendants do not inherit
		# the fresh-gate process's save-only disk observer. Keep nested heavy calls on statfs; their physical
		# 10 GiB floor still refuses when the suite cannot fit.
		export OMP_KIT_DISK_OBSERVER=statfs
		export KITLIB_TMP_ROOT="$ARCHIVE_DIR/var/agent-tmp"
		mkdir -p "$KITLIB_TMP_ROOT"
		. "$ARCHIVE_DIR/scripts/kitlib-tmp.sh"
		# The full suite is a sibling of the pre-push harness; its inherited TMPDIR may
		# be the harness's plain bucket. Give every suite a private owned temp root.
		kitlib_tmp TMPDIR full-suite-run || exit 1
		export TMPDIR
		export OMP_KIT_CASE_CWD="$ARCHIVE_DIR"
		if [ -f "$ARCHIVE_DIR/bunfig.toml" ]; then
			export BUN_CONFIG_FILE="$ARCHIVE_DIR/bunfig.toml"
			bun_config="--config=$ARCHIVE_DIR/bunfig.toml"
		else
			bun_config=""
		fi
		# dfl CMD...: run CMD with SIGINT and SIGQUIT at their defaults, as in a foreground run. This
		# subshell runs as `run_suite &`, and a non-interactive shell starts background lists with both
		# ignored; a shell cannot un-ignore them, so suites inherited SIG_IGN and a test expecting death
		# by SIGINT exited 0 here only (kitlib_tmp_test test_03_sigint, ompkit-lrbd.3). exec keeps the pid.
		dfl() {
			python3 -c 'import os, signal, sys
for sig in (signal.SIGINT, signal.SIGQUIT):
    signal.signal(sig, signal.SIG_DFL)
os.execvp(sys.argv[1], sys.argv[1:])' "$@"
		}
		failed=0
		# All languages claim work from the same immutable timing-sorted queue.
		queue="$METRICS_DIR/queue"
		KEPT_BUN="$kept_bun" KEPT_SH="$kept_shell" KEPT_PY="$kept_py" CACHE="$CACHE_DIR" ROLE="$JUDGE_ROLE" CHECKS="$checks" python3 - <<'PYQUEUE' >"$queue"
import json, os
from pathlib import Path
history = {}
# Only this judge/role supplies scheduling hints; a hint never supplies a verdict.
for entry in sorted(Path(os.environ['CACHE']).glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True):
    try:
        data = json.loads(entry.read_text())
        if data.get('judge_role') != os.environ['ROLE'] or data.get('checks') != os.environ['CHECKS']:
            continue
        for row in data.get('evidence', {}).get('files', []):
            history.setdefault(row['path'], row['elapsed_ms'] / 1000)
    except (ValueError, KeyError, OSError, TypeError):
        continue
items = []
for kind, key in [('bun','KEPT_BUN'), ('shell','KEPT_SH'), ('python','KEPT_PY')]:
    for index, path in enumerate(os.environ[key].split(), 1):
        items.append((kind, index, path))
items.sort(key=lambda item: (item[2] in history, -history.get(item[2], 0), item[2]))
for kind, index, path in items:
    print(kind, index, path)
PYQUEUE
		# Allocate in the supervisor: kitlib's signal traps re-raise at $$, which in
		# POSIX worker subshells still names the outer verdict process.
		while read -r kind index suite; do
			kitlib_tmp suite_tmp "full-suite-$kind" || exit 1
			eval "suite_tmp_${kind}_$index=\$suite_tmp"
			if [ "$kind" = bun ]; then
				kitlib_tmp suite_timing_dir bun-timings || exit 1
				eval "suite_timing_${kind}_$index=\$suite_timing_dir"
			fi
		done <"$queue"
		workers=""
		# shellcheck disable=SC2317,SC2329 # invoked indirectly: kitlib_tmp_atexit runs it on exit
		stop_workers() {
			for worker in $workers; do kill_tree "$worker" TERM; done
			for worker in $workers; do wait "$worker" 2>/dev/null || :; done
		}
		kitlib_tmp_atexit 'stop_workers'
		pool_worker() {
			# Workers inherit paths, not signal traps; the supervisor owns their cleanup.
			while read -r kind index suite; do
				[ ! -e "$timeout_mark" ] || return 0
				mkdir "$METRICS_DIR/$kind-$index.claim" 2>/dev/null || continue
				eval "TMPDIR=\$suite_tmp_${kind}_$index"
				export TMPDIR
				case "$kind" in
					bun) runner='bun'; bun_timing_dir=''; eval "bun_timing_dir=\$suite_timing_${kind}_$index"; set -- bun "${bun_config:---config=/dev/null}" test --timeout=120000 "--timings=$bun_timing_dir/bun.timings" --update-timings "./$suite" ;;
					shell) runner='sh'; set -- sh "$suite"; mkdir "$SHELL_DIR/$index.claim" ;;
					python) runner='python3'; set -- python3 "$suite" ;;
				esac
				rc=0
				dfl nice -n 10 python3 "$SCRIPT_DIR/suite-metrics.py" run \
					--record "$METRICS_DIR/$kind-$index.json" --path "$suite" --runner "$runner" \
					--tree "$tree" --cwd "$ARCHIVE_DIR" --workers "$POOL_JOBS" --deadline "$TIMEOUT_SECS" -- "$@" \
					>"$METRICS_DIR/$kind-$index.out" 2>&1 || rc=$?
				echo "$rc" >"$METRICS_DIR/$kind-$index.rc"
				if [ "$kind" = shell ]; then cp "$METRICS_DIR/$kind-$index.out" "$SHELL_DIR/$index.out"; echo "$rc" >"$SHELL_DIR/$index.rc"; fi
			done <"$queue"
		}
		w=0
		while [ "$w" -lt "$POOL_JOBS" ]; do
			w=$((w + 1)); pool_worker & workers="$workers $!"
		done
		lost=0
		for worker in $workers; do wait "$worker" || lost=1; done
		workers=""
		bun_rc=0; b_tests=0; b_failed=0
		for kind in shell python bun; do
			case "$kind" in shell) suites=$kept_shell; label=script-suite ;; python) suites=$kept_py; label=python-suite ;; bun) suites=$kept_bun ;; esac
			i=0
			for suite in $suites; do
				i=$((i + 1))
				src=$(cat "$METRICS_DIR/$kind-$i.rc" 2>/dev/null) || { lost=1; continue; }
				cat "$METRICS_DIR/$kind-$i.out"
				if [ "$kind" = bun ]; then
					counts=$(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r["test_count"],r["test_failures"])' "$METRICS_DIR/$kind-$i.json") || { lost=1; continue; }
					set -- $counts; b_tests=$((b_tests + $1)); b_failed=$((b_failed + $2))
					[ "$src" -eq 0 ] || bun_rc=1
				else
					if [ "$src" -eq 0 ]; then line="GREEN $label $suite"; else line="RED $label $suite rc=$src"; failed=1; fi
					echo "$line"; append_suite_status "$line"
				fi
				if [ "$kind" = shell ]; then rm -f "$SHELL_DIR/$i.out" "$SHELL_DIR/$i.rc"; rmdir "$SHELL_DIR/$i.claim"; fi
				rm -f "$METRICS_DIR/$kind-$i.out"
			done
		done
		if [ "$bun_count" -gt 0 ]; then
			append_suite_status "BUN rc=$bun_rc" "BUN_RAN $b_tests" "BUN_FAIL $b_failed"
			[ "$bun_rc" -eq 0 ] || failed=1
		fi
		echo "full-suite: shell stage: $shell_count suites, $SHELL_JOBS at a time (shared global pool)"
		[ "$lost" -eq 0 ] || exit 2
		exit "$failed"
	) >>"$SUITE_OUT" 2>&1
}

# kill_tree PID SIG [SPARE]: post-order signal to the suite process tree, skipping the pids listed in
# SPARE (their children are still signalled). A plain kill of the subshell leaves its bun
# grandchildren running; this walks parent links instead (same ps snapshot shape as the gate's
# stop_descendants). Reparented strays are out of reach, like in the gate. PID stays in $1, the only
# function-local state in POSIX sh: with PID in a global the recursion overwrote it and only the last
# leaf was signalled, so a hung suite's shell and the runner went on past the deadline (FULLSUITEPAR1).
kill_tree() {
	kt_children=$(ps -A -o pid= -o ppid= 2>/dev/null | awk -v r="$1" '$2 == r { print $1 }')
	for kt_child in $kt_children; do kill_tree "$kt_child" "$2" "${3:-}"; done
	case " ${3:-} " in
		*" $1 "*) ;;
		*) kill "-$2" "$1" 2>/dev/null || true ;;
	esac
}

timed_out=0
timeout_at_ms=0
suite_rc=0
run_suite &
suite_pid=$!
# Wait on the suite itself; a watchdog enforces the deadline. Polling every 5 s made even an
# instant suite cost a full 5 s per verdict (every land call paid it). The TERM round spares the
# runner subshell and its parent (RUNNER_PID): they end once their children are gone, and the KILL
# round ends them otherwise.
(
	sleep "$TIMEOUT_SECS"
	python3 -c 'import time; print(time.time_ns() // 1000000)' >"$timeout_mark"
	kill_tree "$suite_pid" TERM "$suite_pid $(cat "$RUNNER_PID" 2>/dev/null || :)"
	sleep 5
	kill_tree "$suite_pid" KILL
) 2>/dev/null &
watchdog_pid=$!
wait "$suite_pid" 2>/dev/null || suite_rc=$?
kill_tree "$watchdog_pid" TERM
wait "$watchdog_pid" 2>/dev/null || true
if [ -f "$timeout_mark" ]; then
	timeout_at_ms=$(cat "$timeout_mark")
	rm -f "$timeout_mark"
	timed_out=1
fi
if [ "$timed_out" = 1 ]; then
	unfinished=$(shell_unfinished)
	finish_logs "$incomplete_log"
	cleanup_archive
	fail "full suite timed out after ${TIMEOUT_SECS}s${unfinished:+; unfinished script suites:$unfinished}; incomplete evidence is non-pass and nothing was cached; partial log: $incomplete_log"
	exit 1
fi

# Counts come from the final native summary in each isolated file output, summed by
# the runner into its private status file. Never manufacture a native Bun summary.
bun_ran=$(awk '$1 == "BUN_RAN" { print $2 }' "$SUITE_STATUS")
bun_fail=$(awk '$1 == "BUN_FAIL" { print $2 }' "$SUITE_STATUS")
bun_ran=${bun_ran:-0}
bun_fail=${bun_fail:-0}
bun_status=$(grep -c '^BUN rc=' "$SUITE_STATUS" 2>/dev/null || true)
bun_status_rc=$(sed -n 's/^BUN rc=//p' "$SUITE_STATUS" 2>/dev/null | tail -n 1)
shell_green=$(grep -c '^GREEN script-suite ' "$SUITE_STATUS" 2>/dev/null || true)
shell_red=$(grep -c '^RED script-suite ' "$SUITE_STATUS" 2>/dev/null || true)
py_green=$(grep -c '^GREEN python-suite ' "$SUITE_STATUS" 2>/dev/null || true)
py_red=$(grep -c '^RED python-suite ' "$SUITE_STATUS" 2>/dev/null || true)
# suite_set KIND: sorted suite paths the status file accounts for, one per line, duplicates kept.
suite_set() { awk -v k="$1" '($1 == "GREEN" || $1 == "RED") && $2 == k { print $3 }' "$SUITE_STATUS" 2>/dev/null | sort; }
want_set() { for s in $1; do [ -n "$s" ] && echo "$s"; done | sort; }
complete=1
# The suite subshell exits 0 or 1 ("$failed", or 1 when it cannot set up), or 2 when shell suites went
# unrecorded (a worker died, or the deadline passed). Any other status means it was killed, so its
# status lines may not cover every suite it would have run: incomplete.
case "$suite_rc" in 0|1) ;; *) complete=0 ;; esac
if [ "$bun_count" -eq 0 ] 2>/dev/null; then
	[ "$bun_status" -eq 0 ] 2>/dev/null || complete=0
elif [ "$bun_count" -gt 0 ] 2>/dev/null && [ "$bun_ran" -gt 0 ] 2>/dev/null && [ "$bun_status" -eq 1 ] 2>/dev/null; then
	:
else
	complete=0
fi
[ "$((shell_green + shell_red))" -eq "$shell_count" ] 2>/dev/null || complete=0
[ "$((py_green + py_red))" -eq "$py_count" ] 2>/dev/null || complete=0
[ "$(suite_set script-suite)" = "$(want_set "$kept_shell")" ] || complete=0
[ "$(suite_set python-suite)" = "$(want_set "$kept_py")" ] || complete=0
if [ "$complete" -ne 1 ]; then
	unfinished=$(shell_unfinished)
	finish_logs "$incomplete_log"
	cleanup_archive
	fail "full suite ended without complete evidence (rc=$suite_rc bun_ran=$bun_ran shell=$shell_green/$shell_count python=$py_green/$py_count)${unfinished:+; unfinished script suites:$unfinished}; incomplete evidence is non-pass and nothing was cached; partial log: $incomplete_log"
	exit 1
fi

# A complete textual run is not reusable without the complete measured file set.
# Keep the same declared suites and the same wall bound; missing rows fail cold.
set --
[ -z "$focused_metrics" ] || set -- --covered "$focused_metrics"
if ! python3 "$SCRIPT_DIR/suite-metrics.py" collect \
	--records "$METRICS_DIR" --declared "$METRICS_DECLARED" --output "$METRICS_ROWS" \
	--csv "$timings_csv" --cwd "$ARCHIVE_DIR" --tables-dir "$CACHE_DIR/timings" "$@"; then
	finish_logs "$incomplete_log"
	cleanup_archive
	fail "per-file timing evidence is incomplete; nothing was cached; partial log: $incomplete_log"
	exit 1
fi
run_finished_ms=$(python3 -c 'import time; print(time.time_ns() // 1000000)')
load_end=$(python3 -c 'import os,json; print(json.dumps(os.getloadavg()))')

# A complete-looking run can still have silently lost suites. Historical
# evidence is a reference only; it never supplies a current-run PASS.
minimum_run_assessment() (
	case "$ROOT" in
		/*) minimum_repo=$ROOT ;;
		*) minimum_repo="$(pwd -P)/$ROOT" ;;
	esac
	case "$ARCHIVE_DIR" in
		/*) minimum_archive=$ARCHIVE_DIR ;;
		*) minimum_archive="$(pwd -P)/$ARCHIVE_DIR" ;;
	esac
	cd -- "$SCRIPT_DIR" || exit 1
	python3 ./full-suite-verdict-store.py minimum-run \
		--repo "$minimum_repo" --cache-dir "$CACHE_DIR" --role "$JUDGE_ROLE" --runtime "$runtime" \
		--judge-root "$SCRIPT_DIR/.." --suite-root "$minimum_archive" --files "$METRICS_ROWS" \
		--wall-ms "$((run_finished_ms - run_started_ms))"
)
if ! minimum_run=$(minimum_run_assessment); then
	finish_logs "$incomplete_log"
	cleanup_archive
	fail "minimum-run assessment unavailable; nothing was cached; partial log: $incomplete_log"
	exit 1
fi
printf 'MINRUN1: %s\n' "$minimum_run" >>"$SUITE_OUT"

if [ "$suite_rc" -eq 0 ] && [ "${bun_status_rc:-0}" = 0 ] && [ "$bun_fail" -eq 0 ] && [ "$shell_red" -eq 0 ] && [ "$py_red" -eq 0 ]; then
	verdict=PASS
	code=0
else
	verdict=FAIL
	code=$suite_rc
	[ "$code" -ne 0 ] || code=1
fi

# Record the finished verdict atomically beside its evidence log. Only complete runs land here.
finish_logs "$log_entry"
write_complete_verdict() {
MINIMUM_RUN="$minimum_run" METRICS_ROWS="$METRICS_ROWS" METRICS_DECLARED="$METRICS_DECLARED" RUN_START="$run_started_ms" RUN_END="$run_finished_ms" LOAD_START="$load_start" LOAD_END="$load_end" WORKERS_SHELL="$SHELL_JOBS" RERUN_FLAG=$RERUN RERUN_WHY="$RERUN_REASON" RERUN_WHO=${RERUN_ACTOR:-} RERUN_SUP_DIGEST=${SUPERSEDED_DIGEST:-} RERUN_SUP_FILE=${SUPERSEDED_FILE:-} TREE=$tree ROLE=$JUDGE_ROLE CHECKS=$checks RUNTIME=$runtime VERDICT=$verdict CODE=$code BUNF=$bun_count BUNRAN=$bun_ran BUNFAIL=$bun_fail SHC=$shell_count SHR=$shell_red PYC=$py_count PYR=$py_red EXCL="$excluded" COVB="$covered_bun" COVS="$covered_shell" COVP="$covered_py" COVI="$covered_ignored" FJOIN="$focused_join" ENTRY="$entry" LOG="$log_entry" python3 - <<'PYEOF'
import hashlib, json, math, os
log_digest = hashlib.sha256()
with open(os.environ["LOG"], "rb") as log:
    for chunk in iter(lambda: log.read(1024 * 1024), b""):
        log_digest.update(chunk)
from datetime import datetime, timezone
with open(os.environ["METRICS_ROWS"]) as handle:
    files = json.load(handle)
with open(os.environ["METRICS_DECLARED"]) as handle:
    declared_files = handle.read().splitlines()
def phase_total(rows, field):
    values = [row.get(field) for row in rows]
    if not values:
        return 0
    if any(not isinstance(value, (int, float)) or isinstance(value, bool)
           or not math.isfinite(value) or value < 0 for value in values):
        return None
    return sum(values)
stages = {}
for runner in ("bun", "sh", "python3"):
    selected = [row for row in files if row["runner"] == runner and row.get("origin") != "focused"]
    stages[runner] = {
        "wall_ms": max(row["finished_ms"] for row in selected) - min(row["started_ms"] for row in selected) if selected else 0,
        "wait_ms": phase_total(selected, "wait_ms"),
        "setup_ms": phase_total(selected, "setup_ms"),
        "run_ms": phase_total(selected, "run_ms"),
        "file_count": len(selected),
        "phase_basis": "per-file-sum",
        "cpu_user_ms": sum(row["cpu_user_ms"] for row in selected),
        "cpu_system_ms": sum(row["cpu_system_ms"] for row in selected),
    }
entry = {
    "version": 3,
    "tree": os.environ["TREE"],
    "judge_role": os.environ["ROLE"],
    "checks": os.environ["CHECKS"],
    "runtime": os.environ["RUNTIME"],
    "verdict": os.environ["VERDICT"],
    "exit_code": int(os.environ["CODE"]),
    "judge": {"role": os.environ["ROLE"], "checks_sha256": os.environ["CHECKS"], "runtime": os.environ["RUNTIME"]},
    "timing": {
        "wall_ms": int(os.environ["RUN_END"]) - int(os.environ["RUN_START"]),
        "started_ms": int(os.environ["RUN_START"]),
        "load_start": json.loads(os.environ["LOAD_START"]),
        "load_end": json.loads(os.environ["LOAD_END"]),
        "workers": {"bun": min(int(os.environ["WORKERS_SHELL"]), int(os.environ["BUNF"])),
                    "shell": min(int(os.environ["WORKERS_SHELL"]), int(os.environ["SHC"])), "python": min(int(os.environ["WORKERS_SHELL"]), int(os.environ["PYC"]))},
        "stages": stages,
    },
    "evidence": {
        "log_sha256": log_digest.hexdigest(),
        "complete": True,
        "files": files,
        "declared_files": declared_files,
        "bun_files": int(os.environ["BUNF"]),
        "bun_ran": int(os.environ["BUNRAN"]),
        "bun_fail": int(os.environ["BUNFAIL"]),
        "shell_suites": int(os.environ["SHC"]),
        "shell_fail": int(os.environ["SHR"]),
        "py_suites": int(os.environ["PYC"]),
        "py_fail": int(os.environ["PYR"]),
        "excluded_ci_only": os.environ["EXCL"].split(),
        # NODOUBLEPASS1: files the focused pass judged GREEN on this same tree; this run paid only for the rest.
        "covered_by_focused": {"bun": os.environ["COVB"].split(), "shell": os.environ["COVS"].split(), "py": os.environ["COVP"].split(),
                               "ignored": os.environ["COVI"].split(), "join": os.environ["FJOIN"]},
    },
    "recorded_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
entry["minimum_run"] = json.loads(os.environ["MINIMUM_RUN"])
if entry["minimum_run"]["status"] == "FAIL":
    entry["verdict"] = "FAIL"
    if entry["exit_code"] == 0:
        entry["exit_code"] = 1
# FSRERUN1 (ompkit-t7cn7.4): a rerun of a cached FAIL records why, who and what it superseded.
# A run without --rerun-reason records no rerun block, so the lookup above still matches.
if os.environ.get("RERUN_FLAG") == "1":
    entry["rerun"] = {
        "reason": os.environ.get("RERUN_WHY", ""),
        "actor": os.environ.get("RERUN_WHO", "") or "unknown",
        "superseded_digest": os.environ.get("RERUN_SUP_DIGEST", ""),
        "superseded_entry": os.environ.get("RERUN_SUP_FILE", ""),
    }
tmp = os.environ["ENTRY"] + ".tmp." + str(os.getpid())
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(entry, f, indent=2, sort_keys=True)
    f.write("\n")
    f.flush()
    os.fsync(f.fileno())
os.replace(tmp, os.environ["ENTRY"])
print(entry["verdict"])
PYEOF
}
recorded_verdict=$(write_complete_verdict) || { rm -f "$log_entry"; cleanup_archive; echo "FULL-SUITE: RED: verdict evidence could not be recorded; nothing was cached" >&2; exit 1; }
case "$recorded_verdict" in
	PASS) verdict=PASS ;;
	FAIL) verdict=FAIL; [ "$code" -ne 0 ] || code=1 ;;
	*) cleanup_archive; fail "recorded verdict is invalid"; exit 1 ;;
esac
rm -f "$METRICS_ROWS" "$METRICS_DECLARED"
cleanup_archive
if [ "$verdict" = "PASS" ]; then
	set -- $covered_bun $covered_shell $covered_py; covered_count=$#
	echo "FULL-SUITE: VERDICT PASS tree=$tree role=$JUDGE_ROLE checks=$checks runtime=$runtime bun_ran=$bun_ran shell=$shell_count python=$py_count excluded_ci_only=$excluded_count covered_by_focused=$covered_count"
	exit 0
else
	echo "FULL-SUITE: VERDICT FAIL tree=$tree role=$JUDGE_ROLE checks=$checks runtime=$runtime producer_rc=$code bun_fail=$bun_fail shell_red=$shell_red py_red=$py_red; the push is refused" >&2
	printf 'FULL-SUITE: minimum-run assessment %s\n' "$minimum_run" >&2
	# Keep failing names beside the reused log for the pre-push gate.
	echo "FULL-SUITE: failing tests (full log: $log_entry):" >&2
	awk '/^[A-Za-z0-9_.\/-]+\.test\.ts:$/ { file = $0 } /^\(fail\)/ { print "  " file " " $0 }' "$log_entry" | head -n 40 >&2
	grep -E '^RED (script|python)-suite ' "$log_entry" | sed 's/^/  /' | head -n 20 >&2
	exit "$code"
fi
