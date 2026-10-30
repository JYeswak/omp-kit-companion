#!/bin/sh
# Every unquoted expansion in this file splits newline-separated archive-relative paths with no
# spaces.
# shellcheck disable=SC2086
# full-suite-verdict.sh -- require and cache the full-suite verdict for an exact candidate tree.
# (ompkit-rhy9.12)
#
# Usage:
#   scripts/full-suite-verdict.sh --repo ROOT --commit SHA [--archive-dir DIR] [--cache-dir DIR]
#     [--focused-passed FILE] [--rerun-reason TEXT]
#
# The complete declared repo suite runs against the exact-commit archive: every bun test under
# tests/cli and tests/fleet-guard, every shell suite tests/cli/*.test.sh, and every python suite
# tests/cli + tests/scripts (*_test.py, *.test.py). Focused selection, wall-budget deferral, SKIP
# and CI deferral never substitute: only a finished run with every enumerated suite green is PASS.
# Rows of scripts/gate-ci-only.tsv (read beside this script, like every gate script) name tests
# that cannot be hermetic on a dev Mac; they are excluded by declaration, printed, and recorded in
# the entry. A changed manifest changes the check identity below, so its verdicts never reuse.
#
# The verdict is cached by candidate tree hash with check/runtime identity bound to the entry:
#   tree    = git tree object of the exact candidate commit (exact source bytes)
#   checks  = sha256 of this script + scripts/fresh-gate.sh + scripts/gate-ci-only.tsv as executed
#   runtime = os/arch + bun version + python3 version (+ FULL_SUITE_RUNTIME_ID when pinned)
# A repeated identical tree under unchanged check/runtime identity reuses the recorded verdict
# without rerunning. A changed tree, changed check bytes or changed runtime never reuses.
# --rerun-reason TEXT reruns a cached FAIL for the same tree instead of reusing it: the old
# entry is kept beside the cache as <tree>.superseded-<utc>.{json,log}, the suite runs again,
# and the new entry records the reason, the actor (AGENT_NAME or USER) and the superseded
# entry's digest. An empty reason is refused. A cached PASS is never rerun by this flag.
# Missing, corrupt, timed-out or incomplete suite evidence is non-pass and is never cached GREEN:
# only a finished suite run (PASS or FAIL with complete counts) is recorded. Incomplete or
# timed-out runs record no verdict, so a retry reruns instead of reusing; their partial output is
# kept as <tree>.incomplete.log for diagnosis, a name the verdict lookup never reads.
#
# Cache: <repo-git-dir>/omp-kit/full-suite-verdicts/<tree>.json plus <tree>.log (the suite output),
# overridden by --cache-dir or FULL_SUITE_VERDICT_CACHE_DIR. The cache is local to the pushing
# checkout and never committed. Pruning entries only costs a rerun.
# Suite bound: FULL_SUITE_TIMEOUT_SECS (default 1800). The suite runs at nice 10 inside the gate's
# own admission; it takes no heavy slot.
# Shell suites: FULL_SUITE_SHELL_JOBS at a time (default 5, never more than the online cores or
# the suite count; FULLSUITEPAR1, ompkit-9t6f2). Each suite runs under its own owned TMPDIR with
# its output kept apart; outputs and GREEN/RED lines join the log in sorted suite order, so the log
# and the verdict do not depend on the worker count or on which suite finishes first. The default
# is measured: the 54 suites took 1415 s one after another (2026-10-29, load 13-21 on 32 cores),
# no worker count can beat the longest suite (404 s), and 5 is the fewest workers whose predicted
# stage, claimed in sorted order, is within 5% of that floor (4: 460 s, 5: 411 s, 8: 405 s).
set -eu
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd -P)
run_started_ms=$(python3 -c 'import time; print(time.time_ns() // 1000000)')
load_start=$(python3 -c 'import os,json; print(json.dumps(os.getloadavg()))')
ROOT=
COMMIT=
ARCHIVE_DIR=
CACHE_DIR=
RERUN_REASON=
RERUN=0
TIMEOUT_SECS=${FULL_SUITE_TIMEOUT_SECS:-1800}
SHELL_JOBS=${FULL_SUITE_SHELL_JOBS:-5}
RUNTIME_PIN=${FULL_SUITE_RUNTIME_ID:-}

