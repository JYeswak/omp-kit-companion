#!/bin/sh
# gate-event.sh ACT TARGET GATE KIND [ATTEMPT [DETAIL]]: append one row to the gate-events ledger
# (GATEEVENTS1, ompkit-fp72.135.3.12; plan section 23.4). Same row shape as extensions/gate-events.ts:
# {ts, seat, act, target, gate, kind, detail}. Best effort: never fails the caller, never prints.
# Seat: BR_ACTOR, BR_AGENT_NAME or AGENT_NAME, else null. Writes go through kitlib_jsonl.py beside
# this script (the installed hooks dir ships it) so the lock and torn-tail contract match the TypeScript half.
set -u
[ "$#" -ge 4 ] || exit 0
act=$1 target=$2 gate=$3 kind=$4 attempt=${5:-} detail=${6:-}
seat=${BR_ACTOR:-${BR_AGENT_NAME:-${AGENT_NAME:-}}}
state=${XDG_STATE_HOME:-$HOME/.local/state}
ledger=$state/omp-kit/gate-events.jsonl
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
[ -f "$here/kitlib_jsonl.py" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0
# The KL08 lock refuses a permissive state dir: create it private, like the TypeScript writer.
(umask 077 && mkdir -p "$state/omp-kit") 2>/dev/null || exit 0
GATE_EVENT_LEDGER=$ledger GATE_EVENT_SEAT=$seat GATE_EVENT_ACT=$act GATE_EVENT_TARGET=$target \
GATE_EVENT_GATE=$gate GATE_EVENT_KIND=$kind GATE_EVENT_ATTEMPT=$attempt GATE_EVENT_DETAIL=$detail \
python3 - "$here" >/dev/null 2>&1 <<'PY' || exit 0
import datetime, json, os, sys
sys.path.insert(0, sys.argv[1])
import kitlib_jsonl
row = {
    "ts": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "seat": os.environ.get("GATE_EVENT_SEAT") or None,
    "act": os.environ["GATE_EVENT_ACT"],
    "target": os.environ.get("GATE_EVENT_TARGET") or None,
    "gate": os.environ["GATE_EVENT_GATE"],
    "kind": os.environ["GATE_EVENT_KIND"],
}
detail = os.environ.get("GATE_EVENT_DETAIL", "")
attempt = os.environ.get("GATE_EVENT_ATTEMPT", "")
if attempt:
    row["attempt"] = attempt
if detail:
    row["detail"] = detail[:400]
ledger = os.environ["GATE_EVENT_LEDGER"]
kitlib_jsonl.append_jsonl(ledger, lambda _state: row, deadline_s=2, torn_tail="newline", state_dir=os.path.dirname(ledger))
PY
exit 0
