#!/bin/sh
# fresh-gate.sh -- run the pre-push fast gate against an exact git archive.
#
# Usage:
#   scripts/fresh-gate.sh --selftest
#   scripts/fresh-gate.sh --commit SHA [--base SHA] [--changed-file PATH ...]
#   scripts/fresh-gate.sh --archive-dir DIR [--changed-file PATH ...]
#
# The archive has no .git directory. This prevents the gate from reading dirty checkout
# state, untracked fixtures, or stale var/agent-tmp test trees.
set -eu

# HERMETIC1: reject caller-supplied repository/tracker authority before suite discovery or Git probes.
if [ "${GIT_DIR+x}" = x ]; then echo "FRESH-GATE: REFUSED caller GIT_DIR is set" >&2; exit 1; fi
if [ "${GIT_WORK_TREE+x}" = x ]; then echo "FRESH-GATE: REFUSED caller GIT_WORK_TREE is set" >&2; exit 1; fi
if [ "${BEADS_DB+x}" = x ]; then echo "FRESH-GATE: REFUSED caller BEADS_DB is set" >&2; exit 1; fi

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd -P)
ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd -P)
COMMIT=HEAD
BASE=
ARCHIVE_DIR=
ARCHIVE_SUPPLIED=0
CHANGED=
WORK=
OWN_WORK=0

usage() {
	echo "usage: fresh-gate.sh --selftest | --test-workers | --commit SHA [--base SHA] [--changed-file PATH ...] | --archive-dir DIR [--changed-file PATH ...]" >&2
}

fail() {
	echo "FRESH-GATE: RED: $*" >&2
	return 1
}

require_gate_functions() {
	for name in gate_manifest gate_cli_compile gate_cli_boot gate_harness gate_notes gate_readme gate_focused select_affected_tests run_affected_tests; do
		command -v "$name" >/dev/null 2>&1 || fail "required gate function is missing: $name"
	done
}

run_step() {
	label=$1
	shift
	log="$WORK/$label.log"
	phase_started_ms=$(python3 -c 'import time; print(time.time_ns() // 1000000)')
	echo "== $label"
	if "$@" >"$log" 2>&1; then step_rc=0; else step_rc=$?; fi
	cat "$log"
	PHASE="$label" START="$phase_started_ms" RC="$step_rc" OUT="$WORK/gate-phases.jsonl" python3 - <<'PYEOF'
import json, os, time
row = {"stage": os.environ["PHASE"], "wall_ms": time.time_ns() // 1000000 - int(os.environ["START"]), "rc": int(os.environ["RC"])}
with open(os.environ["OUT"], "a") as handle:
    handle.write(json.dumps(row) + "\n")
PYEOF
	if [ "$step_rc" -eq 0 ]; then echo "GREEN $label"; else echo "RED $label producer_rc=$step_rc" >&2; fi
	return "$step_rc"
}

# Scratch measurement refs skip ONLY the budget judgment; the wording names
# the skip so the CI record stays the judge of record for main pushes.
print_budget_skip() {
	case "${FRESH_GATE_SKIP_REGEX:-}" in
		"scratch measurement ref;"*) printf 'regex-budget: NOT JUDGED (%s)\n' "$FRESH_GATE_SKIP_REGEX" ;;
		*) printf 'focused regex-budget: SKIPPED (%s)\n' "$FRESH_GATE_SKIP_REGEX" ;;
	esac
}