FOCUSED_PASSED=
usage() {
	echo "usage: full-suite-verdict.sh --repo ROOT --commit SHA [--archive-dir DIR] [--cache-dir DIR] [--focused-passed FILE] [--rerun-reason TEXT]" >&2
}

fail() {
	echo "FULL-SUITE: RED: $*" >&2
	return 1
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--repo) [ "$#" -ge 2 ] || { usage; exit 2; }; ROOT=$2; shift 2 ;;
		--commit) [ "$#" -ge 2 ] || { usage; exit 2; }; COMMIT=$2; shift 2 ;;
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
case "$SHELL_JOBS" in ''|*[!0-9]*|0) fail "FULL_SUITE_SHELL_JOBS must be a positive integer" ; exit 1 ;; esac
# No suite may block on stdin (pre-push hooks inherit a pipe whose writer never closes).
exec </dev/null
# HERMETIC1: reject caller-supplied repository/tracker authority before probing Git or starting suites.
if [ "${GIT_DIR+x}" = x ]; then echo "FULL-SUITE: REFUSED caller GIT_DIR is set" >&2; exit 1; fi
if [ "${GIT_WORK_TREE+x}" = x ]; then echo "FULL-SUITE: REFUSED caller GIT_WORK_TREE is set" >&2; exit 1; fi
if [ "${BEADS_DB+x}" = x ]; then echo "FULL-SUITE: REFUSED caller BEADS_DB is set" >&2; exit 1; fi

command -v bun >/dev/null 2>&1 || { fail "bun is not on PATH; the full suite cannot run"; exit 1; }
command -v python3 >/dev/null 2>&1 || { fail "python3 is not on PATH; verdict evidence cannot be recorded"; exit 1; }

type=$(git -C "$ROOT" cat-file -t "$COMMIT" 2>/dev/null) || { fail "candidate $COMMIT is not a git object in $ROOT"; exit 1; }
[ "$type" = "commit" ] || { fail "candidate $COMMIT is a $type, not a commit"; exit 1; }
tree=$(git -C "$ROOT" rev-parse "$COMMIT^{tree}" 2>/dev/null) || { fail "candidate $COMMIT has no readable tree"; exit 1; }
case "$tree" in *[!0-9a-f]*|???????????????????????????????????????) fail "candidate tree hash is not hex: $tree"; exit 1 ;; esac
[ "${#tree}" -ge 40 ] || { fail "candidate tree hash is too short: $tree"; exit 1; }

# Check identity: the judging bytes as executed. A base archive's gate runs its own scripts
# against the candidate archive; a changed judge reruns every tree.
[ -f "$SCRIPT_DIR/full-suite-verdict.sh" ] || { fail "judging script is absent beside the gate"; exit 1; }
[ -f "$SCRIPT_DIR/fresh-gate.sh" ] || { fail "scripts/fresh-gate.sh is absent beside the gate"; exit 1; }
checks=$(python3 "$SCRIPT_DIR/suite-metrics.py" identity --root "$SCRIPT_DIR/.." --scope full) || {
	fail "the complete judging dependency identity is unreadable"; exit 1;
}

bun_v=$(bun --version 2>/dev/null) || { fail "bun --version failed"; exit 1; }
py_v=$(python3 --version 2>&1) || { fail "python3 --version failed"; exit 1; }
runtime="$(uname -s)/$(uname -m)/bun-$bun_v/$py_v"
[ -n "$RUNTIME_PIN" ] && runtime="$runtime/pin-$RUNTIME_PIN"

