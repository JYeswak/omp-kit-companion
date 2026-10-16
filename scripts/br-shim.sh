#!/bin/sh
# br-shim.sh — ID1 identity, TRACKLEASE1 reservation and CREATEBUDGET1 create guards.
# Installed as `br` ahead of the real binary on an agent pane's PATH. Every
# invocation carries --actor "$AGENT_NAME": appended when absent, enforced when
# present. Mutations also require a registered Agent Mail identity and no
# foreign exclusive lease on the repo's tracker files.
# Real binary resolution: $BR_REAL, else the first `br` on PATH with this
# shim's own directory removed. Runtime dependencies: POSIX sh, awk, git, am; create guard uses python3 and omp-kit.
set -u

fail() {
	printf 'br-shim: %s\n' "$1" >&2
	exit 4
}

if [ -z "${AGENT_NAME:-}" ]; then
	fail "BR_SHIM_IDENTITY_REQUIRED refusing to run br without AGENT_NAME (pane identity not resolved at spawn)"
fi
shim_nl='
'
case "$AGENT_NAME" in
	*"$shim_nl"*) fail "BR_SHIM_IDENTITY_REQUIRED AGENT_NAME must be one line" ;;
esac

found=""
prev=""
for arg in "$@"; do
	if [ "$prev" = "--actor" ]; then
		found="$arg"
		prev=""
		continue
	fi
	case "$arg" in
		--actor) prev="--actor" ;;
		--actor=*) found="${arg#--actor=}" ;;
	esac
done
if [ -n "$found" ] && [ "$found" != "$AGENT_NAME" ]; then
	fail "BR_SHIM_ACTOR_MISMATCH refusing --actor $found for pane identity $AGENT_NAME"
fi

