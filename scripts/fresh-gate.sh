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

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd -P)
ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd -P)
COMMIT=HEAD
BASE=
ARCHIVE_DIR=
CHANGED=
WORK=
OWN_WORK=0

usage() {
	echo "usage: fresh-gate.sh --selftest | --commit SHA [--base SHA] [--changed-file PATH ...] | --archive-dir DIR [--changed-file PATH ...]" >&2
}

fail() {
	echo "FRESH-GATE: RED: $*" >&2
	return 1
}

require_gate_functions() {
	for name in gate_manifest gate_cli_compile gate_harness gate_notes gate_readme gate_focused select_affected_tests run_affected_tests; do
		command -v "$name" >/dev/null 2>&1 || fail "required gate function is missing: $name"
	done
}

run_step() {
	label=$1
	shift
	log="$WORK/$label.log"
	echo "== $label"
	if "$@" >"$log" 2>&1; then
		cat "$log"
		echo "GREEN $label"
		return 0
	else
		rc=$?
		cat "$log"
		echo "RED $label producer_rc=$rc" >&2
		return "$rc"
	fi
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
	# The child script expands $0/$@ itself, so the single quotes are intended.
	# shellcheck disable=SC2016
	bun run --no-env-file --config=/dev/null src/cli.ts heavy --label "fresh-gate-$step" --disk-observer statfs -- \
		sh -c 'date +%s >"$0"; exec "$@"' "$admitted" "$@" || rc=$?
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
	echo "WARN disk-pressure: sbh reports $pct free (below its floor); saving continues on the 10 GiB physical floor; run waste management (ompkit-774u.15)"
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
	bun run --no-env-file --config=/dev/null "$SCRIPT_DIR/affected-tests.ts" --root "$ARCHIVE_DIR" --explain "$@"
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
	tests_out="$WORK/tests.out"
	scripts_out="$WORK/scripts.out"
	: >"$tests_out"
	: >"$scripts_out"
	# bun reads a bare argument as a name filter; ./PATH names the file. Shell and python suites run
	# as CI runs them (`sh FILE`, `python3 FILE`).
	bun_files=0
	script_files=
	for test_file in "$@"; do
		case "$test_file" in
			*.test.sh|*.py) script_files="$script_files $test_file" ;;
			*) set -- "$@" "./$test_file"; bun_files=$((bun_files + 1)) ;;
		esac
		shift
	done
	tests_started=$(date +%s)
	queued_before=0
	[ -f "$WORK/queued.secs" ] && queued_before=$(awk '{ s += $1 } END { printf "%d", s }' "$WORK/queued.secs")
	tests_rc=0
	if [ "$bun_files" -gt 0 ]; then
		(
			cd "$ARCHIVE_DIR"
			export BUN_CONFIG_FILE="$ARCHIVE_DIR/bunfig.toml"
			heavy_step tests bun --config="$ARCHIVE_DIR/bunfig.toml" test --timeout=120000 --path-ignore-patterns 'var/agent-tmp/**' "$@"
		) >"$tests_out" 2>&1 || tests_rc=$?
		cat "$tests_out"
	fi
	if [ -n "$script_files" ]; then
		mkdir -p "$ARCHIVE_DIR/var/agent-tmp"
		script_rc=0
		# Intentional word splitting: newline/space-separated repo paths with no spaces.
		# shellcheck disable=SC2086,SC2016
		(
			cd "$ARCHIVE_DIR"
			export TMPDIR="$ARCHIVE_DIR/var/agent-tmp"
			heavy_step script-tests sh -c 'ran=0; failed=0
				for suite; do
					case "$suite" in *.py) runner=python3 ;; *) runner=sh ;; esac
					if "$runner" "$suite"; then echo "GREEN script-suite $suite"; else echo "RED script-suite $suite rc=$?"; failed=$((failed + 1)); fi
					ran=$((ran + 1))
				done
				echo "script suites: ran=$ran fail=$failed"
				[ "$failed" -eq 0 ]' sh $script_files
		) >"$scripts_out" 2>&1 || script_rc=$?
		cat "$scripts_out"
		[ "$tests_rc" -ne 0 ] || tests_rc=$script_rc
	fi
	queued_after=$(awk '{ s += $1 } END { printf "%d", s }' "$WORK/queued.secs")
	echo "$(($(date +%s) - tests_started - (queued_after - queued_before)))" >>"$WORK/tests.secs"
	# bun's summary: " N pass", " N fail", "Ran N test(s) across M file(s)." A bun selection that ran
	# no test is not a pass, whatever its exit status. Each shell or python suite counts as one run.
	bun_ran=$(awk '$1 == "Ran" && ($3 == "test" || $3 == "tests") && $4 == "across" { print $2 }' "$tests_out" | tail -n 1)
	failed=$(awk 'NF == 2 && $2 == "fail" { print $1 }' "$tests_out" | tail -n 1)
	script_ran=$(awk '$1 == "script" && $2 == "suites:" { sub("ran=", "", $3); print $3 }' "$scripts_out" | tail -n 1)
	ran=$((${bun_ran:-0} + ${script_ran:-0}))
	echo "affected tests: files=$files ran=$ran fail=${failed:-0} rc=$tests_rc"
	record_run "$ran" "$files" "$tests_rc"
	if [ "$tests_rc" -ne 0 ]; then
		echo "FRESH-GATE: RED: affected tests did not pass (exit $tests_rc); the push is refused" >&2
		return "$tests_rc"
	fi
	if [ "$bun_files" -gt 0 ] && [ "${bun_ran:-0}" -eq 0 ]; then
		echo "FRESH-GATE: RED: $bun_files affected bun test files were selected but bun reported no test run" >&2
		return 1
	fi
	echo "FRESH-GATE: VERDICT TESTED files=$files ran=$ran"
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