if [ -z "$CACHE_DIR" ]; then
	CACHE_DIR=${FULL_SUITE_VERDICT_CACHE_DIR:-}
fi
if [ -z "$CACHE_DIR" ]; then
	git_dir=$(git -C "$ROOT" rev-parse --absolute-git-dir 2>/dev/null) || { fail "candidate repo has no git dir for the verdict cache"; exit 1; }
	CACHE_DIR="$git_dir/omp-kit/full-suite-verdicts"
fi
mkdir -p "$CACHE_DIR" || { fail "verdict cache dir is not writable: $CACHE_DIR"; exit 1; }
entry="$CACHE_DIR/$tree.json"
log_entry="$CACHE_DIR/$tree.log"

# A recorded verdict is reused only on an exact identity match with complete evidence. The
# comparison is exact-string on tree, checks and runtime; verdict must be PASS or FAIL.
if [ -f "$entry" ] && [ "$(wc -c <"$entry" 2>/dev/null | tr -d ' ')" -le 1048576 ]; then
	cached=$(METRICS="$SCRIPT_DIR/suite-metrics.py" TREE=$tree CHECKS=$checks RUNTIME=$runtime ENTRY=$entry LOG=$log_entry python3 - <<'PYEOF' 2>/dev/null
import hashlib, json, os
try:
    with open(os.environ["ENTRY"], encoding="utf-8") as f:
        e = json.load(f)
    assert e.get("version") == 2
    assert e.get("tree") == os.environ["TREE"]
    assert e.get("checks") == os.environ["CHECKS"]
    assert e.get("runtime") == os.environ["RUNTIME"]
    assert e.get("verdict") in ("PASS", "FAIL")
    evidence = e.get("evidence")
    assert isinstance(evidence, dict) and evidence.get("complete") is True
    import importlib.util
    spec = importlib.util.spec_from_file_location("suite_metrics", os.environ["METRICS"])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.complete_records(evidence.get("files"), evidence.get("declared_files", []))
    digest = hashlib.sha256()
    with open(os.environ["LOG"], "rb") as log:
        for chunk in iter(lambda: log.read(1024 * 1024), b""):
            digest.update(chunk)
    assert evidence.get("log_sha256") == digest.hexdigest()
    assert isinstance(e.get("exit_code"), int)
    count_names = ("bun_files", "bun_ran", "bun_fail", "shell_suites", "shell_fail", "py_suites", "py_fail")
    counts = [evidence.get(name) for name in count_names]
    assert all(isinstance(value, int) and value >= 0 for value in counts)
    bun_files, bun_ran, bun_fail, shell_suites, shell_fail, py_suites, py_fail = counts
    coverage = evidence.get("covered_by_focused", {})
    covered_count = sum(len(coverage.get(kind, [])) for kind in ("bun", "shell", "py"))
    assert len(evidence["files"]) == bun_files + shell_suites + py_suites + covered_count
    assert all(row["closure"]["tree"] == e["tree"] for row in evidence["files"])
    assert len(evidence["files"]) > 0
    assert (bun_files == 0 and bun_ran == 0) or (bun_files > 0 and bun_ran > 0)
    assert bun_fail <= bun_ran and shell_fail <= shell_suites and py_fail <= py_suites
    if e["verdict"] == "PASS":
        assert e["exit_code"] == 0 and bun_fail == shell_fail == py_fail == 0
        assert all(row["rc"] == 0 for row in evidence["files"])
    else:
        assert e["exit_code"] != 0 and (bun_fail > 0 or shell_fail > 0 or py_fail > 0)
    print("%s %s" % (e["verdict"], e["exit_code"]))
except Exception:
    print("MISS")
PYEOF
) || cached="MISS"
	case "$cached" in
		MISS) echo "FULL-SUITE: cache miss for tree $tree (no reusable verdict); running the complete suite" ;;
		PASS*)
			echo "FULL-SUITE: VERDICT REUSED PASS tree=$tree checks=$checks runtime=$runtime"
			exit 0 ;;
		FAIL*)
			if [ "$RERUN" = 1 ]; then
				# A recorded rerun: the cached FAIL is not reused. The old entry is kept
				# beside the cache as <tree>.superseded-<utc>.{json,log}; the suite runs
				# again below and the new entry records the reason, the actor and the
				# superseded entry's digest. A cached PASS is never rerun by this flag.
				superseded_digest=$(shasum -a 256 "$entry" | cut -d' ' -f1) || { fail "cached verdict is unreadable; the cached FAIL is kept and nothing reruns"; exit 1; }
				[ -n "$superseded_digest" ] || { fail "cached verdict is unreadable; the cached FAIL is kept and nothing reruns"; exit 1; }
				superseded_stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ) || { fail "the clock is unreadable; the cached FAIL is kept and nothing reruns"; exit 1; }
				SUPERSEDED_BASE="$CACHE_DIR/$tree.superseded-$superseded_stamp"
				cp "$entry" "$SUPERSEDED_BASE.json" || { fail "cannot keep the superseded verdict; the cached FAIL is kept and nothing reruns"; exit 1; }
				cp "$log_entry" "$SUPERSEDED_BASE.log" || { rm -f "$SUPERSEDED_BASE.json"; fail "cannot keep the superseded log; the cached FAIL is kept and nothing reruns"; exit 1; }
				RERUN_ACTOR=${AGENT_NAME:-${USER:-unknown}}
				[ -n "$RERUN_ACTOR" ] || RERUN_ACTOR=unknown
				export SUPERSEDED_DIGEST="$superseded_digest" SUPERSEDED_FILE="$SUPERSEDED_BASE.json"
				echo "FULL-SUITE: RERUN reason='$RERUN_REASON' actor='$RERUN_ACTOR' superseded=$SUPERSEDED_BASE.json; running the complete suite again"
			else
				code=$(printf '%s' "$cached" | cut -d' ' -f2)
				case "$code" in ''|*[!0-9]*|0) code=1 ;; esac
				[ "$code" -gt 125 ] && code=1
				echo "FULL-SUITE: VERDICT REUSED FAIL tree=$tree checks=$checks runtime=$runtime producer_rc=$code; the push is refused without rerun" >&2
				exit "$code"
			fi ;;
		*) echo "FULL-SUITE: cache miss for tree $tree (unreadable verdict); running the complete suite" ;;
	esac
