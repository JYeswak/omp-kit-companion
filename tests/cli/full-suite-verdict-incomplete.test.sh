#!/bin/sh
# shellcheck disable=SC1091
# shellcheck source=tests/cli/git-env-fixtures.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/git-env-fixtures.sh"
# full-suite-verdict-incomplete.test.sh — FULLSUITELOG1 (ompkit-lrbd.6).
# A suite run that ends without complete evidence is non-pass, caches no verdict, and keeps its
# output at the printed <tree>.incomplete.log path. A complete run still records <tree>.log plus
# the <tree>.json verdict.
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
if [ ! -e "$cache/$tree.running.log.status" ] && [ ! -e "$cache/$tree.running.log.bun" ]; then ok "runner side files removed"; else not_ok "runner side files left in cache"; fi

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
	if [ ! -e "$cache/$tree.running.log.status" ] && [ ! -e "$cache/$tree.running.log.bun" ]; then ok "timed-out run removes runner side files"; else not_ok "timed-out run left runner side files"; fi
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

# FULLSUITECANCEL1: observe the public terminal BEFORE the outer kitlib run drains
# the deliberately broken fixture's remaining process group. That cleanup must
# never turn a leaked child into a passing cancellation observation.
mkrepo_begin external_cancel
addfile control.txt 'retained-control'
addfile tests/cli/control.test.ts 'import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "bun:test";
test("real cancellation fixture reads its declared input", () => {
  expect(readFileSync("control.txt", "utf8")).toBe("retained-control\n");
  writeFileSync(process.env.CANCEL_BUN_DONE!, "bun completed");
});'
addfile tests/cli/after_test.py 'import os
from pathlib import Path
assert Path("control.txt").read_text() == "retained-control\n"
Path(os.environ["CANCEL_PY_DONE"]).write_text("python completed")'
cat >"$repo/tests/cli/cancel.test.sh" <<'SH'
exec python3 -c '
import json, os, signal
from pathlib import Path
signal.alarm(20)  # independent safety bound for the deliberately escaped fixture
if os.environ["CANCEL_MODE"] in ("escaped-session", "escaped-deadline"):
    os.setsid()
fd = os.open(os.environ["CANCEL_FIFO"], os.O_RDWR)
Path(os.environ["CANCEL_READY"]).write_text(json.dumps({"pid": os.getpid()}))
command = os.read(fd, 1)
if command == b"k":
    # Controlled fixture: kill only this synthetic suite runner, then remain
    # alive so the outer observer can detect an undrained descendant.
    os.kill(os.getppid(), signal.SIGKILL)
    os.read(fd, 1)
elif command == b"d":
    os.kill(os.getpid(), signal.SIGKILL)
Path(os.environ["CANCEL_LATE"]).write_text("late suite write")
os.close(fd)
'
SH
mkrepo_commit
if KITROOT_DIR="$KITROOT_DIR" CANCEL_VERDICT="$VERDICT" CANCEL_REPO="$repo" CANCEL_TMP="$TMP" python3 - <<'PY'
import json, os, sys
from pathlib import Path
sys.path.insert(0, os.path.join(os.environ["KITROOT_DIR"], "scripts"))
from kitlib_run import run