# One JSON line per gate that reaches test selection, in the pushing repo's git dir, so a run of
# pushes shows how many tests each gate ran (CIGATE1 live acceptance). Off when FRESH_GATE_LEDGER is
# empty (fixture probes, a stock clone without a git dir).
record_run() {
	[ -n "${FRESH_GATE_LEDGER:-}" ] || return 0
	mkdir -p "$(dirname "$FRESH_GATE_LEDGER")" 2>/dev/null || return 0
	printf '{"ts":"%s","commit":"%s","base":"%s","changed":%s,"selected_files":%s,"tests_ran":%s,"rc":%s}\n' \
		"$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$COMMIT" "${BASE:-}" "$(printf '%s\n' "$CHANGED" | grep -c .)" "$2" "$1" "$3" >>"$FRESH_GATE_LEDGER" 2>/dev/null || true
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
		if (cd "$ARCHIVE_DIR" && bun run --no-env-file --config=/dev/null tests/live/lib.mjs coverage rules/) >"$live_out" 2>&1; then
			echo "live coverage: OK"
		else
			cat "$live_out"
			live_bad=0
			for file in $CHANGED; do
				case "$file" in
					rules/*.md)
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
	# Explicit mappings above join the import-scan selection; each runs once.
	# shellcheck disable=SC2086
	focus_tests=$(printf '%s\n' $affected $focus_tests | sort -u)
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
			# shellcheck disable=SC2086
			echo "FRESH-GATE: REFUSED reason=NO_AFFECTED_TESTS code=$(printf '%s\n' $code | paste -sd , -): the push changes product code and no test reaches it; add or name a test that exercises it" >&2
			return 1
		fi
		record_run 0 0 0
		echo "FRESH-GATE: VERDICT DOCS_ONLY: no product code changed; no suite to run"
	fi
}

cleanup() {
	if [ "$OWN_WORK" = 1 ] && [ -n "$WORK" ]; then
		rm -rf "$WORK" 2>/dev/null || true
	fi
}
make_work() {
	WORK_PARENT="$ROOT/var/agent-tmp"
	mkdir -p "$WORK_PARENT"
	WORK=$(mktemp -d "$WORK_PARENT/fresh-gate.XXXXXX")
	printf 'pid=%s\nlabel=fresh-gate\nrepo=%s\ncreated=%s\n' "$$" "$ROOT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$WORK/.owner"
	OWN_WORK=1
	trap cleanup EXIT HUP INT TERM
}

selftest() {
	require_gate_functions
	echo "FRESH-GATE SELFTEST: GREEN"
}

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
# ompkit-hecp: the harness resolves repo-relative case paths against OMP_KIT_CASE_CWD; the
# archive lives under var/agent-tmp, so without this every case path looks like scratch.
: "${OMP_KIT_CASE_CWD:=$ROOT}"
export OMP_KIT_CASE_CWD
# CIGATE1 ledger: the pushing checkout's own git dir (never committed, never shared). An explicit
# FRESH_GATE_LEDGER (including empty, which turns it off) wins.
if [ -z "${FRESH_GATE_LEDGER+set}" ]; then
	ledger_git=$(git -C "$OMP_KIT_CASE_CWD" rev-parse --absolute-git-dir 2>/dev/null) || ledger_git=
	FRESH_GATE_LEDGER=${ledger_git:+$ledger_git/omp-kit/fresh-gate-runs.jsonl}
fi
disk_pressure_flag
started=$(date +%s)
run_step manifest gate_manifest || exit 1
run_step cli-compile gate_cli_compile || exit 1
run_step harness-gate gate_harness || exit 1
run_step notes gate_notes || exit 1
run_step readme gate_readme || exit 1
run_step focused gate_focused || exit 1
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
judge_budget "$elapsed" "$tests" "$queued" || exit 1