else
	echo "FULL-SUITE: cache miss for tree $tree; running the complete suite"
fi

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

# FULLSUITEPAR1: never more shell workers than online cores or shell suites left to run.
ncpu=$(getconf _NPROCESSORS_ONLN 2>/dev/null) || ncpu=
case "$ncpu" in ''|*[!0-9]*|0) ncpu=1 ;; esac
[ "$SHELL_JOBS" -le "$ncpu" ] || SHELL_JOBS=$ncpu
if [ "$shell_count" -gt 0 ]; then
	[ "$SHELL_JOBS" -le "$shell_count" ] || SHELL_JOBS=$shell_count
	echo "full-suite: shell suites run $SHELL_JOBS at a time (FULL_SUITE_SHELL_JOBS; $ncpu online cores)"
fi

SUITE_OUT="$CACHE_DIR/$tree.running.log"
# The runner's own facts, written only by run_suite (never by a suite): one line per shell and
# python suite plus the bun phase's exit code. Bun's output is kept apart so its summary is
# parsed from the bun phase alone. Nested gate runs inside tests print the same marker lines
# into the shared log; they must not count (FULLSUITECOUNT1, ompkit-lrbd.7).
SUITE_STATUS="$SUITE_OUT.status"
BUN_OUT="$SUITE_OUT.bun"
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
rm -f "$SUITE_STATUS" "$BUN_OUT" "$RUNNER_PID" "$timeout_mark"
rm -rf "$SHELL_DIR"
if ! : >"$SUITE_OUT" || ! : >"$SUITE_STATUS" || ! mkdir "$SHELL_DIR"; then cleanup_archive; fail "cannot write suite evidence"; exit 1; fi
# finish_logs DEST: move the log to DEST and drop the runner-private side files. A bun phase that
# never finished (timeout, killed runner) has its partial output only in $BUN_OUT; append it first
# so the kept log still shows how far bun got (lrbd.6 AC1). Shell suite outputs the runner never
# merged (it was killed in the shell stage) follow in sorted suite order, each naming its suite.
finish_logs() {
	if [ -f "$BUN_OUT" ] && ! grep -q '^BUN rc=' "$SUITE_STATUS" 2>/dev/null; then
		{ echo "full-suite: the bun phase did not finish; its partial output follows"; cat "$BUN_OUT"; } >>"$SUITE_OUT"
	fi
	if ! grep -q '^BUN rc=' "$SUITE_STATUS" 2>/dev/null; then
		for fl_output in "$METRICS_DIR"/bun-*.log; do
			case "$fl_output" in *.native.log) continue ;; esac
			[ -f "$fl_output" ] || continue
			{ echo "full-suite: unfinished Bun worker output follows"; cat "$fl_output"; } >>"$SUITE_OUT"
		done
	fi
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
	rm -f "$SUITE_STATUS" "$BUN_OUT" "$RUNNER_PID"
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
		export OMP_KIT_CASE_CWD="$ROOT"
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
		if [ "$bun_count" -gt 0 ]; then
			bun_rc=0
			bun_workers=$(sh "$SCRIPT_DIR/fresh-gate.sh" --test-workers) || exit 1
			case "$bun_workers" in ''|*[!0-9]*|0) exit 1 ;; esac
			[ "$bun_workers" -le "$bun_count" ] || bun_workers=$bun_count
			[ "$bun_workers" -le 4 ] || bun_workers=4
			bun_stage="$METRICS_DIR/bun.stage"
			bun_config_path=${bun_config#--config=}
			[ -n "$bun_config_path" ] || bun_config_path=/dev/null
			dfl nice -n 10 python3 "$SCRIPT_DIR/suite-metrics.py" stage \
				--runner bun --records "$METRICS_DIR" --cwd "$ARCHIVE_DIR" --tree "$tree" \
				--summary "$bun_stage" --bun-config "$bun_config_path" \
				--workers "$bun_workers" --deadline "$TIMEOUT_SECS" $kept_bun \
				>"$BUN_OUT" 2>&1 || bun_rc=$?
			[ -f "$bun_stage" ] || exit 2
			b_counts=$(python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); print(v["test_count"],v["test_failures"])' "$bun_stage") || exit 2
			# Values come from the runner-owned numeric summary, never child log markers.
			# shellcheck disable=SC2086
			set -- $b_counts
			b_tests=$1; b_failed=$2
			cat "$BUN_OUT"
			echo "BUN rc=$bun_rc" >>"$SUITE_STATUS"
			echo "BUN_RAN $b_tests" >>"$SUITE_STATUS"
			echo "BUN_FAIL $b_failed" >>"$SUITE_STATUS"
			[ "$bun_rc" -eq 0 ] || failed=1
		fi
		# FULLSUITEPAR1 (ompkit-9t6f2): SHELL_JOBS workers share the shell suites. A worker claims the
		# next unclaimed suite in sorted order (mkdir is atomic), runs it under that suite's own owned
		# TMPDIR with its output kept apart, records its exit code, and claims nothing once the
		# deadline has marked the run. Workers are children of this subshell, so the watchdog's
		# kill_tree reaches every running suite. When all workers are done, each suite's output and its
		# GREEN/RED line join the log in sorted order, as the serial loop wrote them.
		if [ "$shell_count" -gt 0 ]; then
			if [ -e "$timeout_mark" ]; then exit 2; fi
			shell_t0=$(date +%s)
			i=0
			for suite in $kept_shell; do
				i=$((i + 1))
				kitlib_tmp suite_tmp full-suite-shell || exit 1
				eval "suite_tmp_$i=\$suite_tmp"
			done
			shell_worker() {
				w_i=0
				for w_suite in $kept_shell; do
					w_i=$((w_i + 1))
					if [ -e "$timeout_mark" ]; then return 0; fi
					if mkdir "$SHELL_DIR/$w_i.claim" 2>/dev/null; then
						eval "TMPDIR=\$suite_tmp_$w_i"
						export TMPDIR
						w_rc=0
						dfl python3 "$SCRIPT_DIR/suite-metrics.py" run \
							--record "$METRICS_DIR/shell-$w_i.json" --path "$w_suite" --runner sh \
							--tree "$tree" --cwd "$ARCHIVE_DIR" --workers "$SHELL_JOBS" --deadline "$TIMEOUT_SECS" -- sh "$w_suite" \
							>"$SHELL_DIR/$w_i.out" 2>&1 || w_rc=$?
						echo "$w_rc" >"$SHELL_DIR/$w_i.rc"
					fi
				done
			}
			workers=""
			w=0
			while [ "$w" -lt "$SHELL_JOBS" ]; do
				w=$((w + 1))
				shell_worker &
				workers="$workers $!"
			done
			lost=0
			for worker in $workers; do
				wait "$worker" || lost=1
			done
			# A recorded suite drops its files as it is merged, so a runner killed mid-merge never makes
			# finish_logs repeat it. An unrecorded suite keeps its claim for shell_unfinished.
			i=0
			for suite in $kept_shell; do
				i=$((i + 1))
				src=$(cat "$SHELL_DIR/$i.rc" 2>/dev/null) || src=
				case "$src" in
					''|*[!0-9]*)
						lost=1
						if [ -f "$SHELL_DIR/$i.out" ]; then
							echo "full-suite: script-suite $suite did not finish; its partial output follows"
							cat "$SHELL_DIR/$i.out"
						fi
						rm -f "$SHELL_DIR/$i.out" "$SHELL_DIR/$i.rc" ;;
					*)
						cat "$SHELL_DIR/$i.out"
						if [ "$src" -eq 0 ]; then
							echo "GREEN script-suite $suite"; echo "GREEN script-suite $suite" >>"$SUITE_STATUS"
						else
							echo "RED script-suite $suite rc=$src"; echo "RED script-suite $suite" >>"$SUITE_STATUS"; failed=1
						fi
						rm -f "$SHELL_DIR/$i.out" "$SHELL_DIR/$i.rc"
						rmdir "$SHELL_DIR/$i.claim" ;;
				esac
			done
			echo "full-suite: shell stage: $shell_count suites, $SHELL_JOBS at a time, $(($(date +%s) - shell_t0))s"
			# Suites without an exit code (a worker died, or the deadline passed) leave the run
			# incomplete: exit outside 0|1 so the verdict process refuses it.
			if [ "$lost" -ne 0 ]; then exit 2; fi
			rm -rf "$SHELL_DIR"
		fi
		p_i=0
		for suite in $kept_py; do
			p_i=$((p_i + 1))
			if dfl python3 "$SCRIPT_DIR/suite-metrics.py" run \
				--record "$METRICS_DIR/python-$p_i.json" --path "$suite" --runner python3 \
				--tree "$tree" --cwd "$ARCHIVE_DIR" --deadline "$TIMEOUT_SECS" -- python3 "$suite"; then
				echo "GREEN python-suite $suite"; echo "GREEN python-suite $suite" >>"$SUITE_STATUS"
			else
				src=$?; echo "RED python-suite $suite rc=$src"; echo "RED python-suite $suite" >>"$SUITE_STATUS"; failed=1
			fi
		done
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
	finish_logs "$CACHE_DIR/$tree.incomplete.log"
	cleanup_archive
	fail "full suite timed out after ${TIMEOUT_SECS}s${unfinished:+; unfinished script suites:$unfinished}; incomplete evidence is non-pass and nothing was cached; partial log: $CACHE_DIR/$tree.incomplete.log"
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
	finish_logs "$CACHE_DIR/$tree.incomplete.log"
	cleanup_archive
	fail "full suite ended without complete evidence (rc=$suite_rc bun_ran=$bun_ran shell=$shell_green/$shell_count python=$py_green/$py_count)${unfinished:+; unfinished script suites:$unfinished}; incomplete evidence is non-pass and nothing was cached; partial log: $CACHE_DIR/$tree.incomplete.log"
	exit 1
