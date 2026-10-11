#!/bin/sh
# Block a commit whose staged blobs contain any Infisical secret value (ompkit-l8h5).
# Runs `omp-kit doctor --scope secrets --staged`: staged tokens are hashed and compared with sha256
# digests of every readable vault value; findings name the file and the vault NAME, never a value.
# Infisical unreachable: warns and lets the commit through (the scan did not run; it says so).
#
# Install (plain hooks dir):  cp scripts/pre-commit-secret-scan.sh "$(git rev-parse --git-path hooks)/pre-commit"
# Agent Mail chain runner:    cp scripts/pre-commit-secret-scan.sh "$(git rev-parse --git-path hooks)/hooks.d/pre-commit/20-omp-kit-secret-scan"
# OMP_KIT_BIN overrides the omp-kit command (tests run the checkout CLI through it).
set -u
bin=${OMP_KIT_BIN:-omp-kit}
if ! command -v "${bin%% *}" >/dev/null 2>&1; then
	echo "pre-commit-secret-scan: WARNING: $bin not found; staged blobs were NOT scanned for vault values" >&2
	exit 0
fi
# shellcheck disable=SC2086 # OMP_KIT_BIN may be "bun /path/cli.ts".
$bin doctor --scope secrets --staged >&2
status=$?
case $status in
	0) exit 0 ;;
	1) echo "pre-commit-secret-scan: BLOCKED: staged file(s) above hold a vault secret value. Unstage it, source the value with cf-secret NAME at point of use, rotate it." >&2; exit 1 ;;
	3) echo "pre-commit-secret-scan: WARNING: Infisical unreachable or scan incomplete; commit NOT verified free of vault values" >&2; exit 0 ;;
	*) echo "pre-commit-secret-scan: WARNING: secret scan failed to run (exit $status); commit NOT verified" >&2; exit 0 ;;
esac
