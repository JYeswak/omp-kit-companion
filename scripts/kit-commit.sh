#!/bin/sh
# GITLOCK1: trampoline onto the per-checkout commit serializer. The interpreter
# and payload are fixed here by static name; the target repo travels as
# --repo (the wrapper chdirs there itself), so callers never interpolate an
# executable path and the wrapper never depends on caller cwd.
cd "$(dirname "$0")" || exit 1
exec python3 ./kit-commit.py "$@"
