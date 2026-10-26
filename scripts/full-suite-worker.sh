#!/bin/sh
# Phase executor for full-suite-verdict.sh. The caller owns the native Bun
# system-shell supervisor; this worker never publishes an aggregate verdict.
# shellcheck disable=SC2086
set -eu
ARCHIVE_DIR=$1
ROOT=$2
SCRIPT_DIR=$3
BUN_OUT=$4
SUITE_STATUS=$5
SUITE_OUT=$6
bun_count=$7
kept_bun=$8
kept_shell=$9
shift 9
kept_py=$1
# Bun's package-script launcher prepends node_modules/.bin. Tests retain the
# caller's original command lookup, not the supervisor's package environment.
PATH=$2
export PATH
(
	# Tests choose their own tracker, never the publisher's database.
	unset BEADS_DB
	cd "$ARCHIVE_DIR"
	export OMP_KIT_DISK_OBSERVER=statfs
	export KITLIB_TMP_ROOT="$ARCHIVE_DIR/var/agent-tmp"
	mkdir -p "$KITLIB_TMP_ROOT"
	# shellcheck disable=SC1091
	. "$ARCHIVE_DIR/scripts/kitlib-tmp.sh"
	kitlib_tmp TMPDIR full-suite-run || exit 1
	export TMPDIR
	export OMP_KIT_CASE_CWD="$ROOT"
	if [ -f "$ARCHIVE_DIR/bunfig.toml" ]; then
		export BUN_CONFIG_FILE="$ARCHIVE_DIR/bunfig.toml"
		bun_config="--config=$ARCHIVE_DIR/bunfig.toml"
	else
		bun_config=""
	fi
	# Preserve foreground signal dispositions, including nested signal tests.
	dfl() {
		python3 -c 'import os, signal, sys
for sig in (signal.SIGINT, signal.SIGQUIT):
    signal.signal(sig, signal.SIG_DFL)
os.execvp(sys.argv[1], sys.argv[1:])' "$@"
	}
	failed=0
	if [ "$bun_count" -gt 0 ]; then
		bun_rc=0
		workers=$(sh "$SCRIPT_DIR/fresh-gate.sh" --test-workers) || exit 1
		case "$workers" in ''|*[!0-9]*|0) exit 1 ;; esac
		[ "$workers" -le "$bun_count" ] || workers=$bun_count
		[ "$workers" -le 4 ] || workers=4
		set -- --parallel="$workers" $kept_bun
		if [ -f "$ARCHIVE_DIR/.github/core-test-timings.json" ]; then
			set -- --timings="$ARCHIVE_DIR/.github/core-test-timings.json" "$@"
		fi
		if [ -n "$bun_config" ]; then
			dfl nice -n 10 bun "$bun_config" test --timeout=120000 --path-ignore-patterns 'var/agent-tmp/**' "$@" >"$BUN_OUT" 2>&1 || bun_rc=$?
		else
			dfl nice -n 10 bun test --timeout=120000 --path-ignore-patterns 'var/agent-tmp/**' "$@" >"$BUN_OUT" 2>&1 || bun_rc=$?
		fi
		cat "$BUN_OUT"
		echo "BUN rc=$bun_rc" >>"$SUITE_STATUS"
		[ "$bun_rc" -eq 0 ] || failed=1
	fi
	for suite in $kept_shell; do
		if dfl sh "$suite"; then
			echo "GREEN script-suite $suite"; echo "GREEN script-suite $suite" >>"$SUITE_STATUS"
		else
			src=$?; echo "RED script-suite $suite rc=$src"; echo "RED script-suite $suite" >>"$SUITE_STATUS"; failed=1
		fi
	done
	for suite in $kept_py; do
		if dfl python3 "$suite"; then
			echo "GREEN python-suite $suite"; echo "GREEN python-suite $suite" >>"$SUITE_STATUS"
		else
			src=$?; echo "RED python-suite $suite rc=$src"; echo "RED python-suite $suite" >>"$SUITE_STATUS"; failed=1
		fi
	done
	exit "$failed"
) >>"$SUITE_OUT" 2>&1