fi

# A complete textual run is not reusable without the complete measured file set.
# Keep the same declared suites and the same wall bound; missing rows fail cold.
set --
[ -z "$focused_metrics" ] || set -- --covered "$focused_metrics"
if ! python3 "$SCRIPT_DIR/suite-metrics.py" collect \
	--records "$METRICS_DIR" --declared "$METRICS_DECLARED" --output "$METRICS_ROWS" \
	--csv "$CACHE_DIR/$tree.timings.csv" --cwd "$ARCHIVE_DIR" --tables-dir "$CACHE_DIR/timings" "$@"; then
	finish_logs "$CACHE_DIR/$tree.incomplete.log"
	cleanup_archive
	fail "per-file timing evidence is incomplete; nothing was cached; partial log: $CACHE_DIR/$tree.incomplete.log"
	exit 1
fi
run_finished_ms=$(python3 -c 'import time; print(time.time_ns() // 1000000)')
load_end=$(python3 -c 'import os,json; print(json.dumps(os.getloadavg()))')

if [ "$suite_rc" -eq 0 ] && [ "${bun_status_rc:-0}" = 0 ] && [ "$bun_fail" -eq 0 ] && [ "$shell_red" -eq 0 ] && [ "$py_red" -eq 0 ]; then
	verdict=PASS
	code=0
