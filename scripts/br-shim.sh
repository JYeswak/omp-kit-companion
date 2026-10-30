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
 gate_sub=""; gate_id=""; gate_status=""; gate_db=""; gate_claim=0; gate_skip=0; gate_reason=""; gate_want_reason=0; gate_tcomment=""; gate_want_tcomment=0
gate_comment_id=""; gate_pos_comment=""; gate_literal=0
gate_extra_ids=0
gate_index=0; gate_file=0; gate_want_file=0; gate_file_index=0; gate_file_form=""; gate_file_path=""
 for gate_arg in "$@"; do
	gate_index=$((gate_index + 1))
 	if [ "$gate_skip" = 1 ]; then
 		if [ "$gate_want_reason" = 1 ]; then gate_reason="$gate_arg"; gate_want_reason=0; fi
 		if [ "$gate_want_tcomment" = 1 ]; then gate_tcomment="$gate_arg"; gate_want_tcomment=0; fi
		if [ "$gate_want_file" = 1 ]; then
			gate_file=1; gate_file_index=$gate_index; gate_file_form=""; gate_file_path=$gate_arg; gate_want_file=0
		fi
 		gate_skip=0; continue; fi
	gate_kind=$gate_arg
	if [ "$gate_literal" = 1 ]; then gate_kind=""; fi
	case "$gate_kind" in
		--) if [ "$gate_sub" = comments ] && [ "$gate_id" = add ]; then gate_literal=1; fi ;;
 		--status|--db)
 			case "$gate_arg" in
 				--status) gate_status="next" ;;
 				--db) gate_db="next" ;;
 			esac ;;
		-s) gate_status="next" ;;
		-d|--description|--body|--description-file|--design|--acceptance-criteria|--acceptance|--prerequisites|--check-acceptance|--uncheck-acceptance|--add-acceptance|--append-notes|-p|--priority|-t|--type|--assignee|--owner|--if-unchanged|--due|--defer|--estimate|--add-label|--remove-label|--set-labels|--labels|--parent|--external-ref|--source-repo|--source-repo-path|--agent-context|--session|--agent-name|--harness|--model)
			gate_skip=1 ;;
		--actor|--author|--lock-timeout|-m|--message|--content|--comment|--reason|-r|--transition-comment|--notes|--title|-f|--file)
 			gate_skip=1
 			case "$gate_arg" in
				-m|--message|--content|--comment|--reason|-r|--notes) gate_want_reason=1 ;;
				-f|--file) gate_want_file=1 ;;
 				--transition-comment) gate_want_tcomment=1 ;;
 			esac ;;
		--file=*|-f?*)
			gate_file=1; gate_file_index=$gate_index
			case "$gate_arg" in
				--file=*) gate_file_form="--file="; gate_file_path=${gate_arg#--file=} ;;
				*) gate_file_form="-f"; gate_file_path=${gate_arg#-f} ;;
			esac ;;
		--actor=*|--author=*|--lock-timeout=*|--db=*|--status=*|-m*|--message=*|--content=*|--comment=*|--reason=*|--notes=*|--transition-comment=*)
 			case "$gate_arg" in
 				--status=*) gate_status="${gate_arg#--status=}" ;;
 				--db=*) gate_db="${gate_arg#--db=}" ;;
 				--transition-comment=*) gate_tcomment="${gate_arg#--transition-comment=}" ;;
				-m*|--message=*|--content=*|--comment=*|--reason=*|--notes=*) gate_reason="${gate_arg#*=}"; gate_reason="${gate_reason#-m}" ;;
 			esac ;;
 		--claim) gate_claim=1 ;;
		-*) ;;
		*)
			if [ "$gate_status" = "next" ]; then gate_status="$gate_arg";
			elif [ "$gate_db" = "next" ]; then gate_db="$gate_arg";
			elif [ -z "$gate_sub" ]; then gate_sub="$gate_arg";
			elif [ -z "$gate_id" ]; then gate_id="$gate_arg";
			elif [ "$gate_sub" = comments ] && [ "$gate_id" = add ]; then
				if [ -z "$gate_comment_id" ]; then gate_comment_id=$gate_arg;
				else gate_pos_comment="${gate_pos_comment:+$gate_pos_comment }$gate_arg"; fi
			elif [ "$gate_sub" = update ]; then gate_extra_ids=1
			fi ;;
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