gate_manifest() {
	if [ -e "$ARCHIVE_DIR/.git" ] || [ -x "$ARCHIVE_DIR/bin/omp-kit" ]; then
		(
			cd "$ARCHIVE_DIR"
			sh scripts/build-manifest.sh --check
		)
		return $?
	fi
	(
		cd "$ARCHIVE_DIR"
		want="$WORK/manifest.want"
		pack="uncommitted-$(date -u +%Y-%m-%d)"
		printf 'name\tsha256\tclass\tpack\n' >"$want"
		classes="$WORK/manifest.classes"
		bun run --no-env-file --config=/dev/null scripts/rule-class.ts rules/*.md >"$classes"
		for file in rules/*.md; do
			name=$(basename "$file" .md)
			class=$(awk -F '\t' -v n="$name" '$1 == n { print $2 }' "$classes")
			case "$class" in
				always|tripwire|reminder|canary|router) ;;
				*) echo "manifest generation: FAIL: no valid class for $name (got '$class')" >&2; return 1 ;;
			esac
			printf '%s\t%s\t%s\t%s\n' "$name" "$(shasum -a 256 "$file" | cut -d' ' -f1)" "$class" "$pack" >>"$want"
		done
		if [ ! -f MANIFEST.tsv ]; then
			cp "$want" MANIFEST.tsv
			echo "manifest generation: OK ($(($(wc -l < "$want") - 1)) rules; generated MANIFEST.tsv)"
		fi
		have="$WORK/manifest.have"
		cut -f1-3 MANIFEST.tsv >"$have"
		want3="$WORK/manifest.want3"
		cut -f1-3 "$want" >"$want3"
		if [ "$(cat "$want3")" = "$(cat "$have")" ]; then
			echo "build-manifest --check: OK ($(($(wc -l < "$want") - 1)) rules, archive fallback)"
			return 0
		fi
		echo 'build-manifest --check: FAIL: MANIFEST.tsv does not match rules/' >&2
		diff "$have" "$want3" >&2 || true
		return 1
	)
}

# SAVEFIRST1 (ompkit-774u.16): saving work needs only physical room. The gate's heavy
# steps admit on the OS statfs reading (the 10 GiB floor still refuses a truly full
# disk); sbh's policy floor becomes the WARN line from disk_pressure_flag, not a veto.
# The step's heavy admission wait is queue time, not gate work: the child records when
# it actually started, and the wait before it goes to queued.secs, which the 180 s
# judgment subtracts like deferral.
heavy_step() {
	step=$1
	shift
	admitted="$WORK/$step.admitted"
	rm -f "$admitted"
	queued_at=$(date +%s)
	rc=0
	# The child script expands $0/$@ itself, so the single quotes are intended. `bun run` prepends
	# every ancestor node_modules/.bin to its children's PATH, so a step would run whatever `omp`
	# sits above wherever the archive was extracted; `env PATH="$PATH"` gives the step the gate's own PATH.
	# shellcheck disable=SC2016
	bun run --no-env-file --config=/dev/null src/cli.ts heavy --label "fresh-gate-$step" --disk-observer statfs -- \
		env PATH="$PATH" sh -c 'date +%s >"$0"; exec "$@"' "$admitted" "$@" || rc=$?
	if [ -s "$admitted" ]; then
		wait_s=$(($(cat "$admitted") - queued_at))
	else
		wait_s=$(($(date +%s) - queued_at))
	fi
	echo "$wait_s" >>"$WORK/queued.secs"
	echo "heavy admission wait: ${wait_s}s ($step)"
	if [ ! -s "$admitted" ]; then
		echo "FRESH-GATE: RED: heavy refused admission for $step (exit $rc); the heavy line above names the reason" >&2
	fi
	return "$rc"
}

# sbh pressure is a flag routed to waste management, never a veto on saving work.
# The flag names the largest scratch owners (AC1) so the waste loop knows where to
# start. The scan is inline (not a helper) so gate-function extractors keep working;
# it is best effort (any measurement failure prints the flag without owners) and
# bounded to the first 200 scratch entries.
disk_pressure_flag() {
	command -v sbh >/dev/null 2>&1 || return 0
	sbh_rc=0
	sbh_out=$(sbh check --need 10G 2>/dev/null) || sbh_rc=$?
	[ "$sbh_rc" -eq 1 ] || return 0
	pct=$(printf '%s\n' "$sbh_out" | sed -n 's/^.*"free_pct":\([0-9][0-9.]*\).*$/\1/p' | head -n 1)
	if [ -n "$pct" ]; then
		pct=$(printf '%.1f%%' "$pct")
	else
		pct="an unparsed"
	fi
	owners=
	# The pre-push caller supplies its checkout; ROOT is the isolated archive.
	scratch_root=${OMP_KIT_CASE_CWD:-${ROOT:-}}
	if [ -n "$scratch_root" ] && [ -d "$scratch_root/var/agent-tmp" ]; then
		owners=$(scanned=0
			for entry in "$scratch_root/var/agent-tmp"/*; do
				[ -d "$entry" ] || continue
				scanned=$((scanned + 1))
				[ "$scanned" -le 200 ] || break
				size=$(du -sk "$entry" 2>/dev/null | awk '{ print $1 }') || continue
				# bash 3.2 (macOS /bin/sh) rejects `continue` as a case body; grep instead.
				printf '%s' "$size" | grep -q '^[0-9][0-9]*$' || continue
				label=
				if [ -f "$entry/.owner" ]; then
					label=$(sed -n 's/^label=//p' "$entry/.owner" 2>/dev/null | tr -d '\t' | head -n 1) || label=
				fi
				[ -n "$label" ] || label=$(basename "$entry") || continue
				printf '%s\t%s\n' "$size" "$label"
			done | sort -rn | head -n 3 | awk -F'\t' '{
				kb=$1; label=$2
				if (kb >= 1048576) human=sprintf("%s:%.1fGiB", label, kb/1048576)
				else if (kb >= 1024) human=sprintf("%s:%.1fMiB", label, kb/1024)
				else human=sprintf("%s:%dKiB", label, kb)
				printf "%s%s", (NR>1 ? "," : ""), human
			} END { if (NR>0) printf "\n" }') || owners=
	fi
	if [ -n "$owners" ]; then
		echo "WARN disk-pressure: sbh reports $pct free (below its floor); saving continues on the 10 GiB physical floor; run waste management (ompkit-774u.15); top_scratch=$owners"
	else
		echo "WARN disk-pressure: sbh reports $pct free (below its floor); saving continues on the 10 GiB physical floor; run waste management (ompkit-774u.15)"
	fi
}

gate_harness() {
	(
		cd "$ARCHIVE_DIR"
		heavy_step harness bun scripts/ttsr-harness.ts --gate
	)
}
gate_cli_compile() {
	(
		cd "$ARCHIVE_DIR"
		heavy_step cli-compile bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --no-compile-autoload-tsconfig src/cli.ts --outfile="$WORK/omp-kit-cli"
	)
}
gate_cli_boot() {
	(
		cd "$ARCHIVE_DIR"
		boot_started=$(date +%s)
		if ! version=$("$WORK/omp-kit-cli" --version 2>&1); then
			printf 'cli-boot: --version failed: %s\n' "$version" >&2
			return 1
		fi
		paths=$(sed -n 's/^[[:space:]]*registerCommandHandler("\([^"]*\)".*/\1/p' "$ARCHIVE_DIR/src/cli.ts")
		[ -n "$paths" ] || {
			printf 'cli-boot: no registered handlers found in src/cli.ts\n' >&2
			return 1
		}
		while IFS= read -r path; do
			[ -n "$path" ] || continue
			# shellcheck disable=SC2086
			if "$WORK/omp-kit-cli" $path --help >/dev/null 2>"$WORK/cli-boot.err"; then
				:
			else
				rc=$?
				printf 'cli-boot: registered verb %s --help failed (rc=%s): %s\n' \
					"$path" "$rc" "$(cat "$WORK/cli-boot.err")" >&2
				return "$rc"
			fi
		done <<EOF
$paths
EOF
		printf 'cli-boot: version=%s verbs=%s elapsed=%ss\n' "$version" \
			"$(printf '%s\n' "$paths" | awk 'NF { n++ } END { print n+0 }')" \
			"$(($(date +%s) - boot_started))"
	)
}