observer = r'''
import json, os, signal, subprocess, sys
from pathlib import Path
sys.path.insert(0, os.path.join(os.environ["KITROOT_DIR"], "scripts"))
from kitlib_poll import poll_until
from kitlib_proc import incarnation, probe_incarnation
from kitlib_run import run

mode = os.environ["CANCEL_MODE"]
root = Path(os.environ["CANCEL_TMP"]) / ("cancel-" + mode)
root.mkdir()
fifo, ready, late, bun_done, py_done = (root / name for name in
    ("release.fifo", "ready.json", "suite.done", "bun.done", "python.done"))
os.mkfifo(fifo)
env = dict(os.environ, CANCEL_FIFO=str(fifo), CANCEL_READY=str(ready), CANCEL_LATE=str(late),
           CANCEL_BUN_DONE=str(bun_done), CANCEL_PY_DONE=str(py_done),
           FULL_SUITE_RUNTIME_ID="cancel-fixture-" + mode)
repo = os.environ["CANCEL_REPO"]
if mode == "escaped-deadline":
    env["FULL_SUITE_TIMEOUT_SECS"] = "5"
checked = root / "ownership-check.json"
if mode in ("unknown-ownership", "stale-ownership"):
    # Fault only the public runner's OS birth-time query. All suite execution,
    # fresh reuse detection, signalling and terminal observations remain real.
    scripts = str(Path(os.environ["CANCEL_VERDICT"]).parent)
    env.update(CANCEL_FAULT_SCRIPTS=scripts, CANCEL_FAULT_CHECKED=str(checked),
               PYTHONPATH=str(root) + os.pathsep + env.get("PYTHONPATH", ""))
    (root / "sitecustomize.py").write_text(r"""
import json, os, sys
from pathlib import Path
if len(sys.argv) == 3 and sys.argv[0] == "-" and sys.argv[1] == os.environ["CANCEL_FAULT_SCRIPTS"]:
    sys.path.insert(0, sys.argv[1])
    import kitlib_proc
    mode = os.environ["CANCEL_MODE"]
    if sys.argv[2].isdigit():
        if mode == "unknown-ownership":
            kitlib_proc._default_ps = lambda pid: kitlib_proc.PsRead(None, False, "")
        else:
            kitlib_proc._default_ps = lambda pid: kitlib_proc.PsRead(0, False, "S Thu Jan 1 00:00:00 1970")
    elif mode == "stale-ownership":
        actual_probe = kitlib_proc.probe_incarnation
        def observed_probe(recorded):
            result = actual_probe(recorded)
            Path(os.environ["CANCEL_FAULT_CHECKED"]).write_text(json.dumps(result))
            return result
        kitlib_proc.probe_incarnation = observed_probe
""")
cache = repo + ".cache-" + mode
log = root / "observer.log"

def release_suite(command):
    release = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
    try:
        os.write(release, command)
    finally:
        os.close(release)

# pysafe: these two fixture handles are created here; observations deliberately
# precede the enclosing kitlib run's cleanup, which owns their whole session.
control = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.buffer.read(1)"],
                           stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
with log.open("wb") as output:
    # pysafe: the captured direct child is the public runner being cancelled.
    runner = subprocess.Popen(["sh", os.environ["CANCEL_VERDICT"], "--repo", repo,
                               "--commit", "HEAD", "--cache-dir", cache],
                              stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, env=env)
    try:
        def ready_state(_):
            try:
                return json.loads(ready.read_text())
            except (OSError, ValueError):
                return None
        reached = poll_until(ready_state, deadline_s=15, interval_s=0.02,
                             classify=lambda value: "success" if value else "retry")
        assert reached.outcome == "success", log.read_text()
        child = incarnation(reached.observation["pid"])
        assert child is not None and runner.poll() is None
        assert bun_done.read_text() == "bun completed"
        snapshot = run(["ps", "-A", "-o", "pid=", "-o", "ppid="],
                       deadline_s=5, max_output_bytes=1048576)
        assert snapshot.rc == 0 and not snapshot.truncated
        parents = {int(row[0]): int(row[1]) for row in
                   (line.split() for line in snapshot.stdout.decode().splitlines()) if len(row) == 2}
        owned = {runner.pid}
        while True:
            expanded = owned | {pid for pid, parent in parents.items() if parent in owned}
            if expanded == owned:
                break
            owned = expanded
        witnesses = [incarnation(pid) for pid in owned if pid != runner.pid]
        assert all(value is not None for value in witnesses)
        if mode in ("TERM", "INT", "escaped-session", "unknown-ownership", "stale-ownership"):
            runner.send_signal(signal.SIGINT if mode == "INT" else signal.SIGTERM)
            if mode in ("unknown-ownership", "stale-ownership"):
                refused = poll_until(
                    lambda _: ("ownership UNKNOWN" in log.read_text()) if mode == "unknown-ownership" else checked.exists(),
                    deadline_s=5, interval_s=0.02, classify=lambda value: "success" if value else "retry")
                assert refused.outcome == "success", log.read_text()
                if mode == "stale-ownership":
                    assert json.loads(checked.read_text())["state"] == "reused"
                assert probe_incarnation(child)["state"] == "live" and control.poll() is None
                release_suite(b"c")
        elif mode != "escaped-deadline":
            release_suite({"runner-death": b"k", "child-death": b"d", "normal": b"c"}[mode])
        terminal = runner.wait(timeout=15)
        survivors = [probe_incarnation(value) for value in witnesses]
        control_survives = control.poll() is None
        if probe_incarnation(child)["state"] == "live":
            release_suite(b"x")
            settled = poll_until(lambda _: probe_incarnation(child)["state"],
                                 deadline_s=5, interval_s=0.02,
                                 classify=lambda state: "success" if state in ("dead", "zombie", "reused") else "retry")
            assert settled.outcome == "success", "owned escaped fixture did not finish after release"
        facts = {"case": mode, "terminal": terminal, "owned_after_terminal": survivors,
                 "unrelated_control_survives": control_survives,
                 "suite_marker_exists": late.exists(), "python_phase_completed": py_done.exists()}
        print("FULLSUITECANCEL1 before outer cleanup:", json.dumps(facts), flush=True)
        assert (terminal == 0) == (mode == "normal"), facts
        assert control_survives
        assert all(value["state"] in ("dead", "zombie", "reused") for value in survivors), facts
        completed = mode in ("normal", "unknown-ownership", "stale-ownership")
        assert late.exists() == completed, facts
        tree = run(["git", "-C", repo, "rev-parse", "HEAD^{tree}"], deadline_s=5)
        assert tree.rc == 0
        entry = Path(cache) / (tree.stdout.decode().strip() + ".json")
        if mode in ("normal", "child-death"):
            verdict = json.loads(entry.read_text())["verdict"]
            assert verdict == ("PASS" if mode == "normal" else "FAIL"), verdict
            assert py_done.read_text() == "python completed"
        else:
            assert not entry.exists()
            assert py_done.exists() == completed
            diagnostic = log.read_text().lower()
            assert "signal" in diagnostic or "incomplete" in diagnostic or "cancel" in diagnostic, diagnostic
    finally:
        if runner.poll() is None:
            runner.terminate()
            try:
                runner.wait(timeout=5)
            except subprocess.TimeoutExpired:
                runner.kill()
                runner.wait(timeout=5)
        control.stdin.write(b"x")
        control.stdin.close()
        control.wait(timeout=5)
'''
failed = False
for mode in ("TERM", "INT", "runner-death", "child-death", "escaped-session",
             "escaped-deadline", "unknown-ownership", "stale-ownership", "normal"):
    result = run([sys.executable, "-c", observer], deadline_s=40,
                 max_output_bytes=2097152, env=dict(os.environ, CANCEL_MODE=mode))
    sys.stdout.buffer.write(result.stdout)
    sys.stderr.buffer.write(result.stderr)
    failed = failed or result.rc != 0 or result.timed_out or result.truncated
raise SystemExit(1 if failed else 0)
PY
then ok "cancellation/deadline drains owned trees; unknown/stale ownership refuses; complete and unrelated controls survive"
else not_ok "full-suite lifecycle effects or normal/failing control verdicts are incorrect"
fi

echo "full-suite-verdict-incomplete: pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
