"""E2E for CC4b guard receipts (bead ompkit-fp72.120.16.7.2). In an owned scratch state: a real
temp git repo plus a real temp br db; the real kit-flywheel-guard (bun driver reusing the
tests/fleet-guard/kit-flywheel-host harness with real process spawn) allows a non-author close,
which is really executed, and the tool_execution_end emits exactly one closeguard bead.status
receipt. Two planted failures: a self-close must be refused AND recorded as action.result refused
with no closed receipt; an error close must emit no receipt. Then diff_snapshots plus the ingester
run over the same state: bead_transitions holds both the snapshot and the receipt rows, no
RECEIPT_WITHOUT_ACTOR_OR_VERIFIER is raised, and the snapshot close stays U-source (reported, not
hidden) for the 7.3 reconciliation. Steps write one JSON object each to <state>/e2e.jsonl with
exactly {bead_id, step, process, fixture_sha, as_of_ms, expected, actual, ok, exit}; exit is
non-zero when a planted failure is not detected."""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

COMPANION = Path(__file__).resolve().parents[1]
OMP_KIT_CC = Path("/Users/josh/Developer/omp-kit/scripts/cc")
sys.path.insert(0, str(OMP_KIT_CC))
import cclib  # noqa: E402

BEAD = "ompkit-fp72.120.16.7.2"
REPO_NAME = "cc4b-receipts-e2e"
COMPANION = Path(__file__).resolve().parents[2]
DRIVER = r"""
import { mkdirSync, writeFileSync } from "node:fs";
const guardMod = await import(process.env.GUARD_SRC);
const hostMod = await import(process.env.HOST_SRC);
const kitFlywheelGuard = guardMod.default;
const { createFlywheelHost } = hostMod;
const [state, repo, db, outPath] = process.argv.slice(2);
const base = process.env.E2E_BASE;
const notices = [];
const respond = (call) => {
	if (call.command === "tmux") return { stdout: "", stderr: "no server", code: 1 };
	if (call.command === "omp-kit") return { stdout: "", stderr: "not under test", code: 1 };
	const p = Bun.spawnSync([call.command, ...call.args],
		{ cwd: call.options && call.options.cwd ? call.options.cwd : repo, env: { ...process.env } });
	return { stdout: p.stdout.toString(), stderr: p.stderr.toString(), code: p.exitCode ?? 1 };
};
const results = {};
async function toolCall(id, command, cwd, env) {
	const h = results._host;
	const [verdict] = await h.emit("tool_call",
		{ toolCallId: id, toolName: "bash", input: { command } }, h.ctx(cwd));
	return verdict === undefined ? null : verdict;
}
const h = await createFlywheelHost(base, { respond });
results._host = h;
const verdicts = {};
// (a) allowed non-author close of BID1
verdicts.allowed = await toolCall("e2e-a", process.env.CLOSE_CMD, repo, null);
if (verdicts.allowed === null) {
	const p = Bun.spawnSync(["sh", "-c", process.env.CLOSE_CMD], { cwd: repo, env: { ...process.env } });
	verdicts.allowed_exec = p.exitCode ?? 1;
	await h.emit("tool_execution_end",
		{ toolCallId: "e2e-a", toolName: "bash", isError: false, result: { stdout: "closed", code: 0 } },
		h.ctx(repo));
}
// (b) planted self-close of BID2 (blocked: never executed, no end event)
verdicts.selfclose = await toolCall("e2e-b", process.env.SELF_CMD, repo, null);
// (c) planted error close of BID3 (allowed, then the execution fails)
verdicts.errorclose = await toolCall("e2e-c", process.env.ERROR_CMD, repo, null);
if (verdicts.errorclose === null) {
	await h.emit("tool_execution_end",
		{ toolCallId: "e2e-c", toolName: "bash", isError: true,
			result: { stdout: "", stderr: "boom", code: 1 } },
		h.ctx(repo));
}
const flat = {};
for (const [k, v] of Object.entries(verdicts)) {
	flat[k] = v === null ? null : (typeof v === "object" && (v.block !== undefined || v.additionalContext !== undefined)
		? { block: v.block === true, reason: String(v.reason || v.additionalContext || "") } : v);
}
flat.notices = h.notices;
writeFileSync(outPath, JSON.stringify(flat));
"""

