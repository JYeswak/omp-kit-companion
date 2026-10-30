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
unset FULL_SUITE_VERDICT_CACHE_DIR
pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }
not_ok() { fail=$((fail + 1)); echo "not ok - $1"; }
step() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1"; }

# Fixture: three bun files and one shell suite; a separate commit plants a failing complement.
repo="$TMP/repo"
mkdir -p "$repo/scripts" "$repo/tests/cli"
cp "$KITROOT_DIR/scripts/kitlib-tmp.sh" "$repo/scripts/kitlib-tmp.sh"
for n in a b; do
	printf 'import { test, expect } from "bun:test";\ntest("%s", () => { expect(1).toBe(1); });\n' "$n" >"$repo/tests/cli/$n.test.ts"
done
printf 'import { test, expect } from "bun:test";\ntest("c", () => { expect(1).toBe(1); });\n' >"$repo/tests/cli/c.test.ts"
printf '#!/bin/sh\necho "shell suite ran"\nexit 0\n' >"$repo/tests/cli/s.test.sh"
git -C "$repo" init -q
git -C "$repo" config user.name "NODOUBLEPASS1 test"
git -C "$repo" config user.email "nodoublepass1@example.invalid"
git -C "$repo" add -A
git -C "$repo" commit -q -m "[test] NODOUBLEPASS1 fixture"
tree=$(git -C "$repo" rev-parse 'HEAD^{tree}')
judge=$(python3 "$(dirname -- "$VERDICT")/suite-metrics.py" identity --root "$(dirname -- "$VERDICT")/.." --scope focused) || exit 1
runtime=$(python3 "$KITROOT_DIR/scripts/suite-metrics.py" runtime) || exit 1
hdr() { printf 'tree %s\njudge %s\nruntime %s\n' "$1" "$judge" "$runtime"; }

record_path() {
	python3 "$KITROOT_DIR/scripts/full-suite-verdict-store.py" path \
		--repo "$repo" --tree "$tree" --role base --judge-root "$KITROOT_DIR" --cache-dir "$repo.cache"
}

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
	KITROOT="$KITROOT_DIR" OMP_KIT_OMP_SRC_FETCH=0 sh "$VERDICT" --repo "$repo" --commit HEAD --cache-dir "$repo.cache" "$@" >"$out" 2>&1
	rc=$?
	entry_path=$(record_path) || return 1
	entry_log=${entry_path%.json}.log
}

# 1. same-tree report covering a, b and the shell suite: only c runs; verdict PASS records the split.
step "same-tree report"
report="$TMP/passed.txt"
{ hdr "$tree"; printf 'tests/cli/a.test.ts\ntests/cli/b.test.ts\ntests/cli/s.test.sh\n'; } >"$report"
run_verdict same --focused-passed "$report"
if [ "$rc" -eq 0 ]; then ok "same-tree: verdict PASS"; else not_ok "same-tree rc=$rc"; cat "$out"; fi
if grep -q 'full-suite: covered by the focused pass on the same tree: bun=2 shell=1 python=0; complement bun=1 shell=0 python=0' "$out"; then ok "same-tree: complement line names bun=1 shell=0"; else not_ok "same-tree: complement line"; grep 'full-suite' "$out"; fi
if grep -q 'VERDICT PASS .* covered_by_focused=3' "$out"; then ok "same-tree: PASS line counts 3 covered"; else not_ok "same-tree: PASS line"; grep VERDICT "$out"; fi
if ! grep -q 'shell suite ran' "$entry_log"; then ok "same-tree: the covered shell suite did not run"; else not_ok "same-tree: covered shell suite ran"; fi
if python3 -c '
import json, sys
e = json.load(open(sys.argv[1]))["evidence"]
c = e["covered_by_focused"]
assert c["bun"] == ["tests/cli/a.test.ts", "tests/cli/b.test.ts"], c
assert c["shell"] == ["tests/cli/s.test.sh"] and c["py"] == [] and c["ignored"] == [], c
assert c["join"] == "joined", c
assert e["bun_files"] == 1 and e["shell_suites"] == 0, e
' "$entry_path"; then ok "same-tree: cached JSON lists the covered set and the complement counts"; else not_ok "same-tree: cached JSON"; fi

