#!/bin/sh
# check-push-identity.sh — PUSHIDENTITY1 (ompkit-fp72.135.3.75).
#
# Resolve the pushing seat's identity BEFORE the pre-push gate judges anything.
# The pre-push adapter runs this as its first stage: an unidentified push is
# refused here, with its remedy, instead of failing deep in the gate.
#
# Resolution order mirrors extensions/kit-seat-identity.ts:
#   1. AGENT_NAME, when set and shaped like a seat name;
#   2. this process's Tern pane identity files
#      ($HOME/.config/agent-mail/identity/<project>/tern-<pane>), when they
#      name exactly one seat.
# Anything else refuses with exit 3 and a remedy on stderr. Success prints
# `seat=<name>` on stdout and exits 0.
#
# Reads only small local identity files (head-capped, one JSON file per pane
# binding at most); creates no temp files, spawns no services, waits on nothing.
set -u

# Seat names: letters and digits, 1-64 chars (SEATNAME1, ompkit-d5cd5).
valid_name() {
	case "$1" in
		'' | *[!A-Za-z0-9]*) return 1 ;;
	esac
	[ "${#1}" -le 64 ]
}

trim() {
	trimmed=$1
	trimmed=${trimmed#"${trimmed%%[![:space:]]*}"}
	trimmed=${trimmed%"${trimmed##*[![:space:]]}"}
	printf '%s' "$trimmed"
}

REMEDY='push from an identified seat (export AGENT_NAME=<seat>), or register this pane with Agent Mail so ~/.config/agent-mail/identity/<project>/tern-<pane> names it'

refuse() {
	printf 'RED push-identity: %s; refusing the push before the gate. Remedy: %s\n' "$1" "$REMEDY" >&2
	exit 3
}

# 1. AGENT_NAME wins, as in every other guard.
if [ -n "${AGENT_NAME-}" ]; then
	name=$(trim "$AGENT_NAME")
	if valid_name "$name"; then
		printf 'seat=%s\n' "$name"
		exit 0
	fi
	refuse 'AGENT_NAME is set but is not a seat name'
fi

# 2. Tern pane identity files.
pane=$(trim "${TERN_PANE-}")
case "$pane" in
	'') refuse 'AGENT_NAME is unset and there is no Tern pane to resolve' ;;
	*[!0-9]* | ?????????????????????*) refuse 'TERN_PANE is not a pane id' ;;
esac

if [ -z "${HOME:-}" ]; then
	refuse 'AGENT_NAME is unset and HOME is unset, so no pane identity file can be read'
fi
identity_root="$HOME/.config/agent-mail/identity"
if [ ! -d "$identity_root" ]; then
	refuse 'AGENT_NAME is unset and there is no Agent Mail identity directory'
fi

# One head-capped JSON read per candidate file at most; the capped text
# travels on argv so python never reads stdin. A missing python3 fails
# closed, since JSON bindings could not be judged.
if ! command -v python3 >/dev/null 2>&1; then
	refuse 'AGENT_NAME is unset and pane identity files need python3 to judge'
fi

json_name() {
	text=$(head -c 65536 "$1") || return 1
	python3 -B -c 'import json,sys
try:
	doc = json.loads(sys.argv[1])
except ValueError:
	raise SystemExit(1)
name = doc.get("name") if isinstance(doc, dict) else None
if not isinstance(name, str):
	raise SystemExit(1)
sys.stdout.write(name.strip())' "$text" || return 1
}

bare_name() {
	head -c 65536 "$1" | head -n 1
}

found_lower=''
found_show=''
found_n=0
for dir in "$identity_root"/*/; do
	[ -d "$dir" ] || continue
	file="${dir}tern-$pane"
	[ -f "$file" ] || continue
	[ -r "$file" ] || refuse "pane identity file $file is not readable"
	text=$(bare_name "$file")
	case "$text" in
		'{'*)
			name=$(json_name "$file") || refuse "pane identity file $file is not a readable seat binding"
			name=$(trim "$name") ;;
		*) name=$(trim "$text") ;;
	esac
	valid_name "$name" || refuse "pane identity file $file is not a readable seat binding"
	lower=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')
	case " $found_lower " in
		*" $lower "*) ;;
		*)
			found_lower="$found_lower $lower"
			found_n=$((found_n + 1))
			if [ "$found_n" -eq 1 ]; then
				found_show=$name
			elif [ "$found_n" -eq 2 ]; then
				second_show=$name
			fi ;;
	esac
done

if [ "$found_n" -eq 0 ]; then
	refuse "no identity file names tern-$pane"
fi
if [ "$found_n" -gt 1 ]; then
	refuse "tern-$pane is bound to more than one seat ($found_show, $second_show)"
fi
printf 'seat=%s\n' "$found_show"
