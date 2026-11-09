#!/bin/sh
# Acceptance entrypoint; implementation and portable fixture live in the companion.
set -eu
here=$(CDPATH='' cd -- "$(dirname "$0")" && pwd -P)
cd "$here" || exit 1
# Static script path: the staged gate judges dynamic python arguments unjudgeable.
PYTHONDONTWRITEBYTECODE=1 exec python3 ./affected_gate_test.py
