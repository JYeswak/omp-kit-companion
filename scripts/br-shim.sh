#!/bin/sh
# br-shim.sh — ID1 agent-identity shim (ompkit-rc-epic-land-fix-release-dogfood-rz5.108).
# Installed as `br` ahead of the real binary on an agent pane's PATH. Every
# invocation carries --actor "$AGENT_NAME": appended when absent, enforced when
# present. Refuses to run anonymously or under another agent's name.
# Real binary resolution: $BR_REAL, else the first `br` on PATH with this
# shim's own directory removed. No dependencies beyond POSIX sh.
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