# 2. planted: a report for another tree is ignored and everything runs.
step "planted other-tree report"
{ hdr 0000000000000000000000000000000000000000; printf 'tests/cli/a.test.ts\ntests/cli/b.test.ts\ntests/cli/s.test.sh\n'; } >"$report"
run_verdict other --focused-passed "$report"
if [ "$rc" -eq 0 ] && grep -q 'focused-passed report is for tree 0000000000000000000000000000000000000000, not candidate' "$out" && grep -q 'VERDICT PASS .*bun_ran=3 shell=1 python=0 .*covered_by_focused=0' "$out" && grep -q 'shell suite ran' "$entry_log"; then
	ok "planted other-tree: ignored, all three bun files and the shell suite ran"
else
	not_ok "planted other-tree (rc=$rc)"; cat "$out"
fi
# The verdict json records WHY the report was not joined (attempt 10 of the companion publish left only an
# empty covered set; the stdout line was dropped by the caller).
if python3 -c 'import json,sys; c=json.load(open(sys.argv[1]))["evidence"]["covered_by_focused"]; assert c["join"] == "tree-mismatch:0000000000000000000000000000000000000000", c' "$entry_path"; then ok "planted other-tree: json join names the mismatch"; else not_ok "planted other-tree: json join"; fi

# 3. planted: a complement file that fails fails the verdict even though the report covers the rest.
step "planted failing complement"
pass_repo=$repo
repo="$TMP/failing-complement"
git clone -q "$pass_repo" "$repo"
git -C "$repo" config user.name "NODOUBLEPASS1 failing test"
git -C "$repo" config user.email "nodoublepass1-failing@example.invalid"
printf 'import { test, expect } from "bun:test";\ntest("c", () => { expect(1).toBe(2); });\n' >"$repo/tests/cli/c.test.ts"
git -C "$repo" add tests/cli/c.test.ts
git -C "$repo" commit -q -m "[test] plant failing complement"
tree=$(git -C "$repo" rev-parse 'HEAD^{tree}')
{ hdr "$tree"; printf 'tests/cli/a.test.ts\ntests/cli/b.test.ts\ntests/cli/s.test.sh\n'; } >"$report"
run_verdict failc --focused-passed "$report"
if [ "$rc" -ne 0 ] && grep -q 'VERDICT FAIL .*bun_fail=1' "$out"; then ok "planted failing complement: verdict FAIL bun_fail=1"; else not_ok "planted failing complement (rc=$rc)"; grep VERDICT "$out"; fi
if grep -q 'FULL-SUITE: failing tests' "$out" && grep -q 'tests/cli/c.test.ts: (fail) c' "$out"; then ok "planted failing complement: the failing test is named in the gate output"; else not_ok "failing test not named"; grep -A3 'failing tests' "$out"; fi
fail_pass_out="$TMP/verdictid1-fail-require-pass.out"
python3 "$KITROOT_DIR/scripts/full-suite-verdict-store.py" require-pass \
	--repo "$repo" --tree "$tree" --role base --judge-root "$KITROOT_DIR" --suite-root "$repo" \
	--cache-dir "$repo.cache" >"$fail_pass_out" 2>&1
fail_pass_rc=$?
if [ "$fail_pass_rc" -ne 0 ] && grep -qx 'FAIL' "$fail_pass_out"; then
	ok "VERDICTID1: a complete FAIL record is never served as PASS"
else
	not_ok "VERDICTID1: failing record require-pass returned rc=$fail_pass_rc"
	cat "$fail_pass_out"