real="${BR_REAL:-}"
if [ -z "$real" ]; then
	self_dir=$(dirname -- "$0") || fail "BR_SHIM_NO_REAL_BR cannot resolve shim directory"
	case "$self_dir" in
		/*) ;;
		*) self_dir="$PWD/$self_dir" ;;
	esac
	rest=$(printf '%s' "${PATH:-}" | awk -v RS=: -v self="$self_dir" '$0 != self' | paste -sd: -) || fail "BR_SHIM_NO_REAL_BR cannot filter PATH"
	real=$(PATH="$rest" command -v br) || fail "BR_SHIM_NO_REAL_BR no real br beyond the shim on PATH"
fi
self_path=$0
case "$self_path" in
	/*) ;;
	*) self_path="$PWD/$self_path" ;;
esac
while [ -L "$self_path" ]; do
	link=$(readlink "$self_path") || break
	case "$link" in
		/*) self_path="$link" ;;
		*) self_path="$(dirname -- "$self_path")/$link" ;;
	esac
done
if [ "$real" = "$self_path" ]; then
	fail "BR_SHIM_LOOP refusing to exec the shim itself (no real br beyond it on PATH)"
fi
# SYNC1 box 4: run the close gate at review/grading entry. `br update ID
# --status in_review` and `br close ID` call close-guard.sh unchanged; its
# FAIL refuses the transition before a grader spends time on self-review.
# All other invocations pass through untouched.
 gate_sub=""; gate_id=""; gate_status=""; gate_db=""; gate_skip=0; gate_reason=""; gate_want_reason=0; gate_tcomment=""; gate_want_tcomment=0
 for gate_arg in "$@"; do
 	if [ "$gate_skip" = 1 ]; then
 		if [ "$gate_want_reason" = 1 ]; then gate_reason="$gate_arg"; gate_want_reason=0; fi
 		if [ "$gate_want_tcomment" = 1 ]; then gate_tcomment="$gate_arg"; gate_want_tcomment=0; fi
 		gate_skip=0; continue; fi
 	case "$gate_arg" in
 		--status|--db)
 			case "$gate_arg" in
 				--status) gate_status="next" ;;
 				--db) gate_db="next" ;;
 			esac ;;
 		--actor|-m|--message|--comment|--reason|-r|--transition-comment|--title)
 			gate_skip=1
 			case "$gate_arg" in
 				-m|--message|--comment|--reason|-r) gate_want_reason=1 ;;
 				--transition-comment) gate_want_tcomment=1 ;;
 			esac ;;
 		--actor=*|--db=*|--status=*|-m*|--message=*|--comment=*|--reason=|--transition-comment=*)
 			case "$gate_arg" in
 				--status=*) gate_status="${gate_arg#--status=}" ;;
 				--db=*) gate_db="${gate_arg#--db=}" ;;
 				--transition-comment=*) gate_tcomment="${gate_arg#--transition-comment=}" ;;
 				-m*|--message=*|--comment=*|--reason=*) gate_reason="${gate_arg#*=}"; gate_reason="${gate_reason#-m}" ;;
 			esac ;;
		-*) ;;
		*)
			if [ "$gate_status" = "next" ]; then gate_status="$gate_arg";
			elif [ "$gate_db" = "next" ]; then gate_db="$gate_arg";
			elif [ -z "$gate_sub" ]; then gate_sub="$gate_arg";
			elif [ -z "$gate_id" ]; then gate_id="$gate_arg"; fi ;;
	esac
done
tracker_write=0
case "$gate_sub" in
	create|update|close|reopen|delete) tracker_write=1 ;;
	comments) [ "$gate_id" = "add" ] && tracker_write=1 ;;
	dep|label)
		case "$gate_id" in add|remove) tracker_write=1 ;; esac
		;;
esac
if [ "$gate_sub" = "sync" ]; then
	sync_reconcile=0; sync_requires_apply=0; sync_apply=0; sync_dry_run=0
	for sync_arg in "$@"; do
		case "$sync_arg" in
			--flush-only|--import-only|--merge) tracker_write=1 ;;
			--reconcile) sync_reconcile=1 ;;
			--reconcile-additive|--migrate-source-repo-path) sync_requires_apply=1 ;;
			--apply) sync_apply=1 ;;
			--dry-run) sync_dry_run=1 ;;
		esac
	done
	if [ "$sync_reconcile" = 1 ] && [ "$sync_dry_run" = 0 ]; then tracker_write=1; fi
	if [ "$sync_requires_apply" = 1 ] && [ "$sync_apply" = 1 ]; then tracker_write=1; fi
fi
if [ "$tracker_write" = 1 ]; then
	tracker_db=${gate_db:-${BEADS_DB:-}}
	if [ -n "$tracker_db" ]; then
		case "$tracker_db" in
			/*) tracker_db_path=$tracker_db ;;
			*) tracker_db_path="$PWD/$tracker_db" ;;
		esac
		tracker_db_dir=$(dirname -- "$tracker_db_path") || fail "BR_SHIM_RESERVATION_UNKNOWN cannot resolve tracker database directory"
		if [ "$(basename -- "$tracker_db_dir")" = ".beads" ]; then
			tracker_project=$(CDPATH='' cd -- "$tracker_db_dir/.." && pwd) || fail "BR_SHIM_RESERVATION_UNKNOWN cannot resolve tracker project root"
		else
			tracker_project=$(git -C "$tracker_db_dir" rev-parse --show-toplevel 2>/dev/null) || fail "BR_SHIM_RESERVATION_UNKNOWN cannot resolve project root from tracker database"
		fi
	else
		tracker_project=$(git rev-parse --show-toplevel 2>/dev/null) || fail "BR_SHIM_RESERVATION_UNKNOWN cannot resolve tracker project root"
	fi
	tracker_db_path=${tracker_db_path:-"$tracker_project/.beads/beads.db"}
	identity_out=$(am agents show --project "$tracker_project" --json "$AGENT_NAME" 2>&1)
	identity_rc=$?
	[ "$identity_rc" -eq 0 ] || fail "BR_SHIM_RESERVATION_UNKNOWN Agent Mail cannot verify $AGENT_NAME in $tracker_project (rc=$identity_rc): $identity_out"
	conflict_out=$(am file_reservations conflicts "$tracker_project" .beads/issues.jsonl .beads/beads.db 2>&1)
	conflict_rc=$?
	[ "$conflict_rc" -eq 0 ] || fail "BR_SHIM_RESERVATION_UNKNOWN Agent Mail reservation read failed for $tracker_project (rc=$conflict_rc): $conflict_out"
	case "$conflict_out" in
		"No conflicts detected."*) ;;
		*" conflict(s) found:"*)
			conflict_count=${conflict_out%% *}
			case "$conflict_count" in ''|*[!0-9]*) fail "BR_SHIM_RESERVATION_UNKNOWN malformed Agent Mail conflict count: $conflict_out" ;; esac
			tracker_tab=$(printf '\t')
			conflict_rows=$(printf '%s\n' "$conflict_out" | awk 'NF >= 4 && $1 != "PATH" && $1 != "reservation_read_attestation:" { printf "%s\t%s\t%s\t%s\n", $1, $2, $3, $4 }')
			row_count=$(printf '%s\n' "$conflict_rows" | awk 'NF { n++ } END { print n+0 }')
			[ "$row_count" = "$conflict_count" ] || fail "BR_SHIM_RESERVATION_UNKNOWN incomplete Agent Mail conflict rows: $conflict_out"
			foreign_rows=$(printf '%s\n' "$conflict_rows" | awk -F "$tracker_tab" -v agent="$AGENT_NAME" '$2 != agent { print }')
			if [ -n "$foreign_rows" ]; then
				reservation_list=$(am file_reservations list "$tracker_project" 2>&1)
				list_rc=$?
				[ "$list_rc" -eq 0 ] || fail "BR_SHIM_RESERVATION_UNKNOWN Agent Mail reservation details failed for $tracker_project (rc=$list_rc): $reservation_list"
				printf '%s\n' "$foreign_rows" | while IFS="$tracker_tab" read -r conflict_path holder pattern expires; do
					[ -n "$conflict_path" ] || continue
					reservation_ids=$(printf '%s\n' "$reservation_list" | awk -v pattern="$pattern" -v holder="$holder" -v expires="$expires" '$2 == pattern && $3 == holder && $4 == expires { if (ids != "") ids = ids ","; ids = ids $1 } END { print ids }')
					[ -n "$reservation_ids" ] || fail "BR_SHIM_RESERVATION_UNKNOWN cannot resolve reservation id for $holder/$pattern (expires=$expires)"
					fail "BR_SHIM_TRACKER_RESERVED path=$conflict_path holder=$holder reservation=$reservation_ids expires=$expires"
				done
				reservation_check_rc=$?
				[ "$reservation_check_rc" -eq 0 ] || exit "$reservation_check_rc"
			fi
			;;
		*) fail "BR_SHIM_RESERVATION_UNKNOWN unrecognized Agent Mail conflict response: $conflict_out" ;;
	esac
fi
if [ "$gate_sub" = "create" ]; then
	create_guard="$(dirname -- "$self_path")/br-create-guard.py"
	[ -f "$create_guard" ] || fail "BR_CREATE_ADMISSION_UNKNOWN creation guard is missing: $create_guard"
	if [ -n "$found" ]; then
		BR_SHIM_REAL="$real" BR_SHIM_DB="$tracker_db_path" BR_SHIM_PROJECT="$tracker_project" \
			BR_SHIM_AGENT="$AGENT_NAME" BR_SHIM_ENTRY="$0" exec python3 "$create_guard" "$@"
	else
		BR_SHIM_REAL="$real" BR_SHIM_DB="$tracker_db_path" BR_SHIM_PROJECT="$tracker_project" \
			BR_SHIM_AGENT="$AGENT_NAME" BR_SHIM_ENTRY="$0" exec python3 "$create_guard" "$@" --actor "$AGENT_NAME"
	fi
fi

gate_fire=0
if [ "$gate_sub" = "close" ] && [ -n "$gate_id" ]; then gate_fire=1; fi
if [ "$gate_sub" = "update" ] && [ -n "$gate_id" ] && [ "$gate_status" = "in_review" ]; then gate_fire=1; fi
 if [ "$gate_fire" = 1 ]; then
 	gate_guard="$(dirname -- "$self_path")/close-guard.sh"
 	gate_comment="${gate_tcomment:-$gate_reason}"
 	if [ -x "$gate_guard" ]; then
 		if [ -n "$gate_db" ]; then
 			sh "$gate_guard" "$gate_id" --db "$gate_db" --sub "$gate_sub" ${gate_comment:+--reason} ${gate_comment:+"$gate_comment"} || exit "$?"
 		else
 			sh "$gate_guard" "$gate_id" --sub "$gate_sub" ${gate_comment:+--reason} ${gate_comment:+"$gate_comment"} || exit "$?"
 		fi
 	else
 		echo "br-shim: close-guard absent, skipping review gate" >&2
 	fi
 fi
if [ -n "$found" ]; then
	exec "$real" "$@"
else
	exec "$real" "$@" --actor "$AGENT_NAME"
fi
