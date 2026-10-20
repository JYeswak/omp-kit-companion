#!/usr/bin/env bash
# E2E for CC4b guard receipts (bead ompkit-fp72.120.16.7.2): a real temp git
# repo plus a real temp br db; the real kit-flywheel-guard allows a non-author
# close (really executed) and the tool_execution_end emits exactly one
# closeguard bead.status receipt; a planted self-close is refused AND recorded;
# a planted error close emits nothing. Then the tracker diff plus the ingester
# run over the same state and bead_transitions holds both rows. Common
# per-step JSONL, non-zero exit when a planted failure is not detected.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${PYTHON:-python3}" "$here/cc_cc4b_guard_receipts.py" "$@"