fi
repo=$pass_repo
tree=$(git -C "$repo" rev-parse 'HEAD^{tree}')
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
# The rendezvous lives in the directory each suite runs in: the runner starts a suite in its archive
# (the suite path is archive-relative), whatever OMP_KIT_CASE_CWD the caller or the runner exports.
step "parallel shell complement"
repo="$TMP/par"
par_archive="$TMP/par-archive"
mkdir -p "$repo/scripts" "$repo/tests/cli" "$par_archive"
cp "$KITROOT_DIR/scripts/kitlib-tmp.sh" "$repo/scripts/kitlib-tmp.sh"
# shellcheck disable=SC2016 # the fixture body is literal shell, expanded by the suite
par_body='name=$(basename "$0" .test.sh)
echo "complement suite $name ran"
probe="$(pwd -P)/var/agent-tmp/par-probe"
mkdir -p "$probe"
: >"$probe/up.$name"
peer=
case "$name" in s2) peer=s3 ;; s3) peer=s2 ;; esac
if [ -n "$peer" ]; then
	k=0
	while [ ! -e "$probe/up.$peer" ] && [ "$k" -lt 200 ]; do sleep 0.1; k=$((k + 1)); done
	if [ -e "$probe/up.$peer" ]; then : >"$probe/overlap.$name"; fi
	sleep 0.3
fi
rm -f "$probe/up.$name"
[ "$name" != s3 ] || exit 4'
for n in s1 s2 s3 s4; do printf '%s\n' "$par_body" >"$repo/tests/cli/$n.test.sh"; done
git -C "$repo" init -q
git -C "$repo" config user.name "FULLSUITEPAR1 test"
git -C "$repo" config user.email "fullsuitepar1@example.invalid"
git -C "$repo" add -A
git -C "$repo" commit -q -m "[test] FULLSUITEPAR1 complement fixture"
tree=$(git -C "$repo" rev-parse 'HEAD^{tree}')
git -C "$repo" archive HEAD | tar -xf - -C "$par_archive"
mkdir -p "$par_archive/var/agent-tmp/par-probe"
{ hdr "$tree"; printf 'tests/cli/s1.test.sh\n'; } >"$report"
FULL_SUITE_SHELL_JOBS=2 run_verdict par --archive-dir "$par_archive" --focused-passed "$report"
if [ "$rc" -ne 0 ] && grep -q 'complement bun=0 shell=3 python=0' "$out" && grep -q 'VERDICT FAIL .*shell_red=1' "$out" && grep -q '  RED script-suite tests/cli/s3.test.sh rc=4' "$out"; then
	ok "parallel complement: a failing complement suite fails the verdict and is named"
else
	not_ok "parallel complement (rc=$rc)"; grep -E 'full-suite|VERDICT|RED' "$out"
fi
if [ -e "$par_archive/var/agent-tmp/par-probe/overlap.s2" ] && [ -e "$par_archive/var/agent-tmp/par-probe/overlap.s3" ] && grep -q 'shell stage: 3 suites, 2 at a time' "$entry_log"; then
	ok "parallel complement: the complement suites ran two at a time"
else
	not_ok "parallel complement: no overlap between complement suites"; find "$par_archive/var/agent-tmp/par-probe" -type f -print
fi
if ! grep -q 'complement suite s1 ran' "$entry_log" && python3 -c '
import json, sys
e = json.load(open(sys.argv[1]))["evidence"]
assert (e["shell_suites"], e["shell_fail"]) == (3, 1), e
assert e["covered_by_focused"]["shell"] == ["tests/cli/s1.test.sh"], e
' "$entry_path"; then ok "parallel complement: the covered suite did not run; JSON counts 3 suites, 1 failed"; else not_ok "parallel complement: covered suite ran or JSON counts"; fi

# SUITEBUDGET1: retain every executed file and the focused file's actual
# prior measurement, even on FAIL.
if python3 -c '
import json, sys
v = json.load(open(sys.argv[1]))
assert v["version"] == 3 and v["judge_role"] == "base", v
rows = v["evidence"]["files"]
assert {r["path"] for r in rows} == {
    "tests/cli/s1.test.sh", "tests/cli/s2.test.sh", "tests/cli/s3.test.sh", "tests/cli/s4.test.sh"
}, rows
assert all(r["runner"] == "sh" and r["elapsed_ms"] >= 0 for r in rows), rows
assert next(r for r in rows if r["path"].endswith("s3.test.sh"))["rc"] == 4, rows
assert v["timing"]["wall_ms"] >= 0 and v["timing"]["workers"]["shell"] == 2
' "$entry_path"; then ok "suite budgets: complete per-file timing and failing rc retained"; else not_ok "suite budgets: missing per-file timing"; fi