else
	verdict=FAIL
	code=$suite_rc
	[ "$code" -ne 0 ] || code=1
fi

# Record the finished verdict atomically beside its evidence log. Only complete runs land here.
finish_logs "$CACHE_DIR/$tree.log"
METRICS_ROWS="$METRICS_ROWS" METRICS_DECLARED="$METRICS_DECLARED" RUN_START="$run_started_ms" RUN_END="$run_finished_ms" LOAD_START="$load_start" LOAD_END="$load_end" WORKERS_SHELL="$SHELL_JOBS" WORKERS_BUN="$(sh "$SCRIPT_DIR/fresh-gate.sh" --test-workers)" RERUN_FLAG=$RERUN RERUN_WHY="$RERUN_REASON" RERUN_WHO=${RERUN_ACTOR:-} RERUN_SUP_DIGEST=${SUPERSEDED_DIGEST:-} RERUN_SUP_FILE=${SUPERSEDED_FILE:-} TREE=$tree CHECKS=$checks RUNTIME=$runtime VERDICT=$verdict CODE=$code BUNF=$bun_count BUNRAN=$bun_ran BUNFAIL=$bun_fail SHC=$shell_count SHR=$shell_red PYC=$py_count PYR=$py_red EXCL="$excluded" COVB="$covered_bun" COVS="$covered_shell" COVP="$covered_py" COVI="$covered_ignored" FJOIN="$focused_join" ENTRY=$entry LOG="$CACHE_DIR/$tree.log" python3 - <<'PYEOF' || { rm -f "$CACHE_DIR/$tree.log"; cleanup_archive; echo "FULL-SUITE: RED: verdict evidence could not be recorded; nothing was cached" >&2; exit 1; }
import hashlib, json, os
log_digest = hashlib.sha256()
with open(os.environ["LOG"], "rb") as log:
    for chunk in iter(lambda: log.read(1024 * 1024), b""):
        log_digest.update(chunk)
