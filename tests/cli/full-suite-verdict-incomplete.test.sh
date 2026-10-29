#!/bin/sh
# shellcheck disable=SC1091
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
# full-suite-verdict-incomplete.test.sh — FULLSUITELOG1 (ompkit-lrbd.6).
# A suite run that ends without complete evidence is non-pass, caches no verdict, and keeps its
# output at the printed <tree>.incomplete.log path. A complete run still records <tree>.log plus
# the <tree>.json verdict. FULLSUITEPAR1 (ompkit-9t6f2): parallel shell suites give the serial
# GREEN/RED lines and counts, and a hung parallel suite is killed by the deadline and named.
set -u

KITROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
# FULL_SUITE_VERDICT_UNDER_TEST lets a planted-negative run point at a scratch copy of the judge.
VERDICT=${FULL_SUITE_VERDICT_UNDER_TEST:-"$KITROOT_DIR/scripts/full-suite-verdict.sh"}
REPO_TMP="$KITROOT_DIR/var/agent-tmp"
mkdir -p "$REPO_TMP"
# shellcheck source=scripts/kitlib-tmp.sh
. "$KITROOT_DIR/scripts/kitlib-tmp.sh"
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP full-suite-verdict-incomplete-test || exit 1

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }
not_ok() { fail=$((fail + 1)); echo "not ok - $1"; }

# mkrepo_begin NAME: empty fixture tree; addfile REL BODY adds files; mkrepo_commit commits them.
mkrepo_begin() {
	repo="$TMP/$1"
	rm -rf "$repo" "$repo.cache"
	mkdir -p "$repo/scripts" "$repo/tests/cli"
	cp "$KITROOT_DIR/scripts/kitlib-tmp.sh" "$repo/scripts/kitlib-tmp.sh"
}
addfile() { mkdir -p "$(dirname "$repo/$1")"; printf '%s\n' "$2" >"$repo/$1"; }
mkrepo_commit() {
	git -C "$repo" init -q
	git -C "$repo" config user.name "FULLSUITELOG1 test"
	git -C "$repo" config user.email "fullsuitelog1@example.invalid"
	git -C "$repo" add -A
	git -C "$repo" commit -q -m "[test] FULLSUITELOG1 fixture"
}
# mkrepo NAME PY_BODY: fixture repo whose candidate commit holds one python suite.
mkrepo() {
	mkrepo_begin "$1"
	addfile tests/cli/fixture_test.py "$2"
	mkrepo_commit
}

run_verdict() {
	out="$TMP/$1.out"
	KITROOT=$KITROOT_DIR OMP_KIT_OMP_SRC_FETCH=0 sh "$VERDICT" --repo "$repo" --commit HEAD --cache-dir "$repo.cache" >"$out" 2>&1
	rc=$?
	tree=$(git -C "$repo" rev-parse 'HEAD^{tree}')
}
# side_files_gone: no runner-private file or dir is left beside the cache entry.
side_files_gone() {
	for side in status bun shell runner timed-out; do
		if [ -e "$cache/$tree.running.log.$side" ]; then return 1; fi
	done
	[ ! -e "$cache/$tree.running.log" ]
}

# Incomplete: the python suite prints a marker, then SIGKILLs the runner loop that would print
# its GREEN/RED line, so the run never accounts for it.
mkrepo incomplete 'import os, signal
print("FULLSUITELOG1-MARKER before runner death", flush=True)
os.kill(os.getppid(), signal.SIGKILL)'
run_verdict incomplete
cache="$repo.cache"
if [ "$rc" -ne 0 ]; then ok "incomplete run exits non-pass (rc=$rc)"; else not_ok "incomplete run exited 0"; fi
if [ ! -e "$cache/$tree.json" ]; then ok "incomplete run caches no verdict"; else not_ok "incomplete run cached $cache/$tree.json"; fi
if [ ! -e "$cache/$tree.log" ]; then ok "incomplete run writes no reusable <tree>.log"; else not_ok "incomplete run left $cache/$tree.log"; fi
if [ ! -e "$cache/$tree.running.log" ]; then ok "incomplete run leaves no running log"; else not_ok "running log left behind"; fi
inc="$cache/$tree.incomplete.log"
if grep -F "partial log: $inc" "$out" >/dev/null; then ok "RED line prints the incomplete log path"; else not_ok "RED line lacks the incomplete log path"; cat "$out"; fi
if [ -f "$inc" ] && grep -F 'FULLSUITELOG1-MARKER before runner death' "$inc" >/dev/null; then
	ok "incomplete log holds the suite output"
