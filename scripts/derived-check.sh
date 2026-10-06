#!/bin/sh
# derived-check.sh — DERIVE1 literal-fact scan
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.119).
# Config and registry files hold only human decisions (who and when); any fact
# a probe can read live (versions, paths, counts, pids) is derived at run time.
# This check flags literal probe-readable facts in the given files, each with
# the probe that should replace it. Lines carrying a decision reason
# (reason/why/decision) and probe invocations stay quiet.
# Prints file:line findings; exit 1 on findings, 0 when clean.
# Usage: derived-check.sh FILE...
set -u

if [ $# -eq 0 ]; then
	printf 'derived: no files given (usage: derived-check.sh FILE...)\n' >&2
	exit 2
fi

TMP_FINDINGS=$(mktemp "${TMPDIR:-/tmp}/derived.XXXXXX") || exit 2
trap 'rm -f "$TMP_FINDINGS"' EXIT INT TERM

for file in "$@"; do
	[ -f "$file" ] || continue
	# Decision lines and probe calls are quiet.
	grep -vEi -- 'reason|why|decision|probe|\$\(|`' "$file" 2>/dev/null > "$TMP_FINDINGS.clean" || continue
	{
		# Version pins: omp --version, bun --version, node --version.
		grep -HnE --label="$file" 'version[ _:=]+"?[0-9]+\.[0-9]+' "$TMP_FINDINGS.clean" 2>/dev/null | sed 's/^/version: probe omp --version: /'
		# Absolute paths: enumerate live, never copy.
		grep -HnE --label="$file" '/Users/[^ /:]+|/home/[^ /:]+' "$TMP_FINDINGS.clean" 2>/dev/null | grep -v '/Users/Shared/' | sed 's/^/path: probe live enumeration: /'
		# Hard-coded counts: count live (profiles, rules, agents).
		grep -HnEi --label="$file" '(profiles|rules|agents|workers|beads)[ _:=-]+[0-9]+' "$TMP_FINDINGS.clean" 2>/dev/null | sed 's/^/count: probe live count: /'
		# Pid and lease values: read live, never stored.
		grep -HnEi --label="$file" '(^|[^A-Za-z])(pid|lease|inode)[ _:=-]+[0-9]+' "$TMP_FINDINGS.clean" 2>/dev/null | sed 's/^/pid: probe live process state: /'
	} >> "$TMP_FINDINGS" 2>/dev/null
done

if [ -s "$TMP_FINDINGS" ]; then
	sort -u "$TMP_FINDINGS"
	printf 'derived: FAIL (%s finding(s))\n' "$(wc -l < "$TMP_FINDINGS" | tr -d ' ')" >&2
	exit 1
fi
printf 'derived: OK\n'