# A complete cached verdict is reusable; deleting one measured row makes it cold.
FULL_SUITE_SHELL_JOBS=2 sh "$VERDICT" --repo "$repo" --commit HEAD --cache-dir "$repo.cache" --judge-role base --focused-passed "$report" \
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
' "$entry_path"
FULL_SUITE_SHELL_JOBS=2 sh "$VERDICT" --repo "$repo" --commit HEAD --cache-dir "$repo.cache" --judge-role base --focused-passed "$report" \
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
entry,tree=Path(sys.argv[1]),sys.argv[2]
cache=Path(sys.argv[3])
v=json.load(open(entry))
assert len(v["evidence"]["files"]) == 3
table=json.load(open(cache/"timings/core-test-timings.json"))["files"]
assert table["tests/cli/deleted.test.ts"] == 99
for name in ("a","b","c"):
    assert 0 <= table["tests/cli/"+name+".test.ts"] < 99999999
timing_files=sorted(entry.parent.glob(entry.stem + ".timings.*.csv"))
assert len(timing_files) == 1, timing_files
with open(timing_files[0]) as f:
    rows=list(csv.DictReader(f))
assert len(rows)==3 and all(r["stage"]=="bun" and r["rc"]=="0" for r in rows)
assert {"file","elapsed_s","workers","load_1m"}.issubset(rows[0])
' "$entry_path" "$tree" "$repo.cache"; then
	ok "native timings: all three observations refreshed; deleted entry retained; CSV is complete"
else
	not_ok "native timings: refresh contract failed"; cat "$out"
fi

sh "$VERDICT" --repo "$repo" --commit HEAD --cache-dir "$repo.cache" --judge-role base >"$TMP/pass-cache-control.out" 2>&1
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
' "$entry_path"
sh "$VERDICT" --repo "$repo" --commit HEAD --cache-dir "$repo.cache" --judge-role base >"$TMP/pass-cache-corrupt.out" 2>&1
cache_rc=$?
if [ "$cache_rc" -eq 0 ] && grep -q 'cache miss' "$TMP/pass-cache-corrupt.out" && python3 -c '
import json,sys
v=json.load(open(sys.argv[1]))
assert v["verdict"]=="PASS" and all(row["rc"]==0 for row in v["evidence"]["files"])
' "$entry_path"; then
	ok "timing cache: a failed file invalidates aggregate PASS and is re-executed"
else
	not_ok "timing cache: aggregate PASS hid a failed file"; cat "$TMP/pass-cache-corrupt.out"
fi

step "VERDICTID1 role-bound archive reuse"
rm -rf "$repo.cache"
sh "$VERDICT" --repo "$repo" --commit HEAD --cache-dir "$repo.cache" --judge-role base >"$TMP/verdictid1-base.out" 2>&1
base_rc=$?
entry_path=$(record_path) || exit 1
archive="$TMP/three-files-exact-archive"
mkdir -p "$archive"
git -C "$repo" archive HEAD | tar -xf - -C "$archive"
sh "$VERDICT" --repo "$repo" --commit HEAD --archive-dir "$archive" --cache-dir "$repo.cache" --judge-role base >"$TMP/verdictid1-archive.out" 2>&1
archive_rc=$?
if [ "$base_rc" -eq 0 ] && [ "$archive_rc" -eq 0 ] && grep -q 'VERDICT REUSED PASS' "$TMP/verdictid1-archive.out" && ! grep -q 'running the complete suite' "$TMP/verdictid1-archive.out"; then
	ok "VERDICTID1: base producer reused by archive-mode consumer without rerunning"
else
	not_ok "VERDICTID1: base/archive reuse (base_rc=$base_rc archive_rc=$archive_rc)"
	cat "$TMP/verdictid1-base.out" "$TMP/verdictid1-archive.out"
fi