else
	not_ok "incomplete log missing or lacks suite output"
fi

# Control: a complete run records <tree>.log plus the cached verdict.
mkrepo complete 'print("FULLSUITELOG1-CONTROL ok")'
run_verdict complete
cache="$repo.cache"
if [ "$rc" -eq 0 ]; then ok "complete run passes"; else not_ok "complete run rc=$rc"; cat "$out"; fi
if [ -f "$cache/$tree.json" ] && grep -F '"verdict": "PASS"' "$cache/$tree.json" >/dev/null; then ok "complete run caches PASS verdict"; else not_ok "complete run cached no PASS verdict"; fi
if grep -F 'FULLSUITELOG1-CONTROL ok' "$cache/$tree.log" >/dev/null 2>&1; then ok "complete run keeps <tree>.log"; else not_ok "complete run has no <tree>.log"; fi
if [ ! -e "$cache/$tree.incomplete.log" ]; then ok "complete run writes no incomplete log"; else not_ok "complete run wrote an incomplete log"; fi

# Suites start with SIGINT at its default, as in a foreground run. The runner launches them in a
# background list, which a non-interactive shell starts with SIGINT ignored; kitlib_tmp_test's
# SIGINT case failed only under this runner (ompkit-lrbd.3).
mkrepo sigdfl 'import signal, sys
handler = signal.getsignal(signal.SIGINT)
print("FULLSUITE-SIGINT handler:", handler)
sys.exit(0 if handler is signal.default_int_handler else 1)'
run_verdict sigdfl
if [ "$rc" -eq 0 ] && grep -F 'VERDICT PASS' "$out" >/dev/null; then
	ok "suites start with the default SIGINT disposition"
else
	not_ok "a suite started with SIGINT not at its default (rc=$rc)"; cat "$out"
fi

# A runner killed mid-run is incomplete even when the status file happens to name every suite: here
# the first suite writes status lines for both suites (FORGE_DIR models a suite that finds the cache)
# and SIGKILLs the runner, so the second suite never runs (Lrbd7Verify's negative 2).
mkrepo_begin forged
# shellcheck disable=SC2016 # the fixture body is literal shell, expanded by the suite
addfile tests/cli/a.test.sh 'for f in "$FORGE_DIR"/*.running.log.status; do
	[ -f "$f" ] && printf "GREEN script-suite tests/cli/a.test.sh\nGREEN script-suite tests/cli/b.test.sh\n" >>"$f"
done
kill -9 "$PPID"'
addfile tests/cli/b.test.sh 'echo "FULLSUITE-B ran"'
mkrepo_commit
mkdir -p "$repo.cache"
FORGE_DIR="$repo.cache"; export FORGE_DIR
run_verdict forged
unset FORGE_DIR
cache="$repo.cache"
if [ "$rc" -ne 0 ] && grep -F 'without complete evidence' "$out" >/dev/null && [ ! -e "$cache/$tree.json" ]; then
	ok "a killed runner is incomplete even when the status lines name every suite"
else
	not_ok "a killed runner's forged status lines were taken as complete (rc=$rc)"; cat "$out"
fi

# (a) Nested markers: a shell suite that itself prints the runner's marker lines (as a nested
# fresh-gate or bun fixture inside a test does) and exits 0. They must not count: complete PASS.
mkrepo_begin nested
addfile tests/cli/nested.test.sh 'echo "GREEN script-suite tests/cli/not-a-suite.test.sh"
echo "GREEN python-suite tests/cli/not_a_suite_test.py"
echo " 0 fail"
exit 0'
addfile tests/cli/fixture_test.py 'print("FULLSUITELOG1-NESTED ok")'
mkrepo_commit
run_verdict nested
cache="$repo.cache"
if [ "$rc" -eq 0 ] && grep -F 'VERDICT PASS' "$out" >/dev/null && grep -F 'shell=1 python=1' "$out" >/dev/null; then
	ok "nested marker lines are not counted: complete PASS"
