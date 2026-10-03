#!/bin/sh
# Git pre-push stdin adapter for scripts/fresh-gate.sh.
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
		if git -C "$ROOT" cat-file -e "$base^" 2>/dev/null; then
			base_ref=$base
		else
			base_ref=
		fi
		;;
	*) base_ref=$remote_sha ;;
esac
if [ -n "${base_ref:-}" ]; then
	exec "$ROOT/scripts/fresh-gate.sh" --commit "$local_sha" --base "$base_ref"
fi
exec "$ROOT/scripts/fresh-gate.sh" --commit "$local_sha"