step "VERDICTID1 second-checkout main verdict readback"
shared_seed="$TMP/verdictid1-seed"
shared_origin="$TMP/verdictid1-origin.git"
shared_a="$TMP/verdictid1-checkout-a"
shared_b="$TMP/verdictid1-checkout-b"
mkdir -p "$shared_seed/scripts" "$shared_seed/tests/cli"
cp "$KITROOT_DIR/scripts/kitlib-tmp.sh" "$shared_seed/scripts/kitlib-tmp.sh"
printf '#!/bin/sh\necho "shared checkout suite ran"\n' >"$shared_seed/tests/cli/shared.test.sh"
git -C "$shared_seed" init -q
git -C "$shared_seed" config user.name "VERDICTID1 test"
git -C "$shared_seed" config user.email "verdictid1@example.invalid"
git -C "$shared_seed" add -A
git -C "$shared_seed" commit -q -m "[test] shared verdict fixture"
git init --bare -q "$shared_origin"
git -C "$shared_seed" push -q "$shared_origin" HEAD:refs/heads/main
git clone -q "$shared_origin" "$shared_a"
git clone -q "$shared_origin" "$shared_b"
shared_tree=$(git -C "$shared_a" rev-parse 'HEAD^{tree}')
shared_archive="$TMP/verdictid1-release-source"
mkdir -p "$shared_archive"
git -C "$shared_a" archive HEAD | tar -xf - -C "$shared_archive"
mkdir -p "$TMP/verdictid1-config" "$TMP/verdictid1-state" "$TMP/verdictid1-home"
XDG_CONFIG_HOME="$TMP/verdictid1-config" XDG_STATE_HOME="$TMP/verdictid1-state" HOME="$TMP/verdictid1-home" \
	KITROOT="$KITROOT_DIR" OMP_KIT_OMP_SRC_FETCH=0 \
	sh "$VERDICT" --repo "$shared_b" --commit HEAD --judge-role main >"$TMP/verdictid1-main-producer.out" 2>&1
main_rc=$?
XDG_CONFIG_HOME="$TMP/verdictid1-config" XDG_STATE_HOME="$TMP/verdictid1-state" HOME="$TMP/verdictid1-home" \
	python3 "$KITROOT_DIR/scripts/full-suite-verdict-store.py" require-pass \
	--repo "$shared_a" --tree "$shared_tree" --role main --judge-root "$KITROOT_DIR" --suite-root "$shared_archive" \
	>"$TMP/verdictid1-release-readback.out" 2>&1
release_rc=$?
if [ "$main_rc" -eq 0 ] && [ "$release_rc" -eq 0 ]; then
	ok "VERDICTID1: main verdict from second checkout is reusable by release-local readback in the first"
else
	not_ok "VERDICTID1: cross-checkout release readback (producer_rc=$main_rc readback_rc=$release_rc)"
	cat "$TMP/verdictid1-main-producer.out" "$TMP/verdictid1-release-readback.out"
fi
XDG_CONFIG_HOME="$TMP/verdictid1-config" XDG_STATE_HOME="$TMP/verdictid1-state" HOME="$TMP/verdictid1-home" \
	sh "$VERDICT" --repo "$shared_a" --commit HEAD --judge-role base >"$TMP/verdictid1-base-producer.out" 2>&1
base_rc=$?
if [ "$base_rc" -eq 0 ] && grep -q "VERDICT PASS .* role=base" "$TMP/verdictid1-base-producer.out"; then
	ok "VERDICTID1: a second distinct judge record is produced"
else
	not_ok "VERDICTID1: second judge record producer (rc=$base_rc)"
	cat "$TMP/verdictid1-base-producer.out"
fi

list_json=$(XDG_CONFIG_HOME="$TMP/verdictid1-config" XDG_STATE_HOME="$TMP/verdictid1-state" HOME="$TMP/verdictid1-home" \
	bun "$KITROOT_DIR/src/cli.ts" full-suite verdict list --repo "$shared_a" --json 2>"$TMP/verdictid1-list.err")
