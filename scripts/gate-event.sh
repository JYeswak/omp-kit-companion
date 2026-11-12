#!/bin/sh
# gate-event.sh ACT TARGET GATE KIND [ATTEMPT [DETAIL]]: append one row to the gate-events ledger
# (GATEEVENTS1, ompkit-fp72.135.3.12; plan section 23.4). Same row shape as extensions/gate-events.ts:
# {ts, seat, act, target, gate, kind, repo, member, started_at, duration_s, detail}. Best effort: never fails the caller, never prints.
# Seat: BR_ACTOR, BR_AGENT_NAME or AGENT_NAME, else null. Writes go through kitlib_jsonl.py beside
# this script (the installed hooks dir ships it) so the lock and torn-tail contract match the TypeScript half.
# Runners supply OMP_KIT_GATE_EVENT_STARTED_EPOCH/STARTED_MONO/FINISHED_MONO; direct recorder calls have zero duration.
set -u
[ "$#" -ge 4 ] || exit 0
act=$1 target=$2 gate=$3 kind=$4 attempt=${5:-} detail=${6:-}
seat=${BR_ACTOR:-${BR_AGENT_NAME:-${AGENT_NAME:-}}}
state=${XDG_STATE_HOME:-$HOME/.local/state}
ledger=$state/omp-kit/gate-events.jsonl
# A fixture repo (tests install the chain into owned scratch) never writes the LIVE ledger: the fresh
# gate's installer selftests put 2,200 fixture rows there on 2026-10-25. With XDG_STATE_HOME set the
# ledger is the caller's own, so isolated e2e replays still record.
# The hook installer probes the chain it just installed (an install, not an agent act): it sets this
# and no row is written (the probe wrote a real refuse row per install on 2026-10-25, PeachLeopard 68972).
[ -z "${OMP_KIT_GATE_EVENTS_SKIP:-}" ] || exit 0
if [ -z "${XDG_STATE_HOME:-}" ]; then
	# LEDGERFIXTURE1 (ompkit-1ra0d.194): compare the PHYSICAL cwd too. On macOS TMPDIR names /var/folders/...
	# while a hook's cwd reads /private/var/folders/..., so the TMPDIR match missed and an affected-gate test
	# put 42 fixture refusals into the live ledger in one day. No agent works in a repo under system temp.
	cwd_real=$(pwd -P 2>/dev/null) || cwd_real=$PWD
	tmp_real=
	[ -z "${TMPDIR:-}" ] || tmp_real=$(CDPATH='' cd -- "$TMPDIR" 2>/dev/null && pwd -P) || tmp_real=  # tempsafe: resolves TMPDIR to compare the cwd, creates nothing
	for cwd in "$PWD" "$cwd_real"; do
		case "$cwd" in */var/agent-tmp/* | /tmp | /tmp/* | /private/tmp | /private/tmp/* | /var/folders/* | /private/var/folders/*) exit 0 ;; esac  # tempsafe: matches the cwd against system temp roots, creates nothing
		for tmp in "${TMPDIR:-}" "$tmp_real"; do  # tempsafe: compares the cwd against TMPDIR, creates nothing
			case "$tmp" in ?*) case "$cwd" in "${tmp%/}"/*) exit 0 ;; esac ;; esac
		done
	done
fi
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
[ -f "$here/kitlib_jsonl.py" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0
# The KL08 lock refuses a permissive state dir: create it private, like the TypeScript writer.
(umask 077 && mkdir -p "$state/omp-kit") 2>/dev/null || exit 0
# Hook arguments follow the six ledger fields; hand them straight to Python, never shell-evaluate.
if [ "$#" -ge 6 ]; then shift 6; else set --; fi
GATE_EVENT_LEDGER=$ledger GATE_EVENT_SEAT=$seat GATE_EVENT_ACT=$act GATE_EVENT_TARGET=$target \
GATE_EVENT_GATE=$gate GATE_EVENT_KIND=$kind GATE_EVENT_ATTEMPT=$attempt GATE_EVENT_DETAIL=$detail \
python3 "$here/gate_event_replay.py" "$@" >/dev/null 2>&1 || exit 0
exit 0