# judge_budget ELAPSED TESTS QUEUED: the 180 s budget judges the gate's own machinery. The affected
# tests' run time (TESTS) scales with the diff, not with the gate, and is reported beside it; heavy
# queue wait behind another agent's job (QUEUED) is not this gate's work either.
judge_budget() {
	judged=$(($1 - $2 - $3))
	if [ "$judged" -ge 180 ]; then
		fail "elapsed=${1}s (affected tests ${2}s, heavy queue wait ${3}s, judged ${judged}s) exceeds 180s"
		return 1
	fi
	echo "FRESH-GATE: GREEN commit=$COMMIT elapsed=${1}s tests=${2}s queued=${3}s judged=${judged}s"
}

append_changed() {
	CHANGED="$CHANGED
$1"
}

# CIGATE1 (ompkit-v66l.27.1): the bun tests a push runs are the ones its diff affects: changed test
# files, plus tests whose static import graph reaches a changed path or that name a changed file
# (scripts/affected-tests.ts, from the gate's own tree). Prints one path per line.
select_affected_tests() {
	set --
	for file in $CHANGED; do
		[ -n "$file" ] && set -- "$@" --changed-file "$file"
	done
	bun run --no-env-file --config=/dev/null "$SCRIPT_DIR/affected-tests.ts" --root "$ARCHIVE_DIR" --explain --order distance "$@"
}

# K parallel bun workers for the affected tests: a quarter of the online cores, 2..4, unless
# FRESH_GATE_TEST_WORKERS names a positive count.
test_workers() {
	case "${FRESH_GATE_TEST_WORKERS:-}" in
		''|*[!0-9]*|0) ;;
		*) echo "$FRESH_GATE_TEST_WORKERS"; return 0 ;;
	esac
	ncpu=$(getconf _NPROCESSORS_ONLN 2>/dev/null) || ncpu=4
	case "$ncpu" in ''|*[!0-9]*) ncpu=4 ;; esac
	k=$((ncpu / 4))
	[ "$k" -ge 2 ] || k=2
	[ "$k" -le 4 ] || k=4
	echo "$k"
}

