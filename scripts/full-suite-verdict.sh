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
# only a finished suite run (PASS or FAIL with complete counts) is recorded. Incomplete runs
# refuse without writing, so a retry reruns instead of reusing.
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
[ -n "$ROOT" ] && [ -n "$COMMIT" ] || { usage; exit 2; }
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

# A recorded verdict is reused only on an exact identity match with complete evidence. The
# comparison is exact-string on tree, checks and runtime; verdict must be PASS or FAIL.
if [ -f "$entry" ] && [ "$(wc -c <"$entry" 2>/dev/null | tr -d ' ')" -le 1048576 ]; then
	cached=$(TREE=$tree CHECKS=$checks RUNTIME=$runtime ENTRY=$entry python3 - <<'PYEOF' 2>/dev/null
import json, os
try:
    with open(os.environ["ENTRY"], encoding="utf-8") as f:
        e = json.load(f)
    assert e.get("version") == 1
    assert e.get("tree") == os.environ["TREE"]
    assert e.get("checks") == os.environ["CHECKS"]
    assert e.get("runtime") == os.environ["RUNTIME"]
    assert e.get("verdict") in ("PASS", "FAIL")
    assert isinstance(e.get("evidence"), dict) and e["evidence"].get("complete") is True
    assert isinstance(e.get("exit_code"), int)
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
	ARCHIVE_DIR=$(mktemp -d "$WORK_PARENT/full-suite-verdict.XXXXXX") || { fail "cannot stage the candidate archive"; exit 1; }
	OWN_ARCHIVE=1
	git -C "$ROOT" archive "$COMMIT" | tar -xf - -C "$ARCHIVE_DIR" || { rm -rf "$ARCHIVE_DIR"; fail "cannot export candidate $COMMIT"; exit 1; }
fi
[ -d "$ARCHIVE_DIR/tests" ] || { [ "$OWN_ARCHIVE" = 1 ] && rm -rf "$ARCHIVE_DIR"; fail "candidate archive has no tests/ tree"; exit 1; }
cleanup_archive() {
	[ "$OWN_ARCHIVE" = 1 ] && rm -rf "$ARCHIVE_DIR" 2>/dev/null
	return 0
}

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
: >"$SUITE_OUT" || { cleanup_archive; fail "cannot write suite evidence"; exit 1; }

# One deadline for the whole suite: every phase runs to completion and appends to the evidence
# log, so a failing suite yields a complete FAIL record (cached RED) instead of an incomplete run.
# Timeout kills the suite's process tree, refuses, and records nothing, so a retry reruns.
run_suite() {
	(
		cd "$ARCHIVE_DIR"
		export TMPDIR="$ARCHIVE_DIR/var/agent-tmp"
		mkdir -p "$ARCHIVE_DIR/var/agent-tmp"
		if [ -f "$ARCHIVE_DIR/bunfig.toml" ]; then
			export BUN_CONFIG_FILE="$ARCHIVE_DIR/bunfig.toml"
			bun_config="--config=$ARCHIVE_DIR/bunfig.toml"
		else
			bun_config=""
		fi
		failed=0
		if [ "$bun_count" -gt 0 ]; then
			if [ -n "$bun_config" ]; then
				nice -n 10 bun "$bun_config" test --timeout=120000 --path-ignore-patterns 'var/agent-tmp/**' $kept_bun || failed=1
			else
				nice -n 10 bun test --timeout=120000 --path-ignore-patterns 'var/agent-tmp/**' $kept_bun || failed=1
			fi
		fi
		for suite in $kept_shell; do
			if sh "$suite"; then echo "GREEN script-suite $suite"; else echo "RED script-suite $suite rc=$?"; failed=1; fi
		done
		for suite in $kept_py; do
			if python3 "$suite"; then echo "GREEN python-suite $suite"; else echo "RED python-suite $suite rc=$?"; failed=1; fi
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
	rm -f "$SUITE_OUT"
	cleanup_archive
	fail "full suite timed out after ${TIMEOUT_SECS}s; incomplete evidence is non-pass and nothing was cached"
	exit 1
fi

# Completeness: bun's summary lines must account for the run. A suite process that died without
# them is incomplete evidence: refuse, cache nothing.
bun_ran=$(awk '$1 == "Ran" && ($3 == "test" || $3 == "tests") && $4 == "across" { print $2 }' "$SUITE_OUT" | tail -n 1)
bun_fail=$(awk 'NF == 2 && $2 == "fail" { print $1 }' "$SUITE_OUT" | tail -n 1)
bun_ran=${bun_ran:-0}
bun_fail=${bun_fail:-0}
shell_green=$(grep -c '^GREEN script-suite ' "$SUITE_OUT" 2>/dev/null || true)
shell_red=$(grep -c '^RED script-suite ' "$SUITE_OUT" 2>/dev/null || true)
py_green=$(grep -c '^GREEN python-suite ' "$SUITE_OUT" 2>/dev/null || true)
py_red=$(grep -c '^RED python-suite ' "$SUITE_OUT" 2>/dev/null || true)
complete=1
[ "$bun_count" -gt 0 ] && [ "$bun_ran" -gt 0 ] 2>/dev/null || { [ "$bun_count" -eq 0 ] || complete=0; }
[ "$((shell_green + shell_red))" -eq "$shell_count" ] 2>/dev/null || complete=0
[ "$((py_green + py_red))" -eq "$py_count" ] 2>/dev/null || complete=0
if [ "$complete" -ne 1 ]; then
	rm -f "$SUITE_OUT"
	cleanup_archive
	fail "full suite ended without complete evidence (rc=$suite_rc bun_ran=$bun_ran shell=$shell_green/$shell_count python=$py_green/$py_count); incomplete evidence is non-pass and nothing was cached"
	exit 1
fi

if [ "$suite_rc" -eq 0 ] && [ "$bun_fail" -eq 0 ] && [ "$shell_red" -eq 0 ] && [ "$py_red" -eq 0 ]; then
	verdict=PASS
	code=0
else
	verdict=FAIL
	code=$suite_rc
	[ "$code" -ne 0 ] || code=1
fi

# Record the finished verdict atomically beside its evidence log. Only complete runs land here.
mv "$SUITE_OUT" "$CACHE_DIR/$tree.log"
TREE=$tree CHECKS=$checks RUNTIME=$runtime VERDICT=$verdict CODE=$code BUNF=$bun_count BUNRAN=$bun_ran BUNFAIL=$bun_fail SHC=$shell_count SHR=$shell_red PYC=$py_count PYR=$py_red EXCL="$excluded" ENTRY=$entry python3 - <<'PYEOF' || { rm -f "$CACHE_DIR/$tree.log"; cleanup_archive; echo "FULL-SUITE: RED: verdict evidence could not be recorded; nothing was cached" >&2; exit 1; }
import json, os
from datetime import datetime, timezone
entry = {
    "version": 1,
    "tree": os.environ["TREE"],
    "checks": os.environ["CHECKS"],
    "runtime": os.environ["RUNTIME"],
    "verdict": os.environ["VERDICT"],
    "exit_code": int(os.environ["CODE"]),
    "evidence": {
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
