#!/bin/sh
# Git pre-push stdin adapter for scripts/fresh-gate.sh.
# The gate is always executed from the exact commit archive, never the working tree.
set -eu
ROOT=$(git rev-parse --show-toplevel)
IFS=' '
read -r local_ref local_sha remote_ref remote_sha || exit 0
: "${remote_ref:-}"
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
exec sh "$gate_scripts/scripts/fresh-gate.sh" "$@"
