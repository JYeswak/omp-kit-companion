#!/bin/sh
# regex-budget-slowhost-evidence.sh — REGEXREF1 (ompkit-fp72.120.16.186) slow-host evidence, outside the test suite.
#
# Live host slowdown depends on host load, so the gated tests drive the reference-scaled judge through its timing
# seams (tests/cli/regex-budget.test.ts). This script records the real thing on demand: it runs scripts/regex-budget.ts
# quietly and under `taskpolicy -c background` (efficiency cores only, the measured slow-host simulator; macOS) and
# prints each run's verdict, reference, live and write/edit lines with load1, then whether each case read as expected:
#
#   quiet               today's rules, normal scheduling              expect PASS (rc 0)
#   background-scaled   today's rules, background                     expect PASS (rc 0); rc 75 when the
#                                                                     reference ratio passes the clamp
#   background-absolute the pre-REGEXREF1 judge (895bef92c1, git      expect FAIL (rc 1): fixed 500 ms
#                       archive export, read-only), background
#   heavy-background    ten copies of kit-no-gh-poll#1, background    expect FAIL (rc 1)
#
# Usage: sh scripts/regex-budget-slowhost-evidence.sh   (from a checkout; run one regex-budget at a time on the host)
# Exit: 0 every case as expected, 1 a case differed, 2 setup failed.
set -u
HERE=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P) || exit 2
# shellcheck source=scripts/kitlib-tmp.sh
. "$HERE/scripts/kitlib-tmp.sh"
BUN=${BUN:-bun}
ABSOLUTE_JUDGE_COMMIT=895bef92c1d90fbc7a831fa57010f23ce5c2bee8
HEAVY_COPIES=10
command -v taskpolicy >/dev/null 2>&1 || { echo "slowhost-evidence: taskpolicy is unavailable (macOS only)" >&2; exit 2; }
# kitlib_tmp assigns $work in this shell (see scripts/kitlib-tmp.sh).
work=
kitlib_tmp work regexref-slowhost || exit 2

unexpected=0
# run_case <name> <expected rc list, space-separated> <taskpolicy|-> <script> [args...]
run_case() {
	name=$1 expected=$2 policy=$3 script=$4
	shift 4
	load1=$(sysctl -n vm.loadavg | awk '{print $2}')
	out="$work/$name.out"
	if [ "$policy" = taskpolicy ]; then
		taskpolicy -c background "$BUN" run --no-env-file --config=/dev/null "$script" "$@" >"$out" 2>&1
	else
		"$BUN" run --no-env-file --config=/dev/null "$script" "$@" >"$out" 2>&1
	fi
	rc=$?
	verdict=UNEXPECTED
	for want in $expected; do [ "$rc" = "$want" ] && verdict=AS_EXPECTED; done
	[ "$verdict" = AS_EXPECTED ] || unexpected=$((unexpected + 1))
	printf '== %s rc=%s expected=%s %s load1_before=%s\n' "$name" "$rc" "$expected" "$verdict" "$load1"
	grep -E '^(REGEX-BUDGET|stream reference:|live stream:|write/edit stream:)' "$out" | sed -E 's/ samples=\[[^]]*\]$//'
}

args="--rules $HERE/rules --stream $HERE/scripts/e2e-live.sh --write-edit-stream $HERE/scripts/fixtures/rx-write-edit-stream.md"
# shellcheck disable=SC2086 # args holds paths without spaces under $HERE; word splitting is intended.
run_case quiet 0 - "$HERE/scripts/regex-budget.ts" $args
# shellcheck disable=SC2086
run_case background-scaled "0 75" taskpolicy "$HERE/scripts/regex-budget.ts" $args

if git -C "$HERE" cat-file -e "$ABSOLUTE_JUDGE_COMMIT^{commit}" 2>/dev/null &&
	git -C "$HERE" archive -o "$work/absolute.tar" "$ABSOLUTE_JUDGE_COMMIT" scripts src &&
	mkdir "$work/absolute" && tar -xf "$work/absolute.tar" -C "$work/absolute"; then
	# shellcheck disable=SC2086
	run_case background-absolute 1 taskpolicy "$work/absolute/scripts/regex-budget.ts" $args
else
	printf '== background-absolute NOT_RUN (%s absent from this clone)\n' "$ABSOLUTE_JUDGE_COMMIT"
fi

mkdir "$work/heavy" || exit 2
"$BUN" -e '
const [fixturePath, dir, copies] = process.argv.slice(1);
const fixture = JSON.parse(require("node:fs").readFileSync(fixturePath, "utf8"));
const pattern = fixture.conditions.find(c => c.rule === "kit-no-gh-poll" && c.condition_index === 1)?.pattern;
if (!pattern) throw new Error("reference fixture lacks kit-no-gh-poll#1");
for (let copy = 1; copy <= Number(copies); copy++)
	require("node:fs").writeFileSync(dir + "/fixture-slow-gh-poll-" + copy + ".md", "---\ncondition: " + JSON.stringify(pattern) + "\nscope: tool:bash\ninterruptMode: never\n---\nplanted slow rule copy " + copy + "\n");
' "$HERE/scripts/fixtures/rx-reference-conditions.json" "$work/heavy" "$HEAVY_COPIES" || exit 2
run_case heavy-background 1 taskpolicy "$HERE/scripts/regex-budget.ts" --rules "$work/heavy" --stream "$HERE/scripts/e2e-live.sh"

if [ "$unexpected" -eq 0 ]; then
	echo "SLOWHOST-EVIDENCE: every case as expected"
	exit 0
fi
echo "SLOWHOST-EVIDENCE: $unexpected case(s) differed"
exit 1
