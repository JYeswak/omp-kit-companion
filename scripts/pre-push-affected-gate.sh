#!/bin/sh
# KITGATE1: inert without a committed affected-test declaration; never reads dirty code.
set -eu
here=$(CDPATH='' cd -- "$(dirname "$0")" && pwd -P)
root=$(git rev-parse --show-toplevel)
cd "$here" || exit 1
# Static script path: the staged gate judges dynamic python arguments unjudgeable.
PYTHONDONTWRITEBYTECODE=1 exec python3 ./declared-affected-gate.py --repo "$root"
