#!/bin/sh
# check-tap-owner.sh — RT1 Homebrew slice 4/4 (ompkit-rc-epic-land-fix-release-dogfood-rz5.59.4.4).
#
# Owner gate: before any tap or formula is published, the distribution
# account recorded for the tap must match the tap being published to.
# The record lives in config/homebrew-tap.json (tap + owner + provenance
# bead); publication without a matching record is refused with exit 4.
# A formula is a delivery path; it never changes what the kit does (No-Claim).
#
#   check-tap-owner.sh check --tap OWNER/REPO [--record PATH]
#     exit 0: record names this tap with a non-empty owner.
#     exit 4: missing record, unparseable record, empty owner, or owner/tap mismatch.
set -u
cmd=${1:-}; shift || true
[ "$cmd" = "check" ] || { echo "usage: check-tap-owner.sh check --tap OWNER/REPO [--record PATH]" >&2; exit 2; }
tap=""; record="config/homebrew-tap.json"
while [ $# -gt 0 ]; do
	case "$1" in
		--tap) tap=${2:-}; shift 2 ;;
		--record) record=${2:-}; shift 2 ;;
		*) echo "check-tap-owner: unknown argument: $1" >&2; exit 2 ;;
	esac
done
case "$tap" in */*) ;; *) echo "check-tap-owner: --tap must be OWNER/REPO" >&2; exit 2 ;; esac
[ -f "$record" ] || { echo "check-tap-owner: no owner record $record; refusing publication" >&2; exit 4; }
command -v jq >/dev/null 2>&1 || { echo "check-tap-owner: jq is required" >&2; exit 3; }
recorded_tap=$(jq -er '.tap // empty' "$record" 2>/dev/null) || { echo "check-tap-owner: record names no tap" >&2; exit 4; }
recorded_owner=$(jq -er '.owner // empty' "$record" 2>/dev/null) || { echo "check-tap-owner: record names no owner" >&2; exit 4; }
case "$recorded_owner" in ""|*[!A-Za-z0-9-]*) echo "check-tap-owner: record owner is empty or malformed" >&2; exit 4 ;; esac
tap_owner=${tap%%/*}
[ "$recorded_owner" = "$tap_owner" ] || { echo "check-tap-owner: record owner $recorded_owner does not own tap $tap" >&2; exit 4; }
[ "$recorded_tap" = "$tap" ] || { echo "check-tap-owner: record tap $recorded_tap does not match $tap" >&2; exit 4; }
printf 'TAP_OWNER=verified tap=%s owner=%s\n' "$tap" "$recorded_owner"
exit 0
