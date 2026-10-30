#!/bin/sh
# full-suite-complement.test.sh: NODOUBLEPASS1 (ompkit-bp50d). The full-suite verdict given a
# focused-passed report for the SAME tree runs only the complement and records the covered set;
# a report for another tree, or naming a file the archive does not enumerate, changes nothing;
# a failing complement file still fails the verdict (no coverage lost).
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
set -u
KITROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
VERDICT=${FULL_SUITE_VERDICT_UNDER_TEST:-"$KITROOT_DIR/scripts/full-suite-verdict.sh"}
REPO_TMP="$KITROOT_DIR/var/agent-tmp"
# shellcheck source=scripts/kitlib-tmp.sh
. "$KITROOT_DIR/scripts/kitlib-tmp.sh"
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP full-suite-complement-test || exit 1
pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }
not_ok() { fail=$((fail + 1)); echo "not ok - $1"; }
step() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1"; }

# Fixture: three bun files and one shell suite; one bun file fails only when FIXTURE_FAIL_C is set.
repo="$TMP/repo"
mkdir -p "$repo/scripts" "$repo/tests/cli"
cp "$KITROOT_DIR/scripts/kitlib-tmp.sh" "$repo/scripts/kitlib-tmp.sh"
for n in a b; do
	printf 'import { test, expect } from "bun:test";\ntest("%s", () => { expect(1).toBe(1); });\n' "$n" >"$repo/tests/cli/$n.test.ts"
done
printf 'import { test, expect } from "bun:test";\ntest("c", () => { expect(process.env.FIXTURE_FAIL_C ?? "").toBe(""); });\n' >"$repo/tests/cli/c.test.ts"
printf '#!/bin/sh\necho "shell suite ran"\nexit 0\n' >"$repo/tests/cli/s.test.sh"
git -C "$repo" init -q
git -C "$repo" config user.name "NODOUBLEPASS1 test"
git -C "$repo" config user.email "nodoublepass1@example.invalid"
git -C "$repo" add -A
git -C "$repo" commit -q -m "[test] NODOUBLEPASS1 fixture"
tree=$(git -C "$repo" rev-parse 'HEAD^{tree}')
judge=$(python3 "$(dirname -- "$VERDICT")/suite-metrics.py" identity --root "$(dirname -- "$VERDICT")/.." --scope focused) || exit 1
runtime="$(uname -s)/$(uname -m)/bun-$(bun --version)/$(python3 --version 2>&1)"
hdr() { printf 'tree %s\njudge %s\nruntime %s\n' "$1" "$judge" "$runtime"; }