# run_affected_tests TEST...: run every selected test to completion on the exact-commit export, or
# refuse. Nothing defers to CI: the old per-suite 25 s budget and --no-wait admission (heavy's
# default sbh observer) turned every push on this host into a GREEN gate that ran 0 tests
# (2026-10-19: "disk low: sbh check --need 10G reports pressure" with 108 GB free). Below the hard
# physical floor the gate refuses with a typed reason (scripts/gate-disk-floor.ts); above it heavy
# admits on statfs (SAVEFIRST1), waits for a slot instead of skipping, and runs the suite at nice 10.
run_affected_tests() {
	(cd "$ARCHIVE_DIR" && bun run --no-env-file --config=/dev/null "$SCRIPT_DIR/gate-disk-floor.ts" "$ARCHIVE_DIR") || return $?
	files=$#
	# NODOUBLEPASS1 (ompkit-bp50d): the exact selection, kept for the focused-passed report below.
	focused_selection="$*"
	tests_out="$WORK/tests.out"
	scripts_out="$WORK/scripts.out"
	: >"$tests_out"
	: >"$scripts_out"
	metric_dir="$WORK/file-metrics"
	metric_rows="$WORK/file-metrics.json"
	metric_declared="$WORK/file-metrics.declared"
	mkdir -p "$metric_dir"
	# A gate may judge more than one focused selection in the same owned WORK.
	# Retain no outcome from an earlier selection as evidence for this one.
	rm -f "$metric_dir"/*.json "$metric_dir"/*.log "$metric_dir"/*.timings \
		"$WORK/bun-metrics.stage" "$WORK/scripts-metrics.stage" "$metric_rows"
	for metric_path in "$@"; do printf '%s\n' "$metric_path"; done >"$metric_declared"
	metric_tree=$(git -C "$ROOT" rev-parse "$COMMIT^{tree}") || return 1
	metric_started_ms=$(python3 -c 'import time; print(time.time_ns() // 1000000)')
	metric_load_start=$(python3 -c 'import os,json; print(json.dumps(os.getloadavg()))')
	# bun reads a bare argument as a name filter; ./PATH names the file. Shell and python suites run
	# as CI runs them (`sh FILE`, `python3 FILE`).
	bun_files=0
	workers=0
	script_files=
	for test_file in "$@"; do
		case "$test_file" in
			*.test.sh|*.py) script_files="$script_files $test_file" ;;
			*) set -- "$@" "$test_file"; bun_files=$((bun_files + 1)) ;;
		esac
		shift
	done
	tests_started=$(date +%s)
	queued_before=0
	[ -f "$WORK/queued.secs" ] && queued_before=$(awk '{ s += $1 } END { printf "%d", s }' "$WORK/queued.secs")
	tests_rc=0
	if [ "$bun_files" -gt 0 ]; then
		mkdir -p "$ARCHIVE_DIR/var/agent-tmp"
		workers=$(test_workers)
		[ "$workers" -le "$bun_files" ] || workers=$bun_files
		echo "affected bun tests: files=$bun_files workers=$workers"
		(
			cd "$ARCHIVE_DIR"
			heavy_step tests env TMPDIR="$ARCHIVE_DIR/var/agent-tmp" BUN_CONFIG_FILE="$ARCHIVE_DIR/bunfig.toml" \
				python3 "$SCRIPT_DIR/suite-metrics.py" stage --runner bun --records "$metric_dir" \
				--cwd "$ARCHIVE_DIR" --tree "$metric_tree" --summary "$WORK/bun-metrics.stage" \
				--bun-config "$ARCHIVE_DIR/bunfig.toml" --workers "$workers" --deadline 3600 "$@"
		) >"$tests_out" 2>&1 || tests_rc=$?
		cat "$tests_out"
	fi
	if [ -n "$script_files" ]; then
		mkdir -p "$ARCHIVE_DIR/var/agent-tmp"
		script_rc=0
		# Shell/Python retain their serial execution contract; only Bun uses the
		# existing bounded worker count. Every record comes from a real file process.
		# shellcheck disable=SC2086
		(
			cd "$ARCHIVE_DIR"
			heavy_step script-tests env TMPDIR="$ARCHIVE_DIR/var/agent-tmp" \
				python3 "$SCRIPT_DIR/suite-metrics.py" stage --runner scripts --records "$metric_dir" \
				--cwd "$ARCHIVE_DIR" --tree "$metric_tree" --summary "$WORK/scripts-metrics.stage" \
				--workers 1 --deadline 3600 $script_files
		) >"$scripts_out" 2>&1 || script_rc=$?
		cat "$scripts_out"
		[ "$tests_rc" -ne 0 ] || tests_rc=$script_rc
	fi
	queued_after=$(awk '{ s += $1 } END { printf "%d", s }' "$WORK/queued.secs")
	echo "$(($(date +%s) - tests_started - (queued_after - queued_before)))" >>"$WORK/tests.secs"
	# bun's summary: " N pass", " N fail", "Ran N test(s) across M file(s)." A bun selection that ran
	# no test is not a pass, whatever its exit status. Each shell or python suite counts as one run.
	bun_ran=0; failed=0; script_ran=0
	if [ -f "$WORK/bun-metrics.stage" ]; then
		bun_ran=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["test_count"])' "$WORK/bun-metrics.stage")
		failed=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["test_failures"])' "$WORK/bun-metrics.stage")
	fi
	if [ -f "$WORK/scripts-metrics.stage" ]; then
		script_ran=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["files"]))' "$WORK/scripts-metrics.stage")
	fi
	ran=$((bun_ran + script_ran))
	timing_tables="$WORK/timings"
	if [ -n "${FRESH_GATE_LEDGER:-}" ]; then
		timing_tables="$(dirname "$FRESH_GATE_LEDGER")/full-suite-verdicts/timings"
	fi
	if ! python3 "$SCRIPT_DIR/suite-metrics.py" collect --records "$metric_dir" \
		--declared "$metric_declared" --output "$metric_rows" --csv "$WORK/file-metrics.csv" \
		--cwd "$ARCHIVE_DIR" --tables-dir "$timing_tables"; then
		[ "$tests_rc" -ne 0 ] || tests_rc=1
	fi
	if [ "$tests_rc" -eq 0 ]; then
		bun run --no-env-file --config=/dev/null "$SCRIPT_DIR/test-budget.ts" \
			--repo "$SCRIPT_DIR/.." --enforce "$metric_rows" --json || tests_rc=$?
	fi
	echo "affected tests: files=$files ran=$ran fail=${failed:-0} rc=$tests_rc"
	record_run "$ran" "$files" "$tests_rc"
	if [ "$tests_rc" -ne 0 ]; then
		echo "FRESH-GATE: RED: affected tests did not pass (exit $tests_rc); the push is refused" >&2
		return "$tests_rc"
	fi
	# Same-tree reuse carries the actual measured records as well as the selected
	# paths. An absent/truncated row never becomes a reusable file outcome.
	if [ -n "${FRESH_GATE_PASSED_OUT:-}" ] && { [ "$bun_files" -eq 0 ] || [ "${bun_ran:-0}" -gt 0 ]; }; then
		passed_tree=$(git -C "$ROOT" rev-parse "$COMMIT^{tree}" 2>/dev/null) || passed_tree=
		if [ -n "$passed_tree" ]; then
			# Header: tree, the judge (this script's bytes as executed) and the runtime; the verdict accepts
			# the report only when all three are its own (QuietBadger AM 69014: never tree+names alone).
			judge_sha=$(python3 "$SCRIPT_DIR/suite-metrics.py" identity --root "$SCRIPT_DIR/.." --scope focused) || return 1
			{
				echo "tree $passed_tree"
				echo "judge ${judge_sha:-unknown}"
				echo "runtime $(uname -s)/$(uname -m)/bun-$(bun --version 2>/dev/null)/$(python3 --version 2>&1)"
				# shellcheck disable=SC2086
				printf '%s\n' $focused_selection
			} >"$FRESH_GATE_PASSED_OUT" 2>/dev/null || :
			cp "$metric_rows" "$FRESH_GATE_PASSED_OUT.timings.json" || return 1
		fi
	fi
	if [ "$bun_files" -gt 0 ] && [ "${bun_ran:-0}" -eq 0 ]; then
		echo "FRESH-GATE: RED: $bun_files affected bun test files were selected but bun reported no test run" >&2
		return 1
	fi
	if [ -s "$WORK/excluded" ]; then
		echo "FRESH-GATE: VERDICT PARTIAL files=$files ran=$ran deferred=$(paste -sd , - <"$WORK/excluded"): CI runs the deferred files"
	else
		echo "FRESH-GATE: VERDICT TESTED files=$files ran=$ran"
	fi
}

# Product code a change touches: source, shell or python outside tests/ that is still in the tree.
# A push that changes product code and selects no test is refused (CIGATE1): a gate that ran nothing
# never passes code. Test-tree material (helpers, e2e drivers) is judged by the suites that use it.
changed_code() {
	for file in $CHANGED; do
		case "$file" in
			tests/*) ;;
			*.ts|*.tsx|*.mts|*.cts|*.js|*.mjs|*.cjs|*.sh|*.py)
				[ -e "$ARCHIVE_DIR/$file" ] && printf '%s\n' "$file" ;;
		esac
	done
	return 0
}

# CI-only manifest (scripts/gate-ci-only.tsv, read from the gate's own tree like every gate script):
# tests that cannot be hermetic on a dev Mac. Each row: path, kind, bead, expires, reason. kind is
# ci-only (expires -) or hermeticity (a test bug, expiring within 14 days, like the quarantine);
# an expired row no longer excludes. Every exclusion is printed and turns the verdict PARTIAL.
# apply_ci_only TEST...: kept tests on stdout, exclusions on stderr and in $WORK/excluded.
apply_ci_only() {
	manifest="$SCRIPT_DIR/gate-ci-only.tsv"
	: >"$WORK/excluded"
	if [ ! -f "$manifest" ]; then
		printf '%s\n' "$@"
		return 0
	fi
	today=$(date -u +%Y-%m-%d)
	horizon=$(date -u -v+14d +%Y-%m-%d 2>/dev/null || date -u -d '+14 days' +%Y-%m-%d)
	printf '%s\n' "$@" | awk -v manifest="$manifest" -v today="$today" -v horizon="$horizon" -v excluded="$WORK/excluded" '
		BEGIN {
			header = "path\tkind\tbead\texpires\treason"
			while ((getline line < manifest) > 0) {
				n++
				if (n == 1) { if (line != header) { bad = "line 1 is not the header path, kind, bead, expires, reason"; break } continue }
				if (line == "") continue
				if (split(line, f, "\t") != 5 || f[1] == "" || f[3] == "" || f[5] == "") { bad = "line " n " needs 5 non-empty tab-separated fields"; break }
				if (f[2] == "ci-only") {
					if (f[4] != "-") { bad = "line " n ": a ci-only row expires -, got " f[4]; break }
				} else if (f[2] == "hermeticity") {
					if (length(f[4]) != 10 || substr(f[4], 5, 1) != "-" || substr(f[4], 8, 1) != "-" || f[4] > horizon) { bad = "line " n ": a hermeticity row expires by " horizon " (14 days), got " f[4]; break }
					if (f[4] < today) { print "focused: ci-only manifest row for " f[1] " (" f[3] ") EXPIRED " f[4] "; it runs" > "/dev/stderr"; continue }
				} else { bad = "line " n ": kind is ci-only or hermeticity, got " f[2]; break }
				row[f[1]] = f[2] " " f[3] ": " f[5]
			}
			if (n == 0) bad = "the manifest is empty or unreadable"
			if (bad != "") { print "FRESH-GATE: REFUSED reason=CI_ONLY_MANIFEST_INVALID " manifest ": " bad > "/dev/stderr"; exit 3 }
		}
		$0 == "" { next }
		($0 in row) { print "focused: excluded " $0 " (" row[$0] "); CI runs it" > "/dev/stderr"; print $0 >> excluded; next }
		{ print }
	'
}

# One terminal JSON line per gate, including pre-selection failures. Focused-only
# fixture callers record their own measured interval; absent timing stays unknown.
record_run() {
	last_record_tests=$1; last_record_files=$2
	[ "${gate_defer_record:-0}" != 1 ] || return 0
	METRICS="${metric_rows:-}" DECLARED="${metric_declared:-}" START_MS="${gate_started_ms:-${metric_started_ms:-0}}" LOAD_START="${gate_load_start:-${metric_load_start:-null}}" \
	WORKER_COUNT="${workers:-0}" LEDGER="${FRESH_GATE_LEDGER:-}" RUN_COMMIT="$COMMIT" RUN_BASE="${BASE:-}" \
	RUN_CHANGED="$CHANGED" RUN_TESTS="$1" RUN_FILES="$2" RUN_RC="$3" JUDGE="$SCRIPT_DIR/fresh-gate.sh" JUDGE_ID="${gate_judge_id:-}" GATE_PHASES="$WORK/gate-phases.jsonl" \
	python3 - <<'PYEOF'
import hashlib, json, os, time
from datetime import datetime, timezone
from pathlib import Path
rows_path = Path(os.environ["METRICS"]) if os.environ["METRICS"] else None
rows = json.loads(rows_path.read_text()) if rows_path and rows_path.is_file() else []
declared_path = Path(os.environ["DECLARED"]) if os.environ["DECLARED"] else None
declared = declared_path.read_text().splitlines() if declared_path and declared_path.is_file() else []
stages = {}
for runner in ("bun", "sh", "python3"):
    selected = [row for row in rows if row["runner"] == runner]
    stages[runner] = {
        "wall_ms": max(row["finished_ms"] for row in selected) - min(row["started_ms"] for row in selected) if selected else 0,
        "cpu_user_ms": sum(row["cpu_user_ms"] for row in selected),
        "cpu_system_ms": sum(row["cpu_system_ms"] for row in selected),
    }
phase_path = Path(os.environ["GATE_PHASES"])
if phase_path.is_file():
    for line in phase_path.read_text().splitlines():
        phase = json.loads(line)
        stages[phase["stage"]] = {"wall_ms": phase["wall_ms"], "rc": phase["rc"]}
end = time.time_ns() // 1000000
start = int(os.environ["START_MS"])
entry = {"version": 2, "ts": datetime.now(timezone.utc).isoformat(),
         "commit": os.environ["RUN_COMMIT"], "base": os.environ["RUN_BASE"],
         "changed": len(os.environ["RUN_CHANGED"].splitlines()),
         "selected_files": int(os.environ["RUN_FILES"]), "tests_ran": int(os.environ["RUN_TESTS"]),
         "rc": int(os.environ["RUN_RC"]),
         "judge": {"sha256": os.environ["JUDGE_ID"] or hashlib.sha256(Path(os.environ["JUDGE"]).read_bytes()).hexdigest(),
                   "scope": "focused" if os.environ["JUDGE_ID"] else "standalone-fixture"},
         "timing": {"wall_ms": end - start if start else None, "started_ms": start or None,
                    "load_start": json.loads(os.environ["LOAD_START"]), "load_end": list(os.getloadavg()),
                    "workers": {"bun": int(os.environ["WORKER_COUNT"]), "scripts": int(any(row["runner"] != "bun" for row in rows))}, "stages": stages},
         "evidence": {"complete": bool(declared) and len(rows) == len(declared) and all(row["complete"] for row in rows),
                      "declared_files": declared, "files": rows}}
line = json.dumps(entry, allow_nan=False)
print("FRESH-GATE: measured-verdict " + line)
if os.environ["LEDGER"]:
    ledger = Path(os.environ["LEDGER"])
    ledger.parent.mkdir(parents=True, exist_ok=True)
    with ledger.open("a") as handle:
        handle.write(line + "\n")
PYEOF
}

gate_notes() {
	sh "$SCRIPT_DIR/check-pushed-notes.sh" --repo "$ROOT" --base "$BASE" --tip "$COMMIT" --archive-dir "$ARCHIVE_DIR"
}

# README currency: every registry command and doctor scope documented, no pinned
# release version, readme-update gate when installed (scripts/readme-check.ts).
gate_readme() {
	(
		cd "$ARCHIVE_DIR"
		bun run --no-env-file --config=/dev/null scripts/readme-check.ts --root "$ARCHIVE_DIR"
	)
}

gate_focused() {
	focus_tests=
	needs_shell=0
	needs_actionlint=0
	needs_regex=0
	needs_live=0
	for file in $CHANGED; do
		[ -n "$file" ] || continue
		case "$file" in
			tests/cli/migrate.test.ts)
				focus_tests="$focus_tests tests/cli/migrate-history.test.ts" ;;
			src/migrate.ts)
				focus_tests="$focus_tests tests/cli/migrate-history.test.ts" ;;
			src/kit-update.ts)
				focus_tests="$focus_tests tests/cli/kit-update.test.ts" ;;
			*.test.ts)
				# A range that deletes a suite has nothing to run for it; a kept one is selected below.
				[ -e "$ARCHIVE_DIR/$file" ] || echo "focused: $file deleted in range; not run" ;;
			scripts/*.sh|checkers/*.sh|installer/*.sh|tests/cli/*.sh|tests/e2e/*.sh)
				needs_shell=1 ;;
			.github/workflows/*.yml|.github/workflows/*.yaml)
				needs_actionlint=1 ;;
			rules/*.md)
				needs_regex=1; needs_live=1 ;;
			rules-fleet/*.md)
				needs_live=1 ;;
			tests/live/*)
				needs_live=1 ;;
			tests/test-preload.ts)
				focus_tests="$focus_tests tests/cli/send-consumed.test.ts" ;;
			esac
	done
# CI installs apt shellcheck (currently v0.9.0) while developers run newer
# local builds (0.11.0 stays silent on SC2015-info and exits 0). Run the
# pinned CI version via docker so the push gate refuses what CI refuses
# (ompkit-f2e4 gap: release-train.sh SC2015 turned main red for 4 commits).
PINNED_SHELLCHECK_IMAGE="koalaman/shellcheck:v0.9.0"
if [ "$needs_shell" = 1 ]; then
	shellcheck_runner=""
	if command -v docker >/dev/null 2>&1; then
		if docker image inspect "$PINNED_SHELLCHECK_IMAGE" >/dev/null 2>&1; then
			shellcheck_runner="pinned"
		else
			if docker pull "$PINNED_SHELLCHECK_IMAGE" >/dev/null 2>&1; then
				shellcheck_runner="pinned"
			fi
		fi
	fi
	if [ -z "$shellcheck_runner" ]; then
		if command -v shellcheck >/dev/null 2>&1; then
			shellcheck_runner="local"
			local_version="$(shellcheck -V | awk '/^version:/ {print $2}')"
			echo "focused shellcheck: pinned $PINNED_SHELLCHECK_IMAGE unavailable (no docker image); local ${local_version:-unknown} may miss CI findings"
		fi
	fi
	if [ -n "$shellcheck_runner" ]; then
		shell_rc=0
		for file in $CHANGED; do
			case "$file" in
				scripts/*.sh|checkers/*.sh|installer/*.sh|tests/cli/*.sh|tests/e2e/*.sh)
					if [ -e "$ARCHIVE_DIR/$file" ]; then
						if [ "$shellcheck_runner" = "pinned" ]; then
							if docker run --rm -v "$ARCHIVE_DIR:/archive:ro" "$PINNED_SHELLCHECK_IMAGE" -x -P /archive "/archive/$file"; then
								:
							else
								shell_rc=1
							fi
						else
							if shellcheck -x -P "$ARCHIVE_DIR" "$ARCHIVE_DIR/$file"; then
								:
							else
								shell_rc=1
							fi
						fi
					else
						echo "focused: $file deleted in range; not shellchecked"
					fi ;;
			esac
		done
		if [ "$shell_rc" -ne 0 ]; then
			echo "focused shellcheck: findings refuse the push" >&2
			return 1
		fi
	else
		echo "focused shellcheck: unavailable; no shell files were executed"
	fi
fi
	if [ "$needs_actionlint" = 1 ]; then
		if command -v actionlint >/dev/null 2>&1; then
			set --
			for workflow in "$ARCHIVE_DIR/.github/workflows"/*.yml "$ARCHIVE_DIR/.github/workflows"/*.yaml; do
				if [ -e "$workflow" ] || [ -L "$workflow" ]; then
					set -- "$@" "$workflow"
				fi
			done
			if [ "$#" -gt 0 ]; then
				if actionlint "$@"; then
					:
				else
					lint_rc=$?
					echo "focused actionlint: findings refuse the push" >&2
					return "$lint_rc"
				fi
			else
				echo "focused actionlint: no workflow files remain"
			fi
		else
			echo "focused actionlint: unavailable; no workflow files were executed"
		fi
	fi
	if [ -n "${FRESH_GATE_SKIP_REGEX:-}" ]; then
		print_budget_skip
	elif [ "$needs_regex" = 1 ]; then
		# Regex cost gate (RX1): self-bounding (internal 57 s deadline); red names
		# the rule, shape and encoding, and the push is refused. Exit 75 means
		# INCONCLUSIVE (machine too loud to judge): defer to CI, do not refuse.
		(cd "$ARCHIVE_DIR" && bun run --no-env-file --config=/dev/null scripts/regex-budget.ts)
		regex_rc=$?
		if [ "$regex_rc" -eq 75 ]; then
			printf 'focused regex-budget: INCONCLUSIVE (loud machine; deferred to CI)\n'
		elif [ "$regex_rc" -ne 0 ]; then
			return "$regex_rc"
		fi
	fi
	if [ "$needs_live" = 1 ]; then
		live_out="$WORK/live-coverage.log"
		if (cd "$ARCHIVE_DIR" && bun run --no-env-file --config=/dev/null tests/live/lib.mjs coverage rules/ rules-fleet/) >"$live_out" 2>&1; then
			echo "live coverage: OK"
		else
			cat "$live_out"
			live_bad=0
			for file in $CHANGED; do
				case "$file" in
					rules/*.md|rules-fleet/*.md)
						rule=$(basename "$file" .md)
						if grep -q "^  $rule:" "$live_out"; then
							echo "live coverage: $rule changed in range but has no scenario" >&2
							live_bad=1
						fi ;;
				esac
			done
			if [ "$live_bad" -ne 0 ]; then
				return 1
			fi
			echo "live coverage: only pre-existing gaps outside the pushed range"
		fi
	fi
	affected=$(select_affected_tests) || { echo "focused: affected-test selection failed" >&2; return 1; }
	# Nearest first (changed tests, then direct importers); explicit mappings follow; each runs once.
	# shellcheck disable=SC2086
	focus_tests=$(printf '%s\n' $affected $focus_tests | awk 'NF && !seen[$0]++')
	# shellcheck disable=SC2086
	focus_tests=$(apply_ci_only $focus_tests) || return $?
	# Wall budget (CIGATE1 rule 3, default 360 s): if the selection's predicted wall on K workers (CI
	# per-file timings) exceeds it, the changed tests and the nearest importers run and the rest are
	# deferred by name; the verdict is PARTIAL, never a bare pass.
	if [ -n "$focus_tests" ]; then
		set --
		for file in $CHANGED; do
			[ -n "$file" ] && set -- "$@" --changed-file "$file"
		done
		# shellcheck disable=SC2086
		focus_tests=$(bun run --no-env-file --config=/dev/null "$SCRIPT_DIR/affected-tests.ts" --plan \
			--budget-secs "${FRESH_GATE_TEST_BUDGET_SECS:-360}" --workers "$(test_workers)" \
			--timings "$ARCHIVE_DIR/.github/core-test-timings.json" --deferred-out "$WORK/excluded" "$@" -- $focus_tests) || return $?
	fi
	if [ -n "$focus_tests" ] && [ ! -f "$ARCHIVE_DIR/MANIFEST.tsv" ]; then
		if ! (
			cd "$ARCHIVE_DIR"
			sh scripts/build-manifest.sh --stdout >MANIFEST.tsv
		); then
			echo "focused manifest generation: FAIL" >&2
			return 1
		fi
		echo "focused manifest generation: OK"
	fi
	if [ -n "$focus_tests" ]; then
		# CI tests a source checkout; contributor-only paths (the Bun fallback in
		# runtime-adapter.sh) require .git, so the focused suites get one too.
		[ -e "$ARCHIVE_DIR/.git" ] || git -C "$ARCHIVE_DIR" init -q
		# Intentional word splitting turns newline-separated test paths into argv entries.
		# shellcheck disable=SC2086
		run_affected_tests $focus_tests || return $?
	else
		echo "focused suites: none selected for changed paths"
		code=$(changed_code)
		if [ -n "$code" ]; then
			record_run 0 0 1
			if [ -s "$WORK/excluded" ]; then
				# shellcheck disable=SC2086
				echo "FRESH-GATE: REFUSED reason=NO_LOCAL_TESTS code=$(printf '%s\n' $code | paste -sd , -) ci_only=$(paste -sd , - <"$WORK/excluded"): every test reaching this code is CI-only; add a hermetic test that exercises it" >&2
			else
				# shellcheck disable=SC2086
				echo "FRESH-GATE: REFUSED reason=NO_AFFECTED_TESTS code=$(printf '%s\n' $code | paste -sd , -): the push changes product code and no test reaches it; add or name a test that exercises it" >&2
			fi
			return 1
		fi
		record_run 0 0 0
		if [ -s "$WORK/excluded" ]; then
			echo "FRESH-GATE: VERDICT PARTIAL files=0 ran=0 deferred=$(paste -sd , - <"$WORK/excluded"): only CI-only tests changed; CI runs them"
		else
			echo "FRESH-GATE: VERDICT DOCS_ONLY: no product code changed; no suite to run"
		fi
	fi
}

cleanup() {
	if [ "$OWN_WORK" = 1 ] && [ -n "$WORK" ]; then
		rm -rf "$WORK" 2>/dev/null || true
	fi
}
# GATESCR1 (ompkit-fp72.40): HUP/INT/TERM stop every process this gate started (the descendants of
# this shell, snapshotted before any signal, plus any process group one of them leads), KILL what
# survives a 5 s grace, then remove WORK. Without it a signalled gate left its WORK dir behind, and a
# hung suite kept the trap from ever running. Same contract as stop_descendants in pre-push-gate.sh.
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
	stop_descendants
	cleanup
	exit "$1"
}
# The traps are set before WORK exists, and WORK's name carries this shell's pid (with .owner), so a
# SIGKILLed gate leaves a dir the next pre-push gate's start-up sweep can attribute and remove.
make_work() {
	WORK_PARENT="$ROOT/var/agent-tmp"
	mkdir -p "$WORK_PARENT"
	trap cleanup EXIT
	trap 'on_signal 129' HUP
	trap 'on_signal 130' INT
	trap 'on_signal 143' TERM
	OWN_WORK=1
	WORK=$(mktemp -d "$WORK_PARENT/fresh-gate.$$.XXXXXX") # tempsafe: own signal-drain handler removes this pid-named owned dir on EXIT/HUP/INT/TERM; kitlib cannot hold signals during the grace
	start=$(ps -p $$ -o lstart= 2>/dev/null | sed 's/^ *//;s/ *$//')
	printf 'pid=%s\nprocess_start=%s\nlabel=fresh-gate\nrepo=%s\ncreated=%s\n' "$$" "$start" "$ROOT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$WORK/.owner"
}

