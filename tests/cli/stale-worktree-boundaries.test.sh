#!/bin/sh
# Separate the real lock and indentation cases from the large history suite.
set -eu
suite=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/stale-worktree.test.sh
sh "$suite" -t STALELOCK1
sh "$suite" -t STALEMOVE1
