#!/bin/sh
# kitlib-findings.sh: the FINDING line grammar hook members print (GATEDIAG1, ompkit-fp72.135.3.16; plan
# section 23.3). Source it (`. "$here/kitlib-findings.sh"`), then for each defect:
#   kitlib_finding GATE CODE DETAIL REMEDY [FIX...]      one line on stdout; FIX words are joined by a single space
#   kitlib_findings_count                                 how many this member printed so far
# A member prints every finding it can see, then exits 0. It exits non-zero ONLY when it could not judge (the
# runner records that as one UNJUDGED finding). Nothing else goes to stdout; stderr is free.
# Line: FINDING<TAB>gate<TAB>code<TAB>detail<TAB>remedy<TAB>fix   (tabs and newlines inside fields become spaces;
# fix is "-" when there is no ready argv). The chain runner collects the lines of every member into one envelope.
KITLIB_FINDINGS_N=0

kitlib_findings_clean() {
	printf '%s' "$1" | tr '\t\n\r' '   '
}

kitlib_finding() {
	[ "$#" -ge 4 ] || { printf 'kitlib_finding: GATE CODE DETAIL REMEDY [FIX...]\n' >&2; return 2; }
	_g=$(kitlib_findings_clean "$1"); _c=$(kitlib_findings_clean "$2")
	_d=$(kitlib_findings_clean "$3"); _r=$(kitlib_findings_clean "$4")
	shift 4
	if [ "$#" -gt 0 ]; then _f=$(kitlib_findings_clean "$*"); else _f='-'; fi
	printf 'FINDING\t%s\t%s\t%s\t%s\t%s\n' "$_g" "$_c" "$_d" "$_r" "$_f"
	KITLIB_FINDINGS_N=$((KITLIB_FINDINGS_N + 1))
}

kitlib_findings_count() {
	printf '%s\n' "$KITLIB_FINDINGS_N"
}