else
	not_ok "nested markers corrupted the verdict (rc=$rc)"; cat "$out"
fi
if [ -f "$cache/$tree.json" ] && grep -F '"verdict": "PASS"' "$cache/$tree.json" >/dev/null; then ok "nested-marker run caches PASS"; else not_ok "nested-marker run cached no PASS"; fi
if side_files_gone; then ok "runner side files removed"; else not_ok "runner side files left in cache"; ls -la "$cache"; fi

# (b) Masking: the bun phase has a real failing test; a later shell suite prints a nested bun
# summary claiming ' 0 fail'. The verdict must be FAIL, taken from the bun phase's own output.
if command -v bun >/dev/null 2>&1; then
	mkrepo_begin masked
	addfile tests/cli/real.test.ts 'import { expect, test } from "bun:test";
test("FULLSUITELOG1 real failure", () => { expect(1).toBe(2); });'
	addfile worker-control.txt 'ready'
	addfile tests/cli/worker-control.test.ts 'import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
test("FULLSUITELOG1 passing worker reads the candidate", () => { expect(readFileSync("worker-control.txt", "utf8").trim()).toBe("ready"); });'
	addfile tests/cli/later.test.sh 'echo " 1 pass"
echo " 0 fail"
echo "Ran 1 test across 1 file. [5.00ms]"
exit 0'
	mkrepo_commit
	run_verdict masked
	cache="$repo.cache"
	if [ "$rc" -ne 0 ] && grep -F 'VERDICT FAIL' "$out" >/dev/null && grep -F 'bun_fail=1' "$out" >/dev/null; then
		ok "a real bun failure is not masked by a later nested ' 0 fail' (rc=$rc)"
	else
		not_ok "nested bun summary masked the real failure (rc=$rc)"; cat "$out"
	fi
	if [ -f "$cache/$tree.json" ] && grep -F '"verdict": "FAIL"' "$cache/$tree.json" >/dev/null; then ok "masked run caches FAIL"; else not_ok "masked run cached no FAIL"; fi
	if python3 - "$cache/$tree.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as source:
    verdict = json.load(source)
evidence = verdict["evidence"]
sys.exit(0 if verdict["verdict"] == "FAIL" and evidence["complete"] and
         evidence["bun_files"] == 2 and evidence["bun_ran"] == 2 and evidence["bun_fail"] == 1 else 1)
PY
	then ok "the passing worker cannot hide the failing worker in the cached verdict"
	else not_ok "parallel worker failure was not fully accounted for"; cat "$out"
	fi

	# The matched positive changes only the failing candidate, not the judge:
	# its new tree must cache a complete PASS after the previous tree's FAIL.
	addfile tests/cli/real.test.ts 'import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
test("FULLSUITELOG1 recovered worker reads the candidate", () => { expect(readFileSync("worker-control.txt", "utf8").trim()).toBe("ready"); });'
	git -C "$repo" add -- tests/cli/real.test.ts
	git -C "$repo" commit -q -m "[test] FULLSUITELOG1 recovered candidate"
	run_verdict recovered
	cache="$repo.cache"
	if [ "$rc" -eq 0 ] && python3 - "$cache/$tree.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as source:
    verdict = json.load(source)
evidence = verdict["evidence"]
sys.exit(0 if verdict["verdict"] == "PASS" and evidence["complete"] and
         evidence["bun_files"] == 2 and evidence["bun_ran"] == 2 and evidence["bun_fail"] == 0 else 1)
PY
	then ok "the recovered candidate caches a complete passing verdict"
	else not_ok "the recovered candidate did not pass completely"; cat "$out"
	fi

	# (c) A bun phase cut off by the suite deadline still leaves its partial output in the kept
	# incomplete log: the dying runner copies it, or finish_logs appends it when the runner was
	# killed before it could.
	mkrepo_begin bunslow
	addfile tests/cli/slow.test.ts 'import { test } from "bun:test";
