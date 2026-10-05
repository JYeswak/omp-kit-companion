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
	python3.11 "$gate_scripts/scripts/regexploit-gate.py" --base "$base_ref" --head "$local_sha"
else
	python3.11 "$gate_scripts/scripts/regexploit-gate.py" --head "$local_sha"
fi
exec sh "$gate_scripts/scripts/fresh-gate.sh" "$@"
