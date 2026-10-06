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
	for name in gate_manifest gate_cli_compile gate_harness gate_focused; do
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

gate_harness() {
	(
		cd "$ARCHIVE_DIR"
		bun run --no-env-file --config=/dev/null src/cli.ts heavy --label fresh-gate-harness -- bun scripts/ttsr-harness.ts --gate
	)
}
gate_cli_compile() {
	(
		cd "$ARCHIVE_DIR"
		bun run --no-env-file --config=/dev/null src/cli.ts heavy --label fresh-gate-cli-compile -- bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --no-compile-autoload-tsconfig src/cli.ts --outfile="$WORK/omp-kit-cli"
	)
}

append_changed() {
	CHANGED="$CHANGED
$1"
}
run_bun_suite() {
	suite=$1
	budget="${FRESH_GATE_SUITE_BUDGET_SECS:-25}"
	python3 - "$ARCHIVE_DIR" "$suite" "$budget" <<'PY'
import os
import signal
import subprocess
import sys

archive, suite, budget = sys.argv[1], sys.argv[2], float(sys.argv[3])
env = os.environ.copy()
env["BUN_CONFIG_FILE"] = os.path.join(archive, "bunfig.toml")
proc = subprocess.Popen(
    ["bun", "run", "--no-env-file", "--config=/dev/null", "src/cli.ts", "heavy", "--label", "fresh-gate-" + suite, "--no-wait", "--", "bun", "--config=" + os.path.join(archive, "bunfig.toml"), "test", "--timeout=120000", "--path-ignore-patterns", "var/agent-tmp/**", suite],
    cwd=archive,
    env=env,
    start_new_session=True,
)
try:
    rc = proc.wait(timeout=budget)
except subprocess.TimeoutExpired:
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
    print("deferred to CI: " + suite)
    raise SystemExit(124)
if rc == 75:
    print("deferred to CI: heavy-work admission: " + suite)
    raise SystemExit(124)
raise SystemExit(rc)
PY
	rc=$?
	if [ "$rc" -eq 124 ]; then
		return 0
	fi
	return "$rc"
}

gate_focused() {
	focus_tests=
	needs_cli=0
	needs_shell=0
	needs_actionlint=0
	needs_regex=0
	for file in $CHANGED; do
		[ -n "$file" ] || continue
		case "$file" in
			tests/cli/migrate.test.ts)
				focus_tests="$focus_tests tests/cli/migrate-history.test.ts" ;;
			tests/cli/migrate-history.test.ts|tests/cli/*.test.ts|tests/fleet-guard/*.test.ts)
				focus_tests="$focus_tests $file" ;;
			src/migrate.ts)
				focus_tests="$focus_tests tests/cli/migrate-history.test.ts" ;;
			src/kit-update.ts)
				focus_tests="$focus_tests tests/cli/kit-update.test.ts" ;;
			src/*|extensions/*)
				needs_cli=1 ;;
			scripts/*.sh|checkers/*.sh|installer/*.sh|tests/cli/*.sh|tests/e2e/*.sh)
				needs_shell=1 ;;
			.github/workflows/*.yml|.github/workflows/*.yaml)
				needs_actionlint=1 ;;
			rules/*.md)
				needs_regex=1 ;;
			esac
	done
	if [ "$needs_shell" = 1 ]; then
		if command -v shellcheck >/dev/null 2>&1; then
			for file in $CHANGED; do
				case "$file" in
					scripts/*.sh|checkers/*.sh|installer/*.sh|tests/cli/*.sh|tests/e2e/*.sh)
						shellcheck "$ARCHIVE_DIR/$file" ;;
				esac
			done
		else
			echo "focused shellcheck: unavailable; no shell files were executed"
		fi
	fi
	if [ "$needs_actionlint" = 1 ]; then
		if command -v actionlint >/dev/null 2>&1; then
			actionlint "$ARCHIVE_DIR/.github/workflows"/*.yml "$ARCHIVE_DIR/.github/workflows"/*.yaml
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
	if { [ -n "$focus_tests" ] || [ "$needs_cli" = 1 ]; } && [ ! -f "$ARCHIVE_DIR/MANIFEST.tsv" ]; then
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
		# Each suite has an independent budget; a timeout is a visible CI deferral, never a silent skip.
		# Intentional word splitting turns newline-separated test paths into argv entries.
		# shellcheck disable=SC2086
		set -- $focus_tests
		for suite in "$@"; do
			run_bun_suite "$suite" || return $?
		done
	elif [ "$needs_cli" = 1 ]; then
		run_bun_suite tests/cli || return $?
	else
		echo "focused suites: none selected for changed paths"
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
started=$(date +%s)
run_step manifest gate_manifest || exit 1
run_step cli-compile gate_cli_compile || exit 1
run_step harness-gate gate_harness || exit 1
run_step focused gate_focused || exit 1
elapsed=$(($(date +%s) - started))
if [ "$elapsed" -ge 180 ]; then
	fail "elapsed=${elapsed}s exceeds 180s"
	exit 1
fi
echo "FRESH-GATE: GREEN commit=$COMMIT elapsed=${elapsed}s"
