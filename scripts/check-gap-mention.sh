#!/bin/sh
# check-gap-mention.sh MSGFILE | --selftest — commit-msg member (GAPFADE1, ompkit-3waa2; Joshua 2026-10-26:
# "any gaps you find need to be surfaced; we can't let those fade into another agent hitting them").
#
# A commit body that names a gap in prose ("finding class", "second time", "follow-up", "should be/say/name",
# "not blocking", "defect", "gap:") without a bead id in the same sentence produces one FINDING GAP_UNFILED
# containing the unfiled sentences (kitlib-findings.sh grammar), and the commit is refused ONCE: the same body
# (hashed without comment lines) passes on its next attempt, so the forcing function is a read, never a wall. A body
# carrying `Gap-Bead: <ompkit-id>` or `Gap-Bead: none (<reason>)` passes outright. Phrases inside backticks or
# quotes (test names, quoted output) never fire. Prior art: the Supersedes: trailer makes a blamed removal name
# its commit; this makes a named gap name its bead.
#
# Seen-once state: <git-dir>/omp-kit/gap-mention-seen (one body hash per line), local to the checkout.
# The member prints findings and exits 0 on a judged body (the chain runner refuses on findings); it exits 2
# only when it cannot judge (no message file), which the runner records as MEMBER_REFUSED.
set -u
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
# shellcheck disable=SC1091
if [ -f "$here/kitlib-findings.sh" ]; then . "$here/kitlib-findings.sh"; else
	printf 'check-gap-mention: kitlib-findings.sh missing beside %s; rerun scripts/install-commit-msg-bead.sh\n' "$(basename -- "$0")" >&2
	exit 2
fi

# gap_sentences BODYFILE: one line per sentence that names a gap and carries no bead id. Quoted and
# backticked spans are blanked first so a test name like "a defect row" never fires. Sentences split
# on ". ", ";", newline. The trigger set is the bead's list, anchored on word boundaries.
GAP_RE='finding class|second time|follow-up|follow up|should (be|say|name|have|refuse|print)|not blocking|defect|gap:'
gap_sentences() {
	# Callers remove commit subjects; producer prose is scanned in full.
	# shellcheck disable=SC2016
	sed -e 's/`[^`]*`/ /g' -e 's/"[^"]*"/ /g' -e "s/'[^']*'/ /g" -e 's/^$/./' "$1" \
		| tr '\n' ' ' | sed -e 's/[.;] */\
/g' \
		| grep -i -E "(^|[^[:alnum:]])($GAP_RE)([^[:alnum:]]|$)" \
		| grep -v -E 'ompkit-[a-z0-9]+(\.[0-9]+)*' \
		| sed -e 's/^ *//' -e 's/ *$//' | grep -v '^$' || :
}

# three_words SENTENCE: the first three words of four or more letters that are not the trigger, for `br search`.
three_words() {
	printf '%s\n' "$1" | tr -c '[:alnum:]\n' ' ' | tr ' ' '\n' | grep -E '^[[:alpha:]]{4,}$' \
		| grep -v -i -E '^(finding|class|second|time|follow|should|blocking|defect|that|this|with|from|then|than|when|which|there|their|have|been|were|into)$' \
		| head -n 3 | paste -sd ' ' -
}

judge() {
	msg=$1
	body=$(mktemp "${TMPDIR:-/tmp}/gap-body.XXXXXX") || return 2 # tempsafe: one file, removed below, under the gate's TMPDIR
	grep -v '^#' "$msg" > "$body"
	if grep -q -E '^Gap-Bead: *(ompkit-[a-z0-9.]+|none *\(.+\))' "$body"; then rm -f "$body"; return 0; fi
	sentences=$(sed '1d' "$body" | gap_sentences /dev/stdin)
	if [ -z "$sentences" ]; then rm -f "$body"; return 0; fi
	hash=$(shasum -a 256 "$body" | cut -d' ' -f1)
	rm -f "$body"
	seen=""
	if gitdir=$(git rev-parse --absolute-git-dir 2>/dev/null); then
		seen="$gitdir/omp-kit/gap-mention-seen"
		if [ -f "$seen" ] && grep -q -F -x "$hash" "$seen"; then
			printf 'check-gap-mention: the same body was refused once already; passing (file the gap or add Gap-Bead: none (<reason>))\n' >&2
			return 0
		fi
	fi
	s=$(printf '%s\n' "$sentences" | paste -sd ';' -)
	words=$(three_words "$s")
	kitlib_finding commit-gap-mention GAP_UNFILED "unfiled gap in the commit body: \"$s\"" \
		"name the bead in each sentence, or add Gap-Bead: none (<reason>); search first, then br create with WHAT/WHY and a planted negative" \
		br search "${words:-$s}" --json
	if [ -n "$seen" ]; then mkdir -p "$(dirname "$seen")" 2>/dev/null && printf '%s\n' "$hash" >> "$seen"; fi
	return 0
}

