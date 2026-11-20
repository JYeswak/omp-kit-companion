#!/bin/sh
# Original RETIRESHIPPED1 replay; the real installer cases also run in the Bun CLI suite.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd -P)
exec bun test "$ROOT/tests/cli/hook-retirement-shipped.test.ts"