from datetime import datetime, timezone
with open(os.environ["METRICS_ROWS"]) as handle:
    files = json.load(handle)
with open(os.environ["METRICS_DECLARED"]) as handle:
    declared_files = handle.read().splitlines()
stages = {}
for runner in ("bun", "sh", "python3"):
    selected = [row for row in files if row["runner"] == runner and row.get("origin") != "focused"]
    stages[runner] = {
        "wall_ms": max(row["finished_ms"] for row in selected) - min(row["started_ms"] for row in selected) if selected else 0,
        "cpu_user_ms": sum(row["cpu_user_ms"] for row in selected),
        "cpu_system_ms": sum(row["cpu_system_ms"] for row in selected),
    }
entry = {
    "version": 2,
    "tree": os.environ["TREE"],
    "checks": os.environ["CHECKS"],
    "runtime": os.environ["RUNTIME"],
    "verdict": os.environ["VERDICT"],
    "exit_code": int(os.environ["CODE"]),
    "judge": {"checks_sha256": os.environ["CHECKS"], "runtime": os.environ["RUNTIME"]},
    "timing": {
        "wall_ms": int(os.environ["RUN_END"]) - int(os.environ["RUN_START"]),
        "started_ms": int(os.environ["RUN_START"]),
        "load_start": json.loads(os.environ["LOAD_START"]),
        "load_end": json.loads(os.environ["LOAD_END"]),
        "workers": {"bun": min(4, int(os.environ["WORKERS_BUN"]), int(os.environ["BUNF"])),
                    "shell": min(int(os.environ["WORKERS_SHELL"]), int(os.environ["SHC"])), "python": min(1, int(os.environ["PYC"]))},
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
# FSRERUN1 (ompkit-t7cn7.4): a rerun of a cached FAIL records why, who and what it superseded.
# A run without --rerun-reason records no rerun block, so the lookup above still matches.
if os.environ.get("RERUN_FLAG") == "1":
    entry["rerun"] = {
        "reason": os.environ.get("RERUN_WHY", ""),
        "actor": os.environ.get("RERUN_WHO", "") or "unknown",
        "superseded_digest": os.environ.get("RERUN_SUP_DIGEST", ""),
        "superseded_entry": os.environ.get("RERUN_SUP_FILE", ""),
    }
tmp = os.environ["ENTRY"] + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(entry, f, indent=2, sort_keys=True)
    f.write("\n")
os.replace(tmp, os.environ["ENTRY"])
PYEOF
rm -f "$METRICS_ROWS" "$METRICS_DECLARED"
cleanup_archive
if [ "$verdict" = "PASS" ]; then
	set -- $covered_bun $covered_shell $covered_py; covered_count=$#
	echo "FULL-SUITE: VERDICT PASS tree=$tree checks=$checks runtime=$runtime bun_ran=$bun_ran shell=$shell_count python=$py_count excluded_ci_only=$excluded_count covered_by_focused=$covered_count"
	exit 0
else
	echo "FULL-SUITE: VERDICT FAIL tree=$tree checks=$checks runtime=$runtime producer_rc=$code bun_fail=$bun_fail shell_red=$shell_red py_red=$py_red; the push is refused" >&2
	# The failing names belong in the gate log, not only in the tree log (CI-SPEED, PeachLeopard 69007:
	# three VERDICT FAILs tonight had to be diagnosed by hand from the cached log). Bun prints
	# "(fail) <name> [ms]" under its file header; shell/python suites print RED lines in the log.
	echo "FULL-SUITE: failing tests (full log: $CACHE_DIR/$tree.log):" >&2
	awk '/^[A-Za-z0-9_.\/-]+\.test\.ts:$/ { file = $0 } /^\(fail\)/ { print "  " file " " $0 }' "$CACHE_DIR/$tree.log" | head -n 40 >&2
	grep -E '^RED (script|python)-suite ' "$CACHE_DIR/$tree.log" | sed 's/^/  /' | head -n 20 >&2
	exit "$code"
fi