test("FULLSUITELOG1 slow", async () => { console.log("FULLSUITELOG1-BUNPARTIAL"); await Bun.sleep(60000); }, 120000);'
	mkrepo_commit
	FULL_SUITE_TIMEOUT_SECS=4; export FULL_SUITE_TIMEOUT_SECS
	run_verdict bunslow
	unset FULL_SUITE_TIMEOUT_SECS
	cache="$repo.cache"
	inc="$cache/$tree.incomplete.log"
	if [ "$rc" -ne 0 ] && grep -F 'timed out' "$out" >/dev/null && [ ! -e "$cache/$tree.json" ] \
		&& grep -F 'FULLSUITELOG1-BUNPARTIAL' "$inc" >/dev/null 2>&1; then
		ok "a timed-out bun phase leaves its partial output in the incomplete log"
	else
		not_ok "timed-out bun partial output missing from the incomplete log (rc=$rc)"; cat "$out"; [ -f "$inc" ] && cat "$inc"
	fi
	if side_files_gone; then ok "timed-out run removes runner side files"; else not_ok "timed-out run left runner side files"; ls -la "$cache"; fi
else
	not_ok "bun is unavailable; the masking case cannot run"
fi

# The native tracker adapter must not inherit the publisher database. Keep the sentinel
# nonempty so an empty or failed inventory cannot masquerade as preservation.
if command -v br >/dev/null 2>&1; then
	actor=${AGENT_NAME:-full-suite-fixture}
	sentinel="$TMP/native-sentinel"
	sentinel_db="$sentinel/.beads/beads.db"
	mkdir -p "$sentinel"
	git -C "$sentinel" init -q
	if (cd "$sentinel" && br --db "$sentinel_db" --actor "$actor" --no-auto-import --no-auto-flush init --prefix sentinel --json) >"$TMP/sentinel-init.out" 2>&1 \
		&& br --db "$sentinel_db" --actor "$actor" --no-auto-import --no-auto-flush create "retained sentinel" --json >"$TMP/sentinel-seed.out" 2>&1 \
		&& br --db "$sentinel_db" --actor "$actor" --no-auto-import --no-auto-flush list --limit 0 --json >"$TMP/sentinel-before.json" 2>"$TMP/sentinel-before.err"; then
		mkrepo_begin native_tracker
		cp "$KITROOT_DIR/scripts/kitlib_run.py" "$KITROOT_DIR/scripts/pysafe.py" "$repo/scripts/"
		addfile tests/cli/tracker_test.py 'import json, os, sys
from pathlib import Path
sys.path.insert(0, "scripts")
from kitlib_run import run

actor = os.environ.get("AGENT_NAME", "full-suite-fixture")
def br(*args, cwd=None):
    result = run(["br", "--actor", actor, "--no-auto-import", "--no-auto-flush", *args],
                 deadline_s=20, max_output_bytes=1048576, cwd=cwd)
    sys.stdout.buffer.write(result.stdout)
    sys.stderr.buffer.write(result.stderr)
    assert result.rc == 0 and not result.truncated and not result.timed_out
    return json.loads(result.stdout)

result = run(["git", "init", "-q"], deadline_s=20)
assert result.rc == 0, result.stderr.decode()
db = Path.cwd() / ".beads" / "beads.db"
br("--db", str(db), "init", "--prefix", "suite", "--json")
created = br("create", "default suite database", "--json")
assert created["id"].startswith("suite-"), created
rows = br("--db", str(db), "list", "--limit", "0", "--json")
rows = rows["issues"] if isinstance(rows, dict) else rows
assert [row["id"] for row in rows] == [created["id"]]

# A test may still deliberately choose a different owned tracker after launch.
chosen_root = Path.cwd() / "chosen"
chosen_root.mkdir()
result = run(["git", "init", "-q", str(chosen_root)], deadline_s=20)
assert result.rc == 0, result.stderr.decode()
chosen = chosen_root / ".beads" / "beads.db"
br("--db", str(chosen), "init", "--prefix", "chosen", "--json", cwd=chosen_root)
os.environ["BEADS_DB"] = str(chosen)
explicit = br("create", "explicit suite database", "--json")
assert explicit["id"].startswith("chosen-"), explicit
rows = br("--db", str(chosen), "list", "--limit", "0", "--json")
rows = rows["issues"] if isinstance(rows, dict) else rows
assert [row["id"] for row in rows] == [explicit["id"]]'
		mkrepo_commit
		inherited_db_set=${BEADS_DB+x}
		inherited_db=${BEADS_DB-}
		BEADS_DB=$sentinel_db; export BEADS_DB
		run_verdict native_tracker
		if [ "$inherited_db_set" = x ]; then BEADS_DB=$inherited_db; export BEADS_DB; else unset BEADS_DB; fi
		if [ "$rc" -eq 0 ]; then ok "native suite creates only its default and explicitly selected tracker rows"
		else not_ok "native suite selected the publisher tracker (rc=$rc)"; cat "$out"
		fi
		[ ! -f "$repo.cache/$tree.log" ] || cat "$repo.cache/$tree.log"
		if br --db "$sentinel_db" --actor "$actor" --no-auto-import --no-auto-flush list --limit 0 --json >"$TMP/sentinel-after.json" 2>"$TMP/sentinel-after.err" \
			&& python3 - "$TMP/sentinel-before.json" "$TMP/sentinel-after.json" <<'PY'
