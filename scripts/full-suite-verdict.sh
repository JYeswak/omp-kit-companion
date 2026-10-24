#!/bin/sh
# Every unquoted expansion in this file splits newline-separated archive-relative paths with no
# spaces.
# shellcheck disable=SC2086
# full-suite-verdict.sh -- require and cache the full-suite verdict for an exact candidate tree.
# (ompkit-rhy9.12)
#
# Usage:
#   scripts/full-suite-verdict.sh --repo ROOT --commit SHA [--archive-dir DIR] [--cache-dir DIR]
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
set -eu
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd -P)
ROOT=
COMMIT=
ARCHIVE_DIR=
CACHE_DIR=
TIMEOUT_SECS=${FULL_SUITE_TIMEOUT_SECS:-1800}
RUNTIME_PIN=${FULL_SUITE_RUNTIME_ID:-}

usage() {
	echo "usage: full-suite-verdict.sh --repo ROOT --commit SHA [--archive-dir DIR] [--cache-dir DIR]" >&2
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
		-h|--help) usage; exit 0 ;;
		*) usage; exit 2 ;;
	esac
done
if [ -z "$ROOT" ] || [ -z "$COMMIT" ]; then
	usage
	exit 2
fi
case "$TIMEOUT_SECS" in ''|*[!0-9]*|0) fail "FULL_SUITE_TIMEOUT_SECS must be a positive integer" ; exit 1 ;; esac
# No suite may block on stdin (pre-push hooks inherit a pipe whose writer never closes).
exec </dev/null

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
checks_src="$SCRIPT_DIR/full-suite-verdict.sh
$SCRIPT_DIR/fresh-gate.sh"
if [ -z "$ARCHIVE_DIR" ]; then
	[ -f "$SCRIPT_DIR/kitlib-tmp.sh" ] || { fail "scripts/kitlib-tmp.sh is absent beside the gate"; exit 1; }
	checks_src="$checks_src
$SCRIPT_DIR/kitlib-tmp.sh"
fi
[ -f "$SCRIPT_DIR/gate-ci-only.tsv" ] && checks_src="$checks_src
$SCRIPT_DIR/gate-ci-only.tsv"
checks=$(cat $checks_src 2>/dev/null | shasum -a 256 | cut -d' ' -f1) || { fail "judging scripts are unreadable"; exit 1; }
[ -n "$checks" ] || { fail "judging scripts are unreadable"; exit 1; }

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
	cached=$(TREE=$tree CHECKS=$checks RUNTIME=$runtime ENTRY=$entry LOG=$log_entry python3 - <<'PYEOF' 2>/dev/null
import hashlib, json, os
try:
    with open(os.environ["ENTRY"], encoding="utf-8") as f:
        e = json.load(f)
    assert e.get("version") == 1
    assert e.get("tree") == os.environ["TREE"]
    assert e.get("checks") == os.environ["CHECKS"]
    assert e.get("runtime") == os.environ["RUNTIME"]
    assert e.get("verdict") in ("PASS", "FAIL")
    evidence = e.get("evidence")
    assert isinstance(evidence, dict) and evidence.get("complete") is True
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
    assert bun_files + shell_suites + py_suites > 0
    assert (bun_files == 0 and bun_ran == 0) or (bun_files > 0 and bun_ran > 0)
    assert bun_fail <= bun_ran and shell_fail <= shell_suites and py_fail <= py_suites
    if e["verdict"] == "PASS":
        assert e["exit_code"] == 0 and bun_fail == shell_fail == py_fail == 0
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
			code=$(printf '%s' "$cached" | cut -d' ' -f2)
			case "$code" in ''|*[!0-9]*|0) code=1 ;; esac
			[ "$code" -gt 125 ] && code=1
			echo "FULL-SUITE: VERDICT REUSED FAIL tree=$tree checks=$checks runtime=$runtime producer_rc=$code; the push is refused without rerun" >&2
			exit "$code" ;;
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
if [ "$bun_count" -eq 0 ] && [ "$shell_count" -eq 0 ] && [ "$py_count" -eq 0 ]; then
	cleanup_archive
	fail "candidate archive enumerates no runnable suite"
	exit 1
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