list_rc=$?
if [ "$list_rc" -eq 0 ] && printf '%s' "$list_json" | python3 -c '
import json,sys
d=json.load(sys.stdin)["data"]
rows=d["records"]
assert len(rows)==2, rows
assert {row.get("tree") for row in rows} == {sys.argv[1]}, rows
by_role={row.get("judge", {}).get("role"): row for row in rows}
assert set(by_role)=={"base","main"}, rows
assert len({row.get("record") for row in rows})==2, rows
for role,row in by_role.items():
    judge=row["judge"]
    assert row.get("verdict")=="PASS" and row.get("integrity")=="VALID", row
    assert len(judge.get("checks_sha256",""))==64, row
    runtime=judge.get("runtime","")
    assert "/env-" in runtime and len(runtime.rsplit("/env-",1)[1])==64, row
    expected=(row["tree"] + f" judge={role} checks=" + judge["checks_sha256"]
              + " runtime=" + runtime + " verdict=PASS integrity=VALID record=" + row["record"])
    assert expected in d["text"], (expected,d["text"])
' "$shared_tree"; then
	ok "VERDICTID1: CLI list exposes every tree, judge identity, verdict, and integrity row"
else
	not_ok "VERDICTID1: CLI list (rc=$list_rc)"
	printf '%s\n' "$list_json" "$(cat "$TMP/verdictid1-list.err")"
fi

step "VERDICTID1 changed judge hash is a miss"
other_judge="$TMP/verdictid1-other-judge"
python3 - "$KITROOT_DIR" "$other_judge" <<'PY'
import importlib.util
from pathlib import Path
import shutil, sys
root, target = Path(sys.argv[1]), Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("suite_metrics", root / "scripts/suite-metrics.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
for name in module.JUDGING_FILES:
    source, destination = root / name, target / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
with (target / "scripts/full-suite-verdict-store.py").open("a", encoding="utf-8") as handle:
    handle.write("\n# planted different judge identity\n")
PY
XDG_CONFIG_HOME="$TMP/verdictid1-config" XDG_STATE_HOME="$TMP/verdictid1-state" HOME="$TMP/verdictid1-home" \
	python3 "$KITROOT_DIR/scripts/full-suite-verdict-store.py" require-pass \
	--repo "$shared_a" --tree "$shared_tree" --role main --judge-root "$other_judge" --suite-root "$shared_archive" \
	>"$TMP/verdictid1-other-judge.out" 2>&1
other_judge_rc=$?
if [ "$other_judge_rc" -ne 0 ] && grep -q 'MISS' "$TMP/verdictid1-other-judge.out"; then
	ok "VERDICTID1: a different judge hash is a MISS"
else
	not_ok "VERDICTID1: changed judge hash reused or did not name MISS (rc=$other_judge_rc)"
	cat "$TMP/verdictid1-other-judge.out"
fi
step "VERDICTID1 truncated record is a miss"
main_record=$(XDG_CONFIG_HOME="$TMP/verdictid1-config" XDG_STATE_HOME="$TMP/verdictid1-state" HOME="$TMP/verdictid1-home" \
	python3 "$KITROOT_DIR/scripts/full-suite-verdict-store.py" path \
	--repo "$shared_a" --tree "$shared_tree" --role main --judge-root "$KITROOT_DIR")
path_rc=$?
if [ "$path_rc" -eq 0 ] && [ -f "$main_record" ]; then
	printf '{"version":' >"$main_record"
fi
XDG_CONFIG_HOME="$TMP/verdictid1-config" XDG_STATE_HOME="$TMP/verdictid1-state" HOME="$TMP/verdictid1-home" \
	python3 "$KITROOT_DIR/scripts/full-suite-verdict-store.py" require-pass \
	--repo "$shared_a" --tree "$shared_tree" --role main --judge-root "$KITROOT_DIR" --suite-root "$shared_archive" \
	>"$TMP/verdictid1-truncated-record.out" 2>&1
truncated_rc=$?
if [ "$path_rc" -eq 0 ] && [ "$truncated_rc" -ne 0 ] && grep -qx 'MISS' "$TMP/verdictid1-truncated-record.out"; then
	ok "VERDICTID1: a truncated record is a MISS"
else
	not_ok "VERDICTID1: truncated record was not a MISS (path_rc=$path_rc require_pass_rc=$truncated_rc)"
	cat "$TMP/verdictid1-truncated-record.out"
fi

printf 'full-suite-complement: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = 0 ]
