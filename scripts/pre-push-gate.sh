#!/bin/sh
# Git pre-push stdin adapter for scripts/fresh-gate.sh.
# The gate is always executed from the exact commit archive, never the working tree.
set -eu
ROOT=$(git rev-parse --show-toplevel)
IFS=' '
read -r local_ref local_sha remote_ref remote_sha || exit 0
: "${remote_ref:-}"
# An inherited FRESH_GATE_SKIP_REGEX must never leak into a main judgment: a
# caller-side export would otherwise skip the regex budget on main. Clear it
# first, then set it only for scratch measurement refs.
unset FRESH_GATE_SKIP_REGEX
# ttsr-harness resolves repo-relative case paths against OMP_KIT_CASE_CWD (76a722f2). The
# archive below lives under var/agent-tmp, so without this every case path looks like scratch
# and scratch-is-not-a-home fires on real repo files (cases 375/376 RED, 2026-10-08).
export OMP_KIT_CASE_CWD="$ROOT"
# Scratch measurement refs skip ONLY the regex-budget judgment (the budget is
# judged on CI for the release candidate); every other check still runs, and
# main pushes are still fully judged.
case "${remote_ref:-}" in
	refs/heads/scratch/*) export FRESH_GATE_SKIP_REGEX="scratch measurement ref; main pushes still judged" ;;
esac
case "${local_ref:-}" in
	''|delete|*:delete) exit 0 ;;
esac
case "${local_sha:-}" in
	''|0000000000000000000000000000000000000000) exit 0 ;;
esac
case "${remote_sha:-}" in
	0000000000000000000000000000000000000000|'')
		base=$(git -C "$ROOT" rev-list --max-parents=0 "$local_sha" | tail -n 1)
		if git -C "$ROOT" cat-file -e "$base^" 2>/dev/null; then base_ref=$base; else base_ref=; fi
		;;
	*) base_ref=$remote_sha ;;
esac
archive=$(mktemp -d "$ROOT/var/agent-tmp/pre-push-gate.XXXXXX")
base_archive=""
cleanup() {
	for dir in "$archive" ${base_archive:+"$base_archive"}; do
		find "$dir" -type f -delete 2>/dev/null || true
		find "$dir" -depth -type d -empty -delete 2>/dev/null || true
	done
}
trap cleanup EXIT HUP INT TERM
git -C "$ROOT" archive "$local_sha" | tar -xf - -C "$archive"
set -- --archive-dir "$archive"
if [ -n "${base_ref:-}" ]; then
	changed=$(git -C "$ROOT" diff --name-only "$base_ref" "$local_sha")
else
	changed=$(git -C "$ROOT" diff-tree --root --no-commit-id --name-only -r "$local_sha")
fi
while IFS= read -r path; do
	[ -n "$path" ] && set -- "$@" --changed-file "$path"
done <<EOF
$changed
EOF
gate_scripts="$archive"
if [ -n "${base_ref:-}" ]; then
	base_archive=$(mktemp -d "$ROOT/var/agent-tmp/pre-push-gate-base.XXXXXX") || { printf 'pre-push-gate: cannot stage base archive\n' >&2; exit 1; }
	git -C "$ROOT" archive "$base_ref" | tar -xf - -C "$base_archive" || { printf 'pre-push-gate: cannot extract base archive\n' >&2; exit 1; }
	gate_scripts="$base_archive"
fi
if [ -n "${base_ref:-}" ]; then
	merge_base=$(git -C "$ROOT" merge-base "$local_sha" "$base_ref") || { printf 'pre-push-gate: cannot find merge base\n' >&2; exit 1; }
	if [ "$merge_base" != "$base_ref" ]; then
		land_paths=$(git -C "$ROOT" diff --name-only "$base_ref" "$local_sha") || { printf 'pre-push-gate: cannot list pushed paths\n' >&2; exit 1; }
		if [ -n "$land_paths" ]; then
			# shellcheck disable=SC2086
			bun run --no-env-file --config=/dev/null "$gate_scripts/src/land-guard.ts" --repo "$ROOT" --base "$merge_base" --tip "$base_ref" --tree "$local_sha" --paths $land_paths || exit 1
		fi
	fi
fi
if [ -n "${base_ref:-}" ]; then
	python3.11 "$gate_scripts/scripts/regexploit-gate.py" --base "$base_ref" --head "$local_sha"
else
	python3.11 "$gate_scripts/scripts/regexploit-gate.py" --head "$local_sha"
fi
# Exercise the committed checker contracts before running the candidate tree's gate.
mkdir -p "$gate_scripts/var/agent-tmp"
for checker_test in \
	publishability.test.sh \
	doc-drift.test.sh \
	derived-check.test.sh \
	dispatch-check.test.sh \
	br-shim.test.sh \
	public-files.test.sh \
	commit-msg-bead.test.sh \
	check-pushed-beads.test.sh
do
	test_path="$gate_scripts/tests/cli/$checker_test"
	if [ ! -f "$test_path" ]; then
		printf 'pre-push-gate: missing checker contract %s\n' "$checker_test" >&2
		exit 1
	fi
	printf '== checker-contract %s\n' "$checker_test"
	if TMPDIR="$gate_scripts/var/agent-tmp" sh "$test_path"; then
		printf 'GREEN checker-contract %s\n' "$checker_test"
	else
		rc=$?
		# GATE2: a contract red on the base tree is judged from the candidate
		# tree. The loop, the regexploit gate and fresh-gate.sh still come
		# from base; only this one rerun executes the candidate's test file.
		cand_path="$archive/tests/cli/$checker_test"
		if [ -n "${base_ref:-}" ] && [ -f "$cand_path" ]; then
			mkdir -p "$archive/var/agent-tmp"
			if TMPDIR="$archive/var/agent-tmp" sh "$cand_path" >/dev/null 2>&1; then
				printf 'BASE-RED checker-contract %s: base rc=%s, candidate green\n' "$checker_test" "$rc"
				continue
			fi
		fi
		printf 'RED checker-contract %s producer_rc=%s\n' "$checker_test" "$rc" >&2
		exit "$rc"
	fi
done
# COMMIT1: every pushed non-merge commit names a bead id that exists in the
# repo tracker. Reads git objects only, so commit-tree landings are checked.
# Skipped until the base archive carries the checker (first landing).
if [ ! -f "$gate_scripts/scripts/check-pushed-beads.sh" ]; then
	printf 'SKIP pushed-bead-ids: checker absent from base archive\n' >&2
elif [ -n "${base_ref:-}" ]; then
	printf '== pushed-bead-ids\n'
	if sh "$gate_scripts/scripts/check-pushed-beads.sh" --repo "$ROOT" --base "$base_ref" --tip "$local_sha"; then
		printf 'GREEN pushed-bead-ids\n'
	else
		rc=$?
		printf 'RED pushed-bead-ids producer_rc=%s\n' "$rc" >&2
		exit "$rc"
	fi
else
	printf 'SKIP pushed-bead-ids: no base to range against\n' >&2
fi
# FLY2-3: every pushed non-merge commit must import only files present in its
# own tree. Skipped until the base archive carries the checker (first landing).
if [ ! -f "$gate_scripts/scripts/check-commit-imports.sh" ]; then
	printf 'SKIP commit-imports: checker absent from base archive\n' >&2
elif [ -n "${base_ref:-}" ]; then
	printf '== commit-imports\n'
	if sh "$gate_scripts/scripts/check-commit-imports.sh" --repo "$ROOT" --base "$base_ref" --tip "$local_sha"; then
		printf 'GREEN commit-imports\n'
	else
		rc=$?
		printf 'RED commit-imports producer_rc=%s\n' "$rc" >&2
		exit "$rc"
	fi
else
	printf 'SKIP commit-imports: no base to range against\n' >&2
fi
# PUB1a: a push that changes the CLI surface without touching its docs is
# refused, naming the undocumented surface. Skipped until the base archive
# carries the checker (first landing).
if [ ! -f "$gate_scripts/scripts/doc-drift-check.sh" ]; then
	printf 'SKIP doc-drift: checker absent from base archive\n' >&2
elif [ -n "${base_ref:-}" ]; then
	printf '== doc-drift\n'
	if sh "$gate_scripts/scripts/doc-drift-check.sh" "$base_ref" "$local_sha" "$ROOT"; then
		printf 'GREEN doc-drift\n'
	else
		rc=$?
		printf 'RED doc-drift producer_rc=%s\n' "$rc" >&2
		exit "$rc"
	fi
else
	printf 'SKIP doc-drift: no base to range against\n' >&2
fi
exec sh "$gate_scripts/scripts/fresh-gate.sh" "$@"