SUITE_OUT="$CACHE_DIR/$tree.running.log"
# The runner's own facts, written only by run_suite (never by a suite): one line per shell and
# python suite plus the bun phase's exit code. Bun's output is kept apart so its summary is
# parsed from the bun phase alone. Nested gate runs inside tests print the same marker lines
# into the shared log; they must not count (FULLSUITECOUNT1, ompkit-lrbd.7).
SUITE_STATUS="$SUITE_OUT.status"
BUN_OUT="$SUITE_OUT.bun"
rm -f "$SUITE_STATUS" "$BUN_OUT"
if ! : >"$SUITE_OUT" || ! : >"$SUITE_STATUS"; then cleanup_archive; fail "cannot write suite evidence"; exit 1; fi
# finish_logs DEST: move the log to DEST and drop the runner-private side files. A bun phase that
# never finished (timeout, killed runner) has its partial output only in $BUN_OUT; append it first
# so the kept log still shows how far bun got (lrbd.6 AC1).
finish_logs() {
	if [ -f "$BUN_OUT" ] && ! grep -q '^BUN rc=' "$SUITE_STATUS" 2>/dev/null; then
		{ echo "full-suite: the bun phase did not finish; its partial output follows"; cat "$BUN_OUT"; } >>"$SUITE_OUT"
	fi
	mv -f "$SUITE_OUT" "$1"
	rm -f "$SUITE_STATUS" "$BUN_OUT"
}

# One deadline for the whole suite: every phase runs to completion and appends to the evidence
# log, so a failing suite yields a complete FAIL record (cached RED) instead of an incomplete run.
# Timeout kills the suite's process tree, refuses, and records nothing, so a retry reruns.
run_suite() {
	(
		cd "$ARCHIVE_DIR"
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
		failed=0
		if [ "$bun_count" -gt 0 ]; then
			bun_rc=0
			if [ -n "$bun_config" ]; then
				nice -n 10 bun "$bun_config" test --timeout=120000 --path-ignore-patterns 'var/agent-tmp/**' $kept_bun >"$BUN_OUT" 2>&1 || bun_rc=$?
			else
				nice -n 10 bun test --timeout=120000 --path-ignore-patterns 'var/agent-tmp/**' $kept_bun >"$BUN_OUT" 2>&1 || bun_rc=$?
			fi
			cat "$BUN_OUT"
			echo "BUN rc=$bun_rc" >>"$SUITE_STATUS"
			[ "$bun_rc" -eq 0 ] || failed=1
		fi
		for suite in $kept_shell; do
			if sh "$suite"; then
				echo "GREEN script-suite $suite"; echo "GREEN script-suite $suite" >>"$SUITE_STATUS"
			else
				src=$?; echo "RED script-suite $suite rc=$src"; echo "RED script-suite $suite" >>"$SUITE_STATUS"; failed=1
			fi
		done
		for suite in $kept_py; do
			if python3 "$suite"; then
				echo "GREEN python-suite $suite"; echo "GREEN python-suite $suite" >>"$SUITE_STATUS"
			else
				src=$?; echo "RED python-suite $suite rc=$src"; echo "RED python-suite $suite" >>"$SUITE_STATUS"; failed=1
			fi
		done
		exit "$failed"
	) >>"$SUITE_OUT" 2>&1
}

# kill_tree PID SIG: post-order signal to the suite process tree. A plain kill of the subshell
# leaves its bun grandchildren running; this walks parent links instead (same ps snapshot shape
# as the gate's stop_descendants). Reparented strays are out of reach, like in the gate.
kill_tree() {
	root=$1; sig=$2
	children=$(ps -A -o pid= -o ppid= 2>/dev/null | awk -v r="$root" '$2 == r { print $1 }')
	for child in $children; do kill_tree "$child" "$sig"; done
	kill "-$sig" "$root" 2>/dev/null || true
}

timed_out=0
suite_rc=0
run_suite &
suite_pid=$!
waited=0
while kill -0 "$suite_pid" 2>/dev/null; do
	if [ "$waited" -ge "$TIMEOUT_SECS" ]; then
		kill_tree "$suite_pid" TERM
		sleep 5
		kill_tree "$suite_pid" KILL
		wait "$suite_pid" 2>/dev/null || true
		timed_out=1
		break
	fi
	sleep 5
	waited=$((waited + 5))