import json, sys
from pathlib import Path
before, after = (json.loads(Path(path).read_text(encoding="utf-8")) for path in sys.argv[1:])
before_rows = before["issues"] if isinstance(before, dict) else before
assert len(before_rows) == 1
assert after == before, (before, after)
print("NATIVEFIXTUREDB1 retained native sentinel:", json.dumps(after, sort_keys=True))
PY
		then ok "the nonempty native sentinel is unchanged by the declared suite"
		else not_ok "the declared suite mutated or could not inventory its native sentinel"
		fi
	else
		not_ok "native tracker fixture initialization failed"
		cat "$TMP/sentinel-init.out" "$TMP/sentinel-seed.out" "$TMP/sentinel-before.err" 2>/dev/null
	fi
else
	echo "NATIVEFIXTUREDB1: optional native br adapter unavailable; native tracker case NOT_RUN"
fi

# FULLSUITEPAR1 (ompkit-9t6f2): shell suites run FULL_SUITE_SHELL_JOBS at a time. Five probe suites
# record their TMPDIR, how many suites were running at once, and (p1/p2 when FSPAR_PAIR=1) whether
# their partner ran at the same time; p3 fails with rc 3, and finishing order is not the sorted order.
# shellcheck disable=SC2016 # the fixture body is literal shell, expanded by the suite
fspar_body='name=$(basename "$0" .test.sh)
d=$FSPAR_DIR
mkdir "$d/run/$name"
echo "FSPAR-OUT $name begin"
suite_tmp=$(printenv TMPDIR) || suite_tmp=
printf "%s\n" "$suite_tmp" >"$d/tmp.$name"
if [ -n "$suite_tmp" ] && [ -f "$suite_tmp/.owner" ]; then : >"$d/owned.$name"; fi
peer=
case "$name" in p1) peer=p2 ;; p2) peer=p1 ;; esac
if [ -n "$peer" ] && [ "${FSPAR_PAIR:-0}" = 1 ]; then
	k=0
	while [ ! -d "$d/run/$peer" ] && [ "$k" -lt 200 ]; do sleep 0.1; k=$((k + 1)); done
	if [ -d "$d/run/$peer" ]; then : >"$d/overlap.$name"; fi
fi
sleep 0.5
ls "$d/run" | wc -l | tr -d " " >"$d/peak.$name"
case "$name" in p1) sleep 1 ;; p3) sleep 0.4 ;; p4) sleep 0.2 ;; esac
rmdir "$d/run/$name"
echo "FSPAR-OUT $name end"
[ "$name" != p3 ] || exit 3'
mkrepo_begin par
for n in p1 p2 p3 p4 p5; do addfile "tests/cli/$n.test.sh" "$fspar_body"; done
mkrepo_commit
# fspar_run LABEL JOBS PAIR: one verdict on the par tree; its cache and probe records move aside.
fspar_run() {
	rm -rf "$TMP/fspar" "$repo.cache"
	mkdir -p "$TMP/fspar/run"
	FSPAR_DIR="$TMP/fspar" FSPAR_PAIR=$3 FULL_SUITE_SHELL_JOBS=$2
	export FSPAR_DIR FSPAR_PAIR FULL_SUITE_SHELL_JOBS
	run_verdict "$1"
	unset FSPAR_DIR FSPAR_PAIR FULL_SUITE_SHELL_JOBS
	rm -rf "$repo.cache.$1" "$TMP/fspar.$1"
	mv "$repo.cache" "$repo.cache.$1"
	mv "$TMP/fspar" "$TMP/fspar.$1"
}
fspar_lines() { grep -E '^(GREEN|RED) script-suite ' "$repo.cache.$1/$tree.log"; }
fspar_order() { grep -E '^(FSPAR-OUT |GREEN script-suite |RED script-suite )' "$repo.cache.$1/$tree.log"; }
fspar_counts() { python3 -c 'import json, sys; e = json.load(open(sys.argv[1]))["evidence"]; print(e["shell_suites"], e["shell_fail"])' "$repo.cache.$1/$tree.json"; }
fspar_peak() { cat "$TMP/fspar.$1"/peak.* | sort -n | tail -n 1; }
fspar_run serial 1 0
serial_out=$out; serial_rc=$rc
fspar_run parallel 3 1
if [ "$serial_rc" -ne 0 ] && [ "$rc" -ne 0 ] && grep -F 'VERDICT FAIL' "$out" >/dev/null && grep -F 'shell_red=1' "$out" >/dev/null; then
	ok "FULLSUITEPAR1 planted failing suite makes the parallel run FAIL (serial rc=$serial_rc, parallel rc=$rc)"