COMPANION_SCRIPTS = str(COMPANION / "scripts")
if COMPANION_SCRIPTS not in sys.path:
    sys.path.insert(0, COMPANION_SCRIPTS)
from pysafe import run_bounded  # noqa: E402  (cancel-safe spawn: own process group, stdin DEVNULL, hard deadline)
from types import SimpleNamespace  # noqa: E402

def sh(args: list, cwd: Path | None = None, env: dict | None = None) -> SimpleNamespace:
    r = run_bounded([str(a) for a in args], 60, cwd=str(cwd) if cwd else None, env=env)
    if r.outcome != "OK":
        raise RuntimeError(f"command timed out: {args[0] if args else '?'}")
    return SimpleNamespace(returncode=r.returncode, stdout=r.text("stdout"), stderr=r.text("stderr"))

def br(db: Path, *args: str, cwd: Path | None = None) -> dict:
    p = sh(["br", "--db", str(db), *args, "--json"], cwd=cwd)
    if p.returncode != 0:
        raise RuntimeError(f"br {args} failed: {p.stderr[-300:]} {p.stdout[-300:]}")
    return json.loads(p.stdout)


def main() -> int:
    root = COMPANION / "var" / "agent-tmp" / f"cc-cc4b-guard-receipts-e2e.{os.getpid()}"
    root.mkdir(parents=True)
    (root / ".owner").write_text(json.dumps({"pid": os.getpid(), "label": "cc-cc4b-guard-receipts-e2e",
                                             "repo": str(COMPANION),
                                             "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}))
    os.environ["TMPDIR"] = str(root)
    import cc_selftest as base  # noqa: E402  (in-process synthetic screen anchor for this process only)
    import diff_snapshots as ds  # noqa: E402

    state = root / "state"
    w = base.World(root, "state")
    w.now = int(time.time() * 1000)
    (state / "spool").mkdir(parents=True, exist_ok=True)
    repo = root / "repo"
    repo.mkdir()
    db = root / "beads.db"
    log, failures = root / "e2e.jsonl", 0

    git = sh(["git", "init", "--quiet", str(repo)])
    assert git.returncode == 0, git.stderr

    b1 = br(db, "create", "--assignee", "BlueFox", "e2e receipt bead", cwd=repo)["id"]
    b2 = br(db, "create", "--assignee", "BlueFox", "e2e selfclose bead", cwd=repo)["id"]
    b3 = br(db, "create", "--assignee", "BlueFox", "e2e error bead", cwd=repo)["id"]
    # Real br gates the open->closed transition: a transition comment plus one
    # reviewer pass, so the driver's real close exits 0 and the snapshot sees it.
    sh(["br", "--db", str(db), "comments", "add", b1, "-m",
        "transition note: guard-receipt e2e, unit 10 pass + e2e pending"], cwd=repo)
    sh(["br", "--db", str(db), "gate", "report", b1, "--gate", "min_reviewers",
        "--provider", "reviewer:Verifier", "--status", "pass"], cwd=repo)
    prev_rows = json.loads(sh(["br", "--db", str(db), "list", "--all", "--json"],
                              cwd=repo).stdout)["issues"]

    driver_env = dict(os.environ)
    driver_env["CC_STATE"] = str(state)
    driver_env.pop("OMP_KIT_CC", None)
    driver_env["GUARD_SRC"] = str(COMPANION / "extensions" / "kit-flywheel-guard.ts")
    driver_env["HOST_SRC"] = str(COMPANION / "tests" / "fleet-guard" / "kit-flywheel-host.ts")
    driver_env["E2E_BASE"] = str(root)
    driver_env["CLOSE_CMD"] = f"br --db {db} --actor Verifier close {b1} --reason 'verified ev_d2d42c18' --transition-comment 'e2e transition note'"
    driver_env["SELF_CMD"] = f"BR_ACTOR=BlueFox br --db {db} close {b2} --reason 'mine'"
    driver_env["ERROR_CMD"] = f"br --db {db} --actor Verifier close {b3} --reason 'ok'"
    (root / "driver.ts").write_text(DRIVER)
    verdict_path = root / "verdicts.json"
    p = sh(["bun", str(root / "driver.ts"), str(state), str(repo), str(db), str(verdict_path)],
           cwd=COMPANION, env=driver_env)
    if p.returncode != 0 or not verdict_path.is_file():
        print(json.dumps({"ok": False, "log": None, "driver_stderr": p.stderr[-500:]}))
        return 1
    verdicts = json.loads(verdict_path.read_text())

    def spool_rows(producer: str) -> list[dict]:
        rows = []
        d = state / "spool" / producer
        if d.is_dir():
            for name in sorted(p.name for p in d.iterdir()):
                for line in (d / name).read_text().splitlines():
                    if line.strip():
                        rows.append(json.loads(line))
        return rows

    close_rows = spool_rows("closeguard")
    receipts = [r for r in close_rows if r["type"] == "bead.status"]
    refused = [r for r in close_rows if r["type"] == "action.result"]
    fixture_sha = hashlib.sha256(json.dumps(close_rows, sort_keys=True).encode()).hexdigest()

    def step(name: str, process: str, expected, actual, as_of: int | None = None) -> None:
        nonlocal failures
        ok = expected == actual
        failures += 0 if ok else 1
        with open(log, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"bead_id": BEAD, "step": name, "process": process,
                                 "fixture_sha": fixture_sha,
                                 "as_of_ms": w.now if as_of is None else as_of,
                                 "expected": expected, "actual": actual, "ok": ok,
                                 "exit": 0}, sort_keys=True) + "\n")

    good = [r for r in receipts if r["data"].get("observation") == "receipt" and r["data"].get("to_status") == "closed"]
    step("guard_receipt", "real guard allows a non-author close, end emits one receipt",
         {"verdict": None, "exec": 0, "receipts": 1, "actor": "Verifier", "evidence": ["ev_d2d42c18"]},
         {"verdict": verdicts.get("allowed"), "exec": verdicts.get("allowed_exec"),
          "receipts": len(good),
          "actor": good[0]["data"].get("actor") if good else None,
          "evidence": good[0]["data"].get("evidence") if good else None})

    self_v = verdicts.get("selfclose") or {}
    step("plant_selfclose", "planted self-close is refused AND recorded, no closed receipt",
         {"block": True, "refused_records": 1},
         {"block": self_v.get("block"),
          "refused_records": len([r for r in refused if r["data"].get("outcome") == "refused"
                                  and r.get("bead") == b2])})

    step("plant_errorclose", "planted error close emits no receipt",
         {"verdict": None, "receipts_for_b3": 0},
         {"verdict": verdicts.get("errorclose"),
          "receipts_for_b3": len([r for r in receipts if r.get("bead") == b3])})

    cur_rows = json.loads(sh(["br", "--db", str(db), "list", "--all", "--json"], cwd=repo).stdout)["issues"]
    read_ms = int(time.time() * 1000)
    specs = ds.diff_snapshots(prev_rows, cur_rows, REPO_NAME, 1, read_ms)
    specs["appended"] = ds.emit(w.spool("tracker"), REPO_NAME, specs)
    w.ingest()
    trans = w.con.execute(
        "SELECT from_status, to_status, actor, verifier, observation FROM bead_transitions WHERE bead=?",
        (b1,)).fetchall()
    kinds = sorted([r[4], r[1]] for r in trans)
    rec = [r for r in trans if r[4] == "receipt"]
    no_bad_receipt = w.unknown("U-source", f"receipt:{REPO_NAME}") is None
    step("snapshot_plus_ingest", "tracker diff + ingest stores snapshot and receipt rows",
         {"rows": [["receipt", "closed"], ["snapshot", "closed"]],
          "receipt_actor": [["Verifier", "Verifier"]], "no_bad_receipt_u": True},
         {"rows": kinds,
          "receipt_actor": [[r[2], r[3]] for r in rec],
          "no_bad_receipt_u": no_bad_receipt})

    usource = w.unknown("U-source", f"close-actor:{REPO_NAME}") is not None
    step("usource_open", "snapshot close stays U-source for the 7.3 reconciliation",
         {"u_source_open": True}, {"u_source_open": usource})

    print(json.dumps({"ok": failures == 0, "log": str(log), "failures": failures}))
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