done
if [ "$timed_out" = 0 ]; then
	wait "$suite_pid" 2>/dev/null || suite_rc=$?
fi
if [ "$timed_out" = 1 ]; then
	finish_logs "$CACHE_DIR/$tree.incomplete.log"
	cleanup_archive
	fail "full suite timed out after ${TIMEOUT_SECS}s; incomplete evidence is non-pass and nothing was cached; partial log: $CACHE_DIR/$tree.incomplete.log"
	exit 1
fi

# Completeness comes from the runner's own status file and the bun phase's own output, never from
# marker lines in the shared log (tests that run nested gates print those too). Bun prints its own
# final summary last, so the last match within the bun-only output is the real one. A suite process
# that died without accounting for every enumerated suite is incomplete evidence: refuse, cache nothing.
bun_ran=""; bun_fail=""
if [ -f "$BUN_OUT" ]; then
	bun_ran=$(awk '$1 == "Ran" && ($3 == "test" || $3 == "tests") && $4 == "across" { print $2 }' "$BUN_OUT" | tail -n 1)
	bun_fail=$(awk 'NF == 2 && $2 == "fail" { print $1 }' "$BUN_OUT" | tail -n 1)
fi
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
	finish_logs "$CACHE_DIR/$tree.incomplete.log"
	cleanup_archive
	fail "full suite ended without complete evidence (rc=$suite_rc bun_ran=$bun_ran shell=$shell_green/$shell_count python=$py_green/$py_count); incomplete evidence is non-pass and nothing was cached; partial log: $CACHE_DIR/$tree.incomplete.log"
	exit 1
fi

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
TREE=$tree CHECKS=$checks RUNTIME=$runtime VERDICT=$verdict CODE=$code BUNF=$bun_count BUNRAN=$bun_ran BUNFAIL=$bun_fail SHC=$shell_count SHR=$shell_red PYC=$py_count PYR=$py_red EXCL="$excluded" ENTRY=$entry LOG="$CACHE_DIR/$tree.log" python3 - <<'PYEOF' || { rm -f "$CACHE_DIR/$tree.log"; cleanup_archive; echo "FULL-SUITE: RED: verdict evidence could not be recorded; nothing was cached" >&2; exit 1; }
import hashlib, json, os
log_digest = hashlib.sha256()
with open(os.environ["LOG"], "rb") as log:
    for chunk in iter(lambda: log.read(1024 * 1024), b""):
        log_digest.update(chunk)
from datetime import datetime, timezone
entry = {
    "version": 1,
    "tree": os.environ["TREE"],
    "checks": os.environ["CHECKS"],
    "runtime": os.environ["RUNTIME"],
    "verdict": os.environ["VERDICT"],
    "exit_code": int(os.environ["CODE"]),
    "evidence": {
        "log_sha256": log_digest.hexdigest(),
        "complete": True,
        "bun_files": int(os.environ["BUNF"]),
        "bun_ran": int(os.environ["BUNRAN"]),
        "bun_fail": int(os.environ["BUNFAIL"]),
        "shell_suites": int(os.environ["SHC"]),
        "shell_fail": int(os.environ["SHR"]),
        "py_suites": int(os.environ["PYC"]),
        "py_fail": int(os.environ["PYR"]),
        "excluded_ci_only": os.environ["EXCL"].split(),
    },
    "recorded_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
tmp = os.environ["ENTRY"] + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(entry, f, indent=2, sort_keys=True)
    f.write("\n")
os.replace(tmp, os.environ["ENTRY"])
PYEOF
cleanup_archive
if [ "$verdict" = "PASS" ]; then
	echo "FULL-SUITE: VERDICT PASS tree=$tree checks=$checks runtime=$runtime bun_ran=$bun_ran shell=$shell_count python=$py_count excluded_ci_only=$excluded_count"
	exit 0
else
	echo "FULL-SUITE: VERDICT FAIL tree=$tree checks=$checks runtime=$runtime producer_rc=$code bun_fail=$bun_fail shell_red=$shell_red py_red=$py_red; the push is refused" >&2
	exit "$code"
fi
