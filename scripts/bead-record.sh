#!/bin/sh
# bead-record.sh — HOOKDEDUP1 (ompkit-1ra0d.60) post-commit member.
# Copies the commit-time bead PASS verdict (written by the commit-msg member)
# to a record keyed by the exact new commit sha under
# <git-common-dir>/omp-kit/bead-verdicts/, so the pre-push and
# reference-transaction members reuse it instead of re-running `br` per
# commit. Installed as the executable chain member
# hooks.d/post-commit/50-omp-kit-bead-record; the shared judge sits beside it,
# non-executable. Git calls post-commit with no arguments. Never refuses: the
# exit code is always 0 and any failure simply leaves no record, so the push
# falls back to today's live `br` check.
set -u
HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
if [ -f "$HERE/commit-msg-bead.sh" ]; then
	sh "$HERE/commit-msg-bead.sh" --record >/dev/null 2>&1 || true
fi
exit 0