# NEEDSDIRCLAIM1 / CUTCLAIM1: native preflight owns claim admission. Prefer
# the installed runtime; only a source checkout with Bun may use the fallback.
# Require an adjudicated cut finding so an older CLI cannot silently admit.
if [ "$gate_sub" = "update" ] && [ -n "$gate_id" ] && [ "$gate_claim" = 1 ]; then
	[ "$gate_extra_ids" = 0 ] || fail "CLAIM_CUT_UNKNOWN multi-ID claims are unsupported; claim one bead per invocation"
	claim_self_dir=$(dirname -- "$self_path") || fail "CLAIM_CUT_UNKNOWN cannot resolve claim authority"
	claim_kit_root=$(CDPATH='' cd -- "$claim_self_dir/.." && pwd) || fail "CLAIM_CUT_UNKNOWN cannot resolve claim authority"
	command -v python3 >/dev/null 2>&1 || fail "CLAIM_CUT_UNKNOWN python3 is required to read native claim authority"
	claim_preflight() {
		python3 -c '
import os, sys
sys.path.insert(0, sys.argv[1])
from kitlib_run import run
result = run(sys.argv[3:], deadline_s=60, cwd=sys.argv[2], env=dict(os.environ), max_output_bytes=4 * 1024 * 1024)
sys.stderr.buffer.write(result.stderr)
if result.timed_out or result.truncated or result.rc is None:
    sys.stderr.write("CLAIM_CUT_UNKNOWN native claim authority exceeded its execution bounds\n")
    sys.exit(2)
sys.stdout.buffer.write(result.stdout)
sys.exit(result.rc if result.rc >= 0 else 2)
' "$claim_self_dir" "$tracker_project" "$@"
	}
	claim_cli=""
	if [ -x "$claim_kit_root/bin/omp-kit" ]; then
		claim_cli="$claim_kit_root/bin/omp-kit"
	elif command -v omp-kit >/dev/null 2>&1; then
		claim_cli=$(command -v omp-kit)
	fi
	if [ -n "$claim_cli" ]; then
		claim_probe=$(BEADS_DB="$tracker_db_path" BR_REAL="$real" claim_preflight "$claim_cli" preflight claim "$gate_id" --project "$tracker_project" --actor "$AGENT_NAME" --json)
		claim_rc=$?
	elif [ -f "$claim_kit_root/src/cli.ts" ] && command -v bun >/dev/null 2>&1; then
		claim_probe=$(BEADS_DB="$tracker_db_path" BR_REAL="$real" claim_preflight bun run --no-env-file --config=/dev/null "$claim_kit_root/src/cli.ts" preflight claim "$gate_id" --project "$tracker_project" --actor "$AGENT_NAME" --json)
		claim_rc=$?
	else
		fail "CLAIM_CUT_UNKNOWN native claim authority unavailable; install omp-kit or provide the source checkout's existing Bun runtime"
	fi
	claim_verdict=$(printf '%s' "$claim_probe" | python3 -c '
import json, sys
doc = json.load(sys.stdin)
data = doc.get("data", doc) if isinstance(doc, dict) else None
if not isinstance(data, dict) or data.get("act") != "claim" or data.get("target") != sys.argv[1]:
    raise ValueError("claim authority returned the wrong target")
findings = data.get("findings")
if not isinstance(findings, list) or not all(isinstance(f, dict) and isinstance(f.get("code"), str) and isinstance(f.get("blocking"), bool) and isinstance(f.get("detail"), str) and isinstance(f.get("remedy"), str) for f in findings):
    raise ValueError("claim authority returned incomplete findings")
cut_codes = {"CLAIM_CUT_ADMITTED", "CLAIM_OUT_OF_CUT", "CLAIM_CUT_UNKNOWN"}
cut = [f for f in findings if f["code"] in cut_codes]
if len(cut) != 1 or cut[0]["blocking"] != (cut[0]["code"] != "CLAIM_CUT_ADMITTED"):
    raise ValueError("claim authority did not return one consistent cut adjudication")
blocked = [f for f in findings if f["blocking"]]
if blocked:
    for f in blocked:
        code = "BR_SHIM_NEEDS_DIRECTOR" if f["code"] == "NEEDS_DIRECTOR" else f["code"]
        print(code + ": " + f["detail"] + "; remedy: " + f["remedy"])
elif int(sys.argv[2]) != 0 or doc.get("ok") is not True:
    raise ValueError("claim authority failed without a refusal")
else:
    print("PASS")
' "$gate_id" "$claim_rc") || fail "CLAIM_CUT_UNKNOWN native claim authority failed or returned an incomplete verdict (rc=$claim_rc)"
	[ "$claim_verdict" = "PASS" ] || fail "$claim_verdict"
fi

# REPLAYABLE1 claim/review gate (ompkit-fp72.135.3.71, J-2026-10-29-22):
# `br update ID --claim` and the move to in_review are refused when the
# acceptance cannot be replayed. Review entry runs the full admission lint,
# including AC phase and pregrade; claim runs only the replayability predicate.
# A helper that cannot run passes through with the update lint's fail-open contract.
if [ "$gate_sub" = "update" ] && [ -n "$gate_id" ] && { [ "$gate_claim" = 1 ] || [ "$gate_status" = "in_review" ]; }; then
	replay_lint="$(dirname -- "$self_path")/br-update-lint.py"
	if [ -f "$replay_lint" ] && command -v python3 >/dev/null 2>&1; then
		if [ "$gate_status" = "in_review" ]; then
			BR_UPDATE_REAL="$real" BR_UPDATE_PROJECT="$tracker_project" BR_UPDATE_DB="$tracker_db_path" BR_UPDATE_REPLAYABLE_ONLY=0 \
				python3 "$replay_lint" update "$gate_id" "$@"
		else
			BR_UPDATE_REAL="$real" BR_UPDATE_PROJECT="$tracker_project" BR_UPDATE_DB="$tracker_db_path" BR_UPDATE_REPLAYABLE_ONLY=1 \
				python3 "$replay_lint" update "$gate_id" "$@"
		fi
		replay_rc=$?
		case "$replay_rc" in
			0) ;;
			4) exit 4 ;;
			*) echo "br-shim: REPLAYABLE_GATE_UNVERIFIED update lint rc=$replay_rc, passing through" >&2 ;;
		esac
	else
		echo "br-shim: REPLAYABLE_GATE_UNVERIFIED update lint or python3 absent, passing through" >&2
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
# LANESPLIT1b: the source checkout's own measured ledger, never the metadata tracker's.
handoff_review=0
if [ "$gate_sub" = update ] && [ "$gate_status" = in_review ]; then handoff_review=1; fi
handoff_probe=$handoff_review
if [ "$gate_sub" = comments ] && [ "$gate_id" = add ] && [ "$gate_file" = 1 ]; then handoff_probe=1; fi
case "$gate_tcomment$shim_nl$gate_reason$shim_nl$gate_pos_comment" in *DONE*) handoff_probe=1 ;; esac
if { [ "$gate_sub" = update ] || { [ "$gate_sub" = comments ] && [ "$gate_id" = add ]; }; } && [ "$handoff_probe" = 1 ]; then
	handoff_helper="$(dirname -- "$self_path")/br-update-lint.py"
	if [ ! -f "$handoff_helper" ] || ! command -v python3 >/dev/null 2>&1; then
		fail "HANDOFF_UNGATED admission helper unavailable; run in the source checkout: sh scripts/fresh-gate.sh --commit <sha>"
	fi
	if [ "$gate_sub" = comments ] && [ "$gate_file" = 1 ]; then
		if [ -n "$found" ]; then
			BR_HANDOFF_PROJECT="$PWD" python3 "$handoff_helper" handoff-file "$gate_file_index" "$gate_file_form" "$gate_file_path" "$gate_tcomment" "$gate_reason$shim_nl$gate_pos_comment" "$real" "$@"
		else
			BR_HANDOFF_PROJECT="$PWD" python3 "$handoff_helper" handoff-file "$gate_file_index" "$gate_file_form" "$gate_file_path" "$gate_tcomment" "$gate_reason$shim_nl$gate_pos_comment" "$real" "$@" --actor "$AGENT_NAME"
		fi
		exit "$?"
	fi
	BR_HANDOFF_PROJECT="$PWD" python3 "$handoff_helper" handoff "$handoff_review" "$gate_tcomment" "$gate_reason$shim_nl$gate_pos_comment"
	handoff_rc=$?
	case "$handoff_rc" in
		0) ;;
		4) exit 4 ;;
		*) fail "HANDOFF_UNGATED source admission could not be verified; run in the source checkout: sh scripts/fresh-gate.sh --commit <sha>" ;;
	esac
fi
if [ -n "$found" ]; then
	exec "$real" "$@"
else
	exec "$real" "$@" --actor "$AGENT_NAME"
fi