selftest() {
	require_gate_functions
	echo "FRESH-GATE SELFTEST: GREEN"
}

# Read-only query for sibling runners; never mix it with a gate invocation.
if [ "$#" -eq 1 ] && [ "$1" = "--test-workers" ]; then
	test_workers
	exit 0
fi

while [ "$#" -gt 0 ]; do
	case "$1" in
		--selftest)
			selftest
			exit 0
			;;
		--commit)
			[ "$#" -ge 2 ] || { usage; exit 2; }
			COMMIT=$2
			shift 2
			;;
		--base)
			[ "$#" -ge 2 ] || { usage; exit 2; }
			BASE=$2
			shift 2
			;;
		--archive-dir)
			[ "$#" -ge 2 ] || { usage; exit 2; }
			ARCHIVE_DIR=$2
			ARCHIVE_SUPPLIED=1
			shift 2
			;;
		--changed-file)
			[ "$#" -ge 2 ] || { usage; exit 2; }
			append_changed "$2"
			shift 2
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			usage
			exit 2
			;;
	esac
done

# GATESCR1: no step reads stdin, and no suite may block on it: every check gets /dev/null.
exec </dev/null
require_gate_functions
if [ -z "$ARCHIVE_DIR" ]; then
	make_work
	ARCHIVE_DIR="$WORK/archive"
	mkdir -p "$ARCHIVE_DIR"
	archive_tar="$WORK/source.tar"
	git -C "$ROOT" archive --format=tar "$COMMIT" >"$archive_tar"
	tar -xf "$archive_tar" -C "$ARCHIVE_DIR"