run_verdict() {
	out="$TMP/$1.out"
	shift
	rm -rf "$repo.cache"
	# Focused coverage carries actual measurements, not just names in a log.
	# Run only existing named files; unknown names remain an ignored-report plant.
	focus_records="$TMP/focus-$(basename "$out")"
	mkdir -p "$focus_records"
	: >"$focus_records/declared"
	if [ -n "${report:-}" ] && [ -f "$report" ]; then
		focus_index=0
		while IFS= read -r focus_path; do
			case "$focus_path" in tests/*) ;; *) continue ;; esac
			[ -f "$repo/$focus_path" ] || continue
			focus_index=$((focus_index + 1))
			case "$focus_path" in *.sh) focus_runner="sh" ;; *.py) focus_runner="python3" ;; *) focus_runner="bun" ;; esac
			if [ "$focus_runner" = bun ]; then
				python3 "$KITROOT_DIR/scripts/suite-metrics.py" run \
					--record "$focus_records/$focus_index.json" --path "$focus_path" --runner bun \
					--tree "$tree" --cwd "$repo" --deadline 60 -- bun test "./$focus_path" \
					>"$focus_records/$focus_index.log" 2>&1 || return 1
			else
				python3 "$KITROOT_DIR/scripts/suite-metrics.py" run \
					--record "$focus_records/$focus_index.json" --path "$focus_path" --runner "$focus_runner" \
					--tree "$tree" --cwd "$repo" --deadline 60 -- "$focus_runner" "$focus_path" \
					>"$focus_records/$focus_index.log" 2>&1 || return 1
			fi
			printf '%s\n' "$focus_path" >>"$focus_records/declared"
		done <"$report"
		if [ -s "$focus_records/declared" ]; then
			python3 "$KITROOT_DIR/scripts/suite-metrics.py" collect --records "$focus_records" \
				--declared "$focus_records/declared" --output "$report.timings.json" \
				--csv "$focus_records/timings.csv" --cwd "$repo" || return 1
		fi
	fi
	# env -u: a planted FIXTURE_FAIL_C must never leak into the next run (POSIX sh keeps a prefix
	# assignment on a function call in the caller's environment).
	env -u FIXTURE_FAIL_C ${FAIL_C:+FIXTURE_FAIL_C=1} KITROOT="$KITROOT_DIR" OMP_KIT_OMP_SRC_FETCH=0 sh "$VERDICT" --repo "$repo" --commit HEAD --cache-dir "$repo.cache" "$@" >"$out" 2>&1
	rc=$?
}

# 1. same-tree report covering a, b and the shell suite: only c runs; verdict PASS records the split.
step "same-tree report"
report="$TMP/passed.txt"
{ hdr "$tree"; printf 'tests/cli/a.test.ts\ntests/cli/b.test.ts\ntests/cli/s.test.sh\n'; } >"$report"
run_verdict same --focused-passed "$report"
if [ "$rc" -eq 0 ]; then ok "same-tree: verdict PASS"; else not_ok "same-tree rc=$rc"; cat "$out"; fi
if grep -q 'full-suite: covered by the focused pass on the same tree: bun=2 shell=1 python=0; complement bun=1 shell=0 python=0' "$out"; then ok "same-tree: complement line names bun=1 shell=0"; else not_ok "same-tree: complement line"; grep 'full-suite' "$out"; fi
if grep -q 'VERDICT PASS .* covered_by_focused=3' "$out"; then ok "same-tree: PASS line counts 3 covered"; else not_ok "same-tree: PASS line"; grep VERDICT "$out"; fi
if ! grep -q 'shell suite ran' "$repo.cache/$tree.log"; then ok "same-tree: the covered shell suite did not run"; else not_ok "same-tree: covered shell suite ran"; fi
if python3 -c '
import json, sys
e = json.load(open(sys.argv[1]))["evidence"]
c = e["covered_by_focused"]
assert c["bun"] == ["tests/cli/a.test.ts", "tests/cli/b.test.ts"], c
assert c["shell"] == ["tests/cli/s.test.sh"] and c["py"] == [] and c["ignored"] == [], c
assert c["join"] == "joined", c
assert e["bun_files"] == 1 and e["shell_suites"] == 0, e
' "$repo.cache/$tree.json"; then ok "same-tree: cached JSON lists the covered set and the complement counts"; else not_ok "same-tree: cached JSON"; fi

# 2. planted: a report for another tree is ignored and everything runs.
step "planted other-tree report"
{ hdr 0000000000000000000000000000000000000000; printf 'tests/cli/a.test.ts\ntests/cli/b.test.ts\ntests/cli/s.test.sh\n'; } >"$report"
run_verdict other --focused-passed "$report"
if [ "$rc" -eq 0 ] && grep -q 'focused-passed report is for tree 0000000000000000000000000000000000000000, not candidate' "$out" && grep -q 'VERDICT PASS .*bun_ran=3 shell=1 python=0 .*covered_by_focused=0' "$out" && grep -q 'shell suite ran' "$repo.cache/$tree.log"; then
	ok "planted other-tree: ignored, all three bun files and the shell suite ran"
else
	not_ok "planted other-tree (rc=$rc)"; cat "$out"
fi
# The verdict json records WHY the report was not joined (attempt 10 of the companion publish left only an
# empty covered set; the stdout line was dropped by the caller).
if python3 -c 'import json,sys; c=json.load(open(sys.argv[1]))["evidence"]["covered_by_focused"]; assert c["join"] == "tree-mismatch:0000000000000000000000000000000000000000", c' "$repo.cache/$tree.json"; then ok "planted other-tree: json join names the mismatch"; else not_ok "planted other-tree: json join"; fi

# 3. planted: a complement file that fails fails the verdict even though the report covers the rest.
step "planted failing complement"
{ hdr "$tree"; printf 'tests/cli/a.test.ts\ntests/cli/b.test.ts\ntests/cli/s.test.sh\n'; } >"$report"
FAIL_C=1 run_verdict failc --focused-passed "$report"
FAIL_C=
if [ "$rc" -ne 0 ] && grep -q 'VERDICT FAIL .*bun_fail=1' "$out"; then ok "planted failing complement: verdict FAIL bun_fail=1"; else not_ok "planted failing complement (rc=$rc)"; grep VERDICT "$out"; fi
if grep -q 'FULL-SUITE: failing tests' "$out" && grep -q 'tests/cli/c.test.ts: (fail) c' "$out"; then ok "planted failing complement: the failing test is named in the gate output"; else not_ok "failing test not named"; grep -A3 'failing tests' "$out"; fi

FAIL_C=
# 4. planted: a report naming a file the archive does not enumerate is reported and reduces nothing.
step "planted unknown name"
{ hdr "$tree"; printf 'tests/cli/zzz.test.ts\n'; } >"$report"
run_verdict unknown --focused-passed "$report"
if [ "$rc" -eq 0 ] && grep -q 'focused-passed names tests/cli/zzz.test.ts, not in the declared suite; ignored' "$out" && grep -q 'complement bun=3 shell=1 python=0' "$out"; then
	ok "planted unknown name: reported, full suite ran"
else
	not_ok "planted unknown name (rc=$rc)"; grep 'full-suite' "$out"
fi

# 4b. planted: a report from another judge (different fresh-gate.sh bytes) or runtime is ignored.
step "planted other judge"
{ printf 'tree %s\njudge %s\nruntime %s\n' "$tree" "deadbeef" "$runtime"; printf 'tests/cli/a.test.ts\ntests/cli/b.test.ts\n'; } >"$report"
run_verdict judge --focused-passed "$report"
if [ "$rc" -eq 0 ] && grep -q 'written by judge deadbeef, not this gate' "$out" && grep -q 'VERDICT PASS .*bun_ran=3 .*covered_by_focused=0' "$out"; then ok "planted other judge: ignored, all files ran"; else not_ok "planted other judge (rc=$rc)"; grep -E 'full-suite|VERDICT' "$out"; fi
{ printf 'tree %s\njudge %s\nruntime %s\n' "$tree" "$judge" "Other/arch/bun-0/Python 0"; printf 'tests/cli/a.test.ts\n'; } >"$report"
run_verdict runtime --focused-passed "$report"
if [ "$rc" -eq 0 ] && grep -q 'ran on runtime Other/arch/bun-0/Python 0, not' "$out" && grep -q 'covered_by_focused=0' "$out"; then ok "planted other runtime: ignored"; else not_ok "planted other runtime (rc=$rc)"; grep -E 'full-suite|VERDICT' "$out"; fi

# 5. control: no report at all is the complete suite, no covered line.
step "control without report"
run_verdict none
if [ "$rc" -eq 0 ] && ! grep -q 'covered by the focused pass' "$out" && grep -q 'VERDICT PASS .* covered_by_focused=0' "$out"; then ok "control: complete suite, 0 covered"; else not_ok "control (rc=$rc)"; grep -E 'full-suite|VERDICT' "$out"; fi

# 6. FULLSUITEPAR1 (ompkit-9t6f2): the shell complement runs two at a time and a failing complement
# suite still fails the verdict. The report covers s1; s2 and s3 (the first two complement suites,
# claimed together) each wait for the other, so their overlap proves the complement ran in parallel.
step "parallel shell complement"
repo="$TMP/par"
mkdir -p "$repo/scripts" "$repo/tests/cli" "$TMP/par-probe"
cp "$KITROOT_DIR/scripts/kitlib-tmp.sh" "$repo/scripts/kitlib-tmp.sh"
# shellcheck disable=SC2016 # the fixture body is literal shell, expanded by the suite
par_body='name=$(basename "$0" .test.sh)
echo "complement suite $name ran"
: >"$PAR_PROBE/up.$name"
peer=
case "$name" in s2) peer=s3 ;; s3) peer=s2 ;; esac
if [ -n "$peer" ]; then
	k=0
	while [ ! -e "$PAR_PROBE/up.$peer" ] && [ "$k" -lt 200 ]; do sleep 0.1; k=$((k + 1)); done
	if [ -e "$PAR_PROBE/up.$peer" ]; then : >"$PAR_PROBE/overlap.$name"; fi
	sleep 0.3
fi
rm -f "$PAR_PROBE/up.$name"
[ "$name" != s3 ] || exit 4'
for n in s1 s2 s3 s4; do printf '%s\n' "$par_body" >"$repo/tests/cli/$n.test.sh"; done
git -C "$repo" init -q
git -C "$repo" config user.name "FULLSUITEPAR1 test"
git -C "$repo" config user.email "fullsuitepar1@example.invalid"
git -C "$repo" add -A
git -C "$repo" commit -q -m "[test] FULLSUITEPAR1 complement fixture"
tree=$(git -C "$repo" rev-parse 'HEAD^{tree}')
{ hdr "$tree"; printf 'tests/cli/s1.test.sh\n'; } >"$report"
PAR_PROBE="$TMP/par-probe" FULL_SUITE_SHELL_JOBS=2
export PAR_PROBE FULL_SUITE_SHELL_JOBS
run_verdict par --focused-passed "$report"
unset PAR_PROBE FULL_SUITE_SHELL_JOBS
if [ "$rc" -ne 0 ] && grep -q 'complement bun=0 shell=3 python=0' "$out" && grep -q 'VERDICT FAIL .*shell_red=1' "$out" && grep -q '  RED script-suite tests/cli/s3.test.sh rc=4' "$out"; then
	ok "parallel complement: a failing complement suite fails the verdict and is named"
else
	not_ok "parallel complement (rc=$rc)"; grep -E 'full-suite|VERDICT|RED' "$out"
fi
if [ -e "$TMP/par-probe/overlap.s2" ] && [ -e "$TMP/par-probe/overlap.s3" ] && grep -q 'shell stage: 3 suites, 2 at a time' "$repo.cache/$tree.log"; then
	ok "parallel complement: the complement suites ran two at a time"
else
	not_ok "parallel complement: no overlap between complement suites"; ls "$TMP/par-probe"
fi
if ! grep -q 'complement suite s1 ran' "$repo.cache/$tree.log" && python3 -c '
import json, sys
e = json.load(open(sys.argv[1]))["evidence"]
assert (e["shell_suites"], e["shell_fail"]) == (3, 1), e
assert e["covered_by_focused"]["shell"] == ["tests/cli/s1.test.sh"], e
' "$repo.cache/$tree.json"; then ok "parallel complement: the covered suite did not run; JSON counts 3 suites, 1 failed"; else not_ok "parallel complement: covered suite ran or JSON counts"; fi

# SUITEBUDGET1: retain the three executed files and the focused file's actual
# prior measurement, even on FAIL.
if python3 -c '
import json, sys
v = json.load(open(sys.argv[1]))
assert v["version"] == 2, v.get("version")
rows = v["evidence"]["files"]
assert {r["path"] for r in rows} == {
    "tests/cli/s1.test.sh", "tests/cli/s2.test.sh", "tests/cli/s3.test.sh", "tests/cli/s4.test.sh"
}, rows
assert all(r["runner"] == "sh" and r["elapsed_ms"] >= 0 for r in rows), rows
assert next(r for r in rows if r["path"].endswith("s3.test.sh"))["rc"] == 4, rows
assert v["timing"]["wall_ms"] >= 0 and v["timing"]["workers"]["shell"] == 2
' "$repo.cache/$tree.json"; then ok "suite budgets: complete per-file timing and failing rc retained"; else not_ok "suite budgets: missing per-file timing"; fi

# A complete cached verdict is reusable; deleting one measured row makes it cold.
PAR_PROBE="$TMP/par-probe" FULL_SUITE_SHELL_JOBS=2 \
	sh "$VERDICT" --repo "$repo" --commit HEAD --cache-dir "$repo.cache" --focused-passed "$report" \
	>"$TMP/cache-control.out" 2>&1
cache_rc=$?
if [ "$cache_rc" -ne 0 ] && grep -q 'VERDICT REUSED FAIL' "$TMP/cache-control.out"; then
	ok "timing cache: complete failing record is reused"
else
	not_ok "timing cache: complete control was not reused"; cat "$TMP/cache-control.out"
fi
python3 -c '
import json,sys
p=sys.argv[1]
v=json.load(open(p))
v["evidence"]["files"].pop()
with open(p,"w") as f: json.dump(v,f)
' "$repo.cache/$tree.json"
PAR_PROBE="$TMP/par-probe" FULL_SUITE_SHELL_JOBS=2 \
	sh "$VERDICT" --repo "$repo" --commit HEAD --cache-dir "$repo.cache" --focused-passed "$report" \
	>"$TMP/cache-truncated.out" 2>&1
cache_rc=$?
if [ "$cache_rc" -ne 0 ] && grep -q 'cache miss' "$TMP/cache-truncated.out"; then
	ok "timing cache: truncated file set is a MISS"
else
	not_ok "timing cache: truncated record was reused"; cat "$TMP/cache-truncated.out"
fi

step "three-file native timing refresh"
repo="$TMP/three-files"
mkdir -p "$repo/tests/cli" "$repo/.github" "$repo/scripts"
cp "$KITROOT_DIR/scripts/kitlib-tmp.sh" "$repo/scripts/kitlib-tmp.sh"
for n in a b c; do
	printf 'import { test, expect } from "bun:test";\ntest("%s", () => { expect(1).toBe(1); });\n' "$n" >"$repo/tests/cli/$n.test.ts"
done
printf '%s\n' '{"version":1,"files":{"tests/cli/a.test.ts":99999999,"tests/cli/b.test.ts":99999999,"tests/cli/c.test.ts":99999999,"tests/cli/deleted.test.ts":99}}' >"$repo/.github/core-test-timings.json"
git -C "$repo" init -q
git -C "$repo" config user.name "SUITEBUDGET1 test"
git -C "$repo" config user.email "suite-budget@example.invalid"
git -C "$repo" add -A
git -C "$repo" commit -q -m "[test] three-file timing fixture"
tree=$(git -C "$repo" rev-parse 'HEAD^{tree}')
run_verdict refresh
if [ "$rc" -eq 0 ] && python3 -c '
import csv,json,sys
from pathlib import Path
cache,tree=Path(sys.argv[1]),sys.argv[2]
v=json.load(open(cache/(tree+".json")))
assert len(v["evidence"]["files"]) == 3
table=json.load(open(cache/"timings/core-test-timings.json"))["files"]
assert table["tests/cli/deleted.test.ts"] == 99
for name in ("a","b","c"):
    assert 0 <= table["tests/cli/"+name+".test.ts"] < 99999999
with open(cache/(tree+".timings.csv")) as f:
    rows=list(csv.DictReader(f))
assert len(rows)==3 and all(r["stage"]=="bun" and r["rc"]=="0" for r in rows)
assert {"file","elapsed_s","workers","load_1m"}.issubset(rows[0])
' "$repo.cache" "$tree"; then
	ok "native timings: all three observations refreshed; deleted entry retained; CSV is complete"
else
	not_ok "native timings: refresh contract failed"; cat "$out"
fi

sh "$VERDICT" --repo "$repo" --commit HEAD --cache-dir "$repo.cache" >"$TMP/pass-cache-control.out" 2>&1
cache_rc=$?
if [ "$cache_rc" -eq 0 ] && grep -q 'VERDICT REUSED PASS' "$TMP/pass-cache-control.out"; then
	ok "timing cache: consistent passing file outcomes are reused"
else
	not_ok "timing cache: passing control was not reused"; cat "$TMP/pass-cache-control.out"
fi
python3 -c '
import json,sys
p=sys.argv[1]
v=json.load(open(p))
v["evidence"]["files"][0]["rc"]=4
with open(p,"w") as f: json.dump(v,f)
' "$repo.cache/$tree.json"
sh "$VERDICT" --repo "$repo" --commit HEAD --cache-dir "$repo.cache" >"$TMP/pass-cache-corrupt.out" 2>&1
cache_rc=$?
if [ "$cache_rc" -eq 0 ] && grep -q 'cache miss' "$TMP/pass-cache-corrupt.out" && python3 -c '
import json,sys
v=json.load(open(sys.argv[1]))
assert v["verdict"]=="PASS" and all(row["rc"]==0 for row in v["evidence"]["files"])
' "$repo.cache/$tree.json"; then
	ok "timing cache: a failed file invalidates aggregate PASS and is re-executed"
else
	not_ok "timing cache: aggregate PASS hid a failed file"; cat "$TMP/pass-cache-corrupt.out"
fi

printf 'full-suite-complement: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = 0 ]
