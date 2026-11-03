#!/bin/sh
# Keep each independent adapter contract family schedulable by the shared suite pool.
# Preserve one-hop affected-test edges for the shared fixture's production inputs:
# scripts/pre-push-gate.sh scripts/fresh-gate.sh scripts/check-commit-gate.sh
# scripts/full-suite-verdict.sh scripts/full-suite-verdict-store.py
# scripts/suite-metrics.py scripts/suite-hermetic-env.sh scripts/kitlib-tmp.sh
# scripts/kitlib_run.py scripts/kitlib_tmp.py scripts/pysafe.py
# scripts/regexploit-gate.py scripts/doc-drift-check.sh src/cli.ts src/land-guard.ts
# shellcheck source=tests/cli/pre-push-gate-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/pre-push-gate-fixtures.sh"
verdict_cases
printf 'pre-push-gate-verdict: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