else
	make_work
	ARCHIVE_DIR=$(CDPATH='' cd -- "$ARCHIVE_DIR" && pwd -P)
fi
if [ ! -f "$ARCHIVE_DIR/scripts/build-manifest.sh" ] || [ ! -f "$ARCHIVE_DIR/scripts/ttsr-harness.ts" ]; then
	fail "archive is missing the gate scripts"
	exit 1
fi
if [ -z "$CHANGED" ] && [ -n "$BASE" ]; then
	CHANGED=$(git -C "$ROOT" diff --name-only "$BASE" "$COMMIT")
elif [ -z "$CHANGED" ]; then
	CHANGED=$(git -C "$ROOT" diff-tree --root --no-commit-id --name-only -r "$COMMIT")
fi
# ompkit-hecp: corpus-relative paths resolve against the harness hermetic root
# unless the caller overrides OMP_KIT_CASE_CWD (e.g. pre-push-gate), so no
# location-dependent default is forced here: the verdict must not depend on
# where this archive was extracted.
setup_case_env() {
	if [ -n "${OMP_KIT_CASE_CWD+set}" ]; then
		export OMP_KIT_CASE_CWD
	else
		unset OMP_KIT_CASE_CWD
	fi
}
setup_case_env
# CIGATE1 ledger: the pushing checkout's own git dir (never committed, never shared). An explicit
# FRESH_GATE_LEDGER (including empty, which turns it off) wins.
if [ -z "${FRESH_GATE_LEDGER+set}" ]; then
	if [ "$ARCHIVE_SUPPLIED" = 0 ]; then
		ledger_git=$(git -C "$ROOT" rev-parse --absolute-git-dir 2>/dev/null) || ledger_git=
		FRESH_GATE_LEDGER=${ledger_git:+$ledger_git/omp-kit/fresh-gate-runs.jsonl}
	else
		# A caller-owned fixture/archive is not an operational push observation.
		FRESH_GATE_LEDGER=""
	fi