else
	not_ok "FULLSUITEPAR1 planted failing suite did not fail both runs (serial rc=$serial_rc, parallel rc=$rc)"; cat "$serial_out" "$out"
fi
if grep -F '  RED script-suite tests/cli/p3.test.sh rc=3' "$out" >/dev/null; then ok "FULLSUITEPAR1 the parallel FAIL names the failing suite"; else not_ok "FULLSUITEPAR1 the failing suite is not named"; cat "$out"; fi
if [ -n "$(fspar_lines serial)" ] && [ "$(fspar_lines serial | sort)" = "$(fspar_lines parallel | sort)" ]; then
	ok "FULLSUITEPAR1 serial and parallel GREEN/RED line sets are equal"
else
	not_ok "FULLSUITEPAR1 GREEN/RED line sets differ"; fspar_lines serial; fspar_lines parallel
fi
if [ "$(fspar_counts serial)" = "5 1" ] && [ "$(fspar_counts parallel)" = "5 1" ]; then ok "FULLSUITEPAR1 verdict JSON shell_suites/shell_fail match (5 1)"; else not_ok "FULLSUITEPAR1 verdict JSON counts serial='$(fspar_counts serial)' parallel='$(fspar_counts parallel)'"; fi
want_order=$(for n in p1 p2 p3 p4 p5; do
	printf 'FSPAR-OUT %s begin\nFSPAR-OUT %s end\n' "$n" "$n"
	if [ "$n" = p3 ]; then echo "RED script-suite tests/cli/p3.test.sh rc=3"; else echo "GREEN script-suite tests/cli/$n.test.sh"; fi
done)
if [ "$(fspar_order serial)" = "$want_order" ] && [ "$(fspar_order parallel)" = "$want_order" ]; then
	ok "FULLSUITEPAR1 both logs hold each suite's output then its line, in sorted suite order"
else
	not_ok "FULLSUITEPAR1 log order depends on the run"; fspar_order serial; fspar_order parallel
fi
if [ -e "$TMP/fspar.parallel/overlap.p1" ] && [ -e "$TMP/fspar.parallel/overlap.p2" ] && [ "$(fspar_peak parallel)" -ge 2 ] && [ "$(fspar_peak parallel)" -le 3 ]; then
	ok "FULLSUITEPAR1 shell suites ran concurrently, at most 3 at a time (peak $(fspar_peak parallel))"
else
	not_ok "FULLSUITEPAR1 shell suites did not run concurrently within the bound (peak $(fspar_peak parallel))"; ls "$TMP/fspar.parallel"
fi
if [ "$(fspar_peak serial)" = 1 ]; then ok "FULLSUITEPAR1 FULL_SUITE_SHELL_JOBS=1 runs one suite at a time"; else not_ok "FULLSUITEPAR1 jobs=1 peak $(fspar_peak serial)"; fi
set -- "$TMP/fspar.parallel"/owned.*
if [ "$#" -eq 5 ] && [ -e "$1" ] && [ "$(cat "$TMP/fspar.parallel"/tmp.* | sort -u | grep -c .)" -eq 5 ]; then
	ok "FULLSUITEPAR1 every parallel suite ran under its own owned TMPDIR"
