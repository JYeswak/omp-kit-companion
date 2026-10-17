#!/bin/sh
# check-suite-runtime.sh — FULLRED slice 4/4 (ompkit-lrbd.5): cli-contracts runtime guard.
# Usage: sh scripts/check-suite-runtime.sh [--budget-secs N] -- <command> [args...]
# Times the suite command and prints SUITE_RUNTIME_SECS=<n> on stdout.
# Verdict: elapsed >= budget exits 1 with RUNTIME_REGRESSION (a run near the
# limit is a regression, not a pass); otherwise the command's exit code is
# propagated. Default budget 1200s (20 min) against the 30-min CI timeout.
# Nothing here raises any timeout; the command's own timeout still applies.
set -u

budget=1200
while [ $# -gt 0 ]; do
	case "$1" in
		--budget-secs) budget="$2"; shift 2 ;;
		--budget-secs=*) budget="${1#--budget-secs=}"; shift ;;
		--) shift; break ;;
		-*) printf 'usage: %s [--budget-secs N] -- <command> [args...]\n' "$0" >&2; exit 2 ;;
		*) break ;;
	esac
done
if [ $# -eq 0 ]; then
	printf 'usage: %s [--budget-secs N] -- <command> [args...]\n' "$0" >&2
	exit 2
fi
case "$budget" in
	''|*[!0-9]*) printf 'check-suite-runtime: --budget-secs needs a non-negative integer\n' >&2; exit 2 ;;
esac

start=$(date +%s)
"$@"
rc=$?
end=$(date +%s)
elapsed=$((end - start))
printf 'SUITE_RUNTIME_SECS=%s\n' "$elapsed"
if [ "$elapsed" -ge "$budget" ]; then
	printf 'RUNTIME_REGRESSION: elapsed=%ss budget=%ss\n' "$elapsed" "$budget" >&2
	exit 1
fi
exit "$rc"
