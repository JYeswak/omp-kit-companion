#!/bin/sh
set -eu
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
if [ "$#" -eq 0 ]; then
	repo=$(git rev-parse --show-toplevel)
	set -- --repo "$repo" --staged
fi
exec python3 -B "$script_dir/pysafe.py" run --timeout 300 -- python3 -B "$script_dir/portable_paths_check.py" "$@"