else
	not_ok "FULLSUITEPAR1 parallel suites shared or lacked an owned TMPDIR"; cat "$TMP/fspar.parallel"/tmp.*
fi
if grep -F 'shell stage: 5 suites, 3 at a time' "$repo.cache.parallel/$tree.log" >/dev/null; then ok "FULLSUITEPAR1 the log records the shell stage width and time"; else not_ok "FULLSUITEPAR1 no shell stage line in the log"; fi

# Planted hang: h2 loops on short sleeps, so killing only a leaf would let it run on. With three
# workers the deadline must kill the hung suite's whole tree, report it by name and stay incomplete.
mkrepo_begin parhang
addfile tests/cli/h1.test.sh 'echo "FSPAR-HANG-QUICK"'
# shellcheck disable=SC2016 # the fixture body is literal shell, expanded by the suite
addfile tests/cli/h2.test.sh 'echo "FSPAR-HANG-PARTIAL"
echo "$$" >"$FSPAR_DIR/hang.pid"
n=0
while [ "$n" -lt 40 ]; do sleep 1; n=$((n + 1)); done
echo "FSPAR-HANG-SURVIVED"'
addfile tests/cli/h3.test.sh 'echo "FSPAR-HANG-QUICK-3"'
mkrepo_commit
rm -rf "$TMP/fspar"
mkdir -p "$TMP/fspar"
FSPAR_DIR="$TMP/fspar" FULL_SUITE_SHELL_JOBS=3 FULL_SUITE_TIMEOUT_SECS=6
export FSPAR_DIR FULL_SUITE_SHELL_JOBS FULL_SUITE_TIMEOUT_SECS
hang_t0=$(date +%s)
run_verdict parhang
hang_wall=$(($(date +%s) - hang_t0))
unset FSPAR_DIR FULL_SUITE_SHELL_JOBS FULL_SUITE_TIMEOUT_SECS
cache="$repo.cache"
inc="$cache/$tree.incomplete.log"
if [ "$rc" -ne 0 ] && grep -F 'timed out after 6s; unfinished script suites: tests/cli/h2.test.sh;' "$out" >/dev/null && [ ! -e "$cache/$tree.json" ] && [ ! -e "$cache/$tree.log" ]; then
	ok "FULLSUITEPAR1 a hung parallel suite times the run out, named, nothing cached (rc=$rc)"
else
	not_ok "FULLSUITEPAR1 hung suite not reported as an unfinished timeout (rc=$rc)"; cat "$out"
fi
if [ "$hang_wall" -le 25 ]; then ok "FULLSUITEPAR1 the deadline ended the run (${hang_wall}s for a 6s bound)"; else not_ok "FULLSUITEPAR1 the run went on ${hang_wall}s past a 6s bound"; fi
if [ -f "$inc" ] && grep -F 'FSPAR-HANG-PARTIAL' "$inc" >/dev/null && grep -F 'script-suite tests/cli/h2.test.sh did not finish' "$inc" >/dev/null \
	&& grep -F 'FSPAR-HANG-QUICK' "$inc" >/dev/null && ! grep -F 'FSPAR-HANG-SURVIVED' "$inc" >/dev/null; then
	ok "FULLSUITEPAR1 the incomplete log keeps every suite's output and the hung suite's partial output"
else
	not_ok "FULLSUITEPAR1 incomplete log lacks parallel outputs or the hung suite survived"; [ -f "$inc" ] && cat "$inc"
fi
hang_pid=$(cat "$TMP/fspar/hang.pid" 2>/dev/null) || hang_pid=
k=0
while [ -n "$hang_pid" ] && kill -0 "$hang_pid" 2>/dev/null && [ "$k" -lt 50 ]; do sleep 0.1; k=$((k + 1)); done
if [ -n "$hang_pid" ] && ! kill -0 "$hang_pid" 2>/dev/null; then ok "FULLSUITEPAR1 the hung suite process is gone"; else not_ok "FULLSUITEPAR1 hung suite pid ${hang_pid:-?} still runs"; fi
if side_files_gone; then ok "FULLSUITEPAR1 timed-out parallel run removes runner side files"; else not_ok "FULLSUITEPAR1 timed-out parallel run left side files"; ls -la "$cache"; fi

echo "full-suite-verdict-incomplete: pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