fi
# GATESCR1: the steps run in the background and this shell waits, because a POSIX shell defers a
# trap until its foreground job ends; with a hung suite in the foreground, HUP/INT/TERM never ran
# the handler. `wait` returns on the signal, so the handler stops the tree and removes WORK.
run_gate() {
	gate_started_ms=$(python3 -c 'import time; print(time.time_ns() // 1000000)')
	gate_load_start=$(python3 -c 'import os,json; print(json.dumps(os.getloadavg()))')
	gate_judge_id=$(python3 "$SCRIPT_DIR/suite-metrics.py" identity --root "$SCRIPT_DIR/.." --scope focused) || return 1
	gate_defer_record=1
	last_record_tests=0; last_record_files=0
	# SAVEFIRST1 (ompkit-774u.16): everything under the gate — including ladders nested
	# inside `test --full` — admits on physical bytes. sanitizedEnv carries this into the
	# isolated fixture; ladder.sh applies it to its heavy calls. Standalone runs leave it
	# unset, where the sbh policy floor still applies.
	export OMP_KIT_DISK_OBSERVER=statfs
	disk_pressure_flag
	started=$(date +%s)
	gate_rc=0
	for phase in manifest:gate_manifest cli-compile:gate_cli_compile cli-boot:gate_cli_boot \
		harness-gate:gate_harness notes:gate_notes readme:gate_readme focused:gate_focused; do
		run_step "${phase%%:*}" "${phase#*:}" || { gate_rc=$?; break; }
	done
	elapsed=$(($(date +%s) - started))
	# The affected tests' own run time is reported, not judged against the 180 s machinery budget.
	tests=0
	if [ -f "$WORK/tests.secs" ]; then
		tests=$(awk '{ s += $1 } END { printf "%d", s }' "$WORK/tests.secs")
	fi
	# Heavy queue wait behind another agent's job is not this gate's work (2026-10-18: a
	# 748 s RED was ten minutes queued behind one stuck job).
	queued=0
	if [ -f "$WORK/queued.secs" ]; then
		queued=$(awk '{ s += $1 } END { printf "%d", s }' "$WORK/queued.secs")
	fi
	if [ "$gate_rc" -eq 0 ]; then judge_budget "$elapsed" "$tests" "$queued" || gate_rc=$?; fi
	gate_defer_record=0
	record_run "$last_record_tests" "$last_record_files" "$gate_rc" || return 1
	return "$gate_rc"
}
run_gate &
wait "$!" || exit $?