selftest() {
	# shellcheck source=scripts/kitlib-tmp.sh
	. "$here/kitlib-tmp.sh"
	t=''
	kitlib_tmp t gap-mention-selftest || exit 2
	fail=0
	ok() { printf '%s ok - %s\n' "$(date -u +%H:%M:%S)" "$1"; }
	clean() { if printf '%s\n' "$2" | grep -q '^FINDING	'; then not_ok "$1"; printf '%s\n' "$2"; else ok "$1"; fi; }
	not_ok() { printf '%s not ok - %s\n' "$(date -u +%H:%M:%S)" "$1"; fail=1; }
	( cd "$t" && git init -q . ) || exit 2
	printf 'fix: x [test]\n\nthe gate should say X; second time tonight\n\nBead: ompkit-ab12c\n' > "$t/m1"
	out=$(cd "$t" && judge "$t/m1"); n=$(printf '%s\n' "$out" | grep -c '^FINDING	' || :)
	if [ "$n" -eq 1 ] && printf '%s' "$out" | grep -q 'GAP_UNFILED' && printf '%s' "$out" | grep -q 'the gate should say X;second time tonight' && printf '%s' "$out" | grep -q 'br search'; then ok "positive: one GAP_UNFILED finding quotes both clauses with a br search fix"; else not_ok "positive"; printf '%s\n' "$out"; fi
	out2=$(cd "$t" && judge "$t/m1"); n2=$(printf '%s\n' "$out2" | grep -c '^FINDING	' || :)
	if [ "$n2" -eq 0 ]; then ok "refused once: the identical body passes on the second attempt"; else not_ok "refused once (n2=$n2)"; fi
	printf 'fix: y [test]\n\nthe gate should say X (ompkit-ab12c); second time tonight, see ompkit-ab12c\n' > "$t/m2"
	out=$(cd "$t" && judge "$t/m2"); clean "planted: a bead id in the sentence passes" "$out"
	printf 'fix: z [test]\n\nthe gate should say X\n\nGap-Bead: none (duplicate of ompkit-ab12c)\n' > "$t/m3"
	out=$(cd "$t" && judge "$t/m3"); clean "planted: Gap-Bead: none (<reason>) passes" "$out"
	# shellcheck disable=SC2016
	printf 'test: w [test]\n\nadds `a defect row is refused` and the test "second time wins" to the suite\n' > "$t/m4"
	out=$(cd "$t" && judge "$t/m4"); clean "planted: defect inside a quoted test name does not fire" "$out"
	printf 'feat: v [test]\n\nnothing to see here, all wired\n' > "$t/m5"
	out=$(cd "$t" && judge "$t/m5"); clean "control: a body with no gap phrase passes" "$out"
	# regex checklist: a long near-miss stays fast (no nested quantifiers; grep -E is linear here)
	long=$(printf 'defec%.0s' $(seq 1 20000)); printf 'x [test]\n\n%s\n' "$long" > "$t/m6"
	start=$(date +%s); out=$(cd "$t" && judge "$t/m6"); el=$(( $(date +%s) - start ))
	if [ "$el" -le 2 ] && ! printf '%s\n' "$out" | grep -q '^FINDING	'; then ok "near-miss: 100 KB of 'defec' judged in ${el}s with no finding"; else not_ok "near-miss (${el}s)"; fi
	if [ "$fail" -eq 0 ]; then echo "check-gap-mention selftest: GREEN"; exit 0; fi
	echo "check-gap-mention selftest: RED" >&2; exit 1
}

case "${1:-}" in
	--scan-text)
		# Stateless shared scanner for the metric and producer guards; no retry ledger.
		if printf '%s\n' "${2:-}" | grep -q -E '^Gap-Bead: *(ompkit-[a-z0-9.]+|none *\(.+\))'; then exit 0; fi
		printf '%s\n' "${2:-}" | gap_sentences /dev/stdin
		;;
	--findings-text)
		if printf '%s\n' "${2:-}" | grep -q -E '^Gap-Bead: *(ompkit-[a-z0-9.]+|none *\(.+\))'; then exit 0; fi
		printf '%s\n' "${2:-}" | gap_sentences /dev/stdin | while IFS= read -r s; do
			kitlib_finding commit-gap-mention GAP_UNFILED "unfiled gap: \"$s\"" \
				"name the bead in that sentence or add Gap-Bead: none (<reason>); otherwise br create with WHAT/WHY" \
				br search "$(three_words "$s")" --json
		done
		;;
	--selftest) selftest ;;
	'') printf 'usage: check-gap-mention.sh MSGFILE | --selftest | --scan-text TEXT | --findings-text TEXT\n' >&2; exit 2 ;;
	*) judge "$1" ;;
esac
