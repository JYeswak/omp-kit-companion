"""fleet-restart autonomous run: plan -> approval -> apply -> report.

`plan_run` writes run-manifest.json: target OMP build (realpath of the login
shell's `omp`), stages, rows with a per-pane mode, watchers to pause, holds,
the stage-1 snapshot dir, canary size and breaker policy (`--only` limits the
rows). Mode RESTART (`/restart`, same pid) only when the pane already runs the
target build and is not a bun launch: /restart re-execs process.execPath and
cannot change version. Every other pane is RESPAWN (tmux respawn-pane into
`zsh -lc 'cd … && omp <live flags> --resume <session>'`), re-validated live
right before its send.

`apply_run` refuses without an approval bound to the manifest's sha, then:
preflight -> save -> watchers pause -> canary panes (RESPAWN preferred) ->
idle panes in waves (send, verify: pid, flags, VERSION_OK, SESSION_KEPT;
advisor re-apply) -> busy panes at their turn boundary -> watchers resume
(always, in `finally`) -> WATCHDOG drift -> report.json/report.md. A failed
canary, or any FAILED/SESSION_LOST/VERSION_STALE verdict (ADVISOR_FAILED with
strict_advisor), trips the breaker: no new sends start, in-flight panes finish.
The chief pane is never touched: the report prints its respawn command. Every
action appends to ledger.jsonl; --resume-run continues from it. The only
keystrokes sent are `/restart` and `/advisor on`. All side effects go through a
Ctx of injected functions."""
import json
import os
import shlex
import subprocess
import sys
import time

import fleet_restart as core
import fr_save
import fr_watchers as fw

HERE = os.path.dirname(os.path.abspath(__file__))
RUN_MANIFEST = "run-manifest.json"
LEDGER = "ledger.jsonl"
STAGES = ["preflight", "save", "watchers-pause", "canary", "idle-waves", "busy-turn-boundary", "watchers-resume", "watchdog-drift", "report"]
CANDIDATES = ("RESTART", "QUEUE_BUSY")
FAILURES = ("FAILED", "SESSION_LOST", "VERSION_STALE")
SEND_HOLDS = {"HELD_COMPOSER": "HOLD_COMPOSER", "HELD_UNKNOWN_STATE": "HOLD_UNKNOWN_STATE"}
EXIT_REFUSED, EXIT_FAILED = 7, 6


class Ctx:
    def __init__(self, env, uid, home, agents_dir, registry, run_fn, capture_fn, inventory_fn, snapshot_fn, lsof_fn, align_fn,
                 preflight_fn, target_fn, sleep_fn=time.sleep, clock_fn=time.time, verify_timeout=120, verify_poll=5, verify_settle=10,
                 advisor_grace=6, advisor_timeout=20, advisor_poll=2, busy_poll=30):
        self.env, self.uid, self.home, self.agents_dir, self.registry = env, uid, home, agents_dir, registry
        self.run_fn, self.capture_fn, self.inventory_fn, self.snapshot_fn, self.lsof_fn = run_fn, capture_fn, inventory_fn, snapshot_fn, lsof_fn
        self.align_fn, self.preflight_fn, self.target_fn, self.sleep_fn, self.clock_fn = align_fn, preflight_fn, target_fn, sleep_fn, clock_fn
        self.verify_timeout, self.verify_poll, self.verify_settle = verify_timeout, verify_poll, verify_settle
        self.advisor_grace, self.advisor_timeout, self.advisor_poll, self.busy_poll = advisor_grace, advisor_timeout, advisor_poll, busy_poll

    def clock(self):
        return self.clock_fn()

    def sleep(self, sec):
        self.sleep_fn(sec)


def live_ctx(env, home, releases, version=None, agents_dir=None, registry_path=fw.REGISTRY_PATH):
    def snapshot_fn(out_dir):
        os.makedirs(os.path.join(out_dir, "panes"), exist_ok=True)
        inv = core.live_inventory(env, lines=core.CAPTURE_LINES, out_dir=out_dir)
        with open(os.path.join(out_dir, "inventory.json"), "w") as fh:
            json.dump(inv, fh, indent=1, ensure_ascii=False)
        return inv

    def preflight_fn():
        p = subprocess.run([sys.executable, os.path.join(HERE, "selftest.py")], capture_output=True, text=True)
        lines = p.stdout.strip().splitlines()
        return p.returncode == 0, lines[-1] if lines else "selftest printed nothing (rc %d)" % p.returncode

    return Ctx(env=env, uid=os.getuid(), home=home, agents_dir=agents_dir or os.path.join(home, "Library", "LaunchAgents"),
               registry=fw.load_registry(registry_path), run_fn=core.run, capture_fn=core.capture_live(env),
               inventory_fn=lambda only=None: core.live_inventory(env, only=only), snapshot_fn=snapshot_fn,
               lsof_fn=fr_save.lsof_live(core.run), align_fn=lambda: core.align_check(home, releases, version or core.kit_version()),
               preflight_fn=preflight_fn, target_fn=lambda: fr_save.target_live(core.run))


class Ledger:
    def __init__(self, path, clock):
        self.path, self.clock = path, clock

    def add(self, event, **kw):
        with open(self.path, "a") as fh:
            fh.write(json.dumps(dict({"at": fw.iso(self.clock()), "event": event}, **kw), ensure_ascii=False) + "\n")

    def events(self):
        try:
            with open(self.path) as fh:
                return [json.loads(ln) for ln in fh if ln.strip()]
        except FileNotFoundError:
            return []


def write_json(path, obj):
    fw.write_json(path, obj)


def shell_line(argv):
    return " ".join(shlex.quote(a) for a in argv)


# ---------- plan ----------

def plan_run(run_dir, ctx, chief, protect, unprotect=(), wave=3, busy_timeout_min=30, canary=1, strict_advisor=False, only=()):
    os.makedirs(run_dir, exist_ok=True)
    snap_dir = os.path.join(run_dir, "snapshot")
    inv = ctx.snapshot_fn(snap_dir)
    plan = core.build_plan(inv, chief, protect, ctx.align_fn(), unprotect)
    write_json(os.path.join(run_dir, "plan.json"), plan)
    save_doc = fr_save.save(inv, ctx.home, ctx.lsof_fn, ctx.run_fn)
    save_doc["stage"] = "plan"
    write_json(os.path.join(run_dir, "save.json"), save_doc)
    target = ctx.target_fn()
    disc = fw.discover(ctx.agents_dir, ctx.registry, ctx.run_fn, ctx.uid)
    saved = {r["pane_id"]: r for r in save_doc["rows"]}
    rows, chief_cmd = [], None
    for r in plan["rows"]:
        s = saved.get(r["pane_id"]) or {}
        row = {k: r.get(k) for k in ("pane", "pane_id", "session", "action", "state", "omp_pid", "args", "flags", "mcp", "mcp_pids", "cwd")}
        row.update({"unprotected": bool(r.get("unprotected")), "session_file": s.get("session_file"), "exe": s.get("exe_real"),
                    "version": s.get("version"), "advisor": {k: s["advisor"][k] for k in ("on", "source")} if s else None,
                    "screen_model": s.get("screen_model"), "holds": s.get("holds", []), "held_scratch": s.get("held_scratch", [])})
        if s and target.get("ok"):
            row["mode"] = fr_save.pane_mode(s, target)
            if row["mode"] == "RESPAWN" and row["action"] in CANDIDATES:
                blocking = [h for h in row["holds"] if h in core.RESPAWN_HOLDS]
                if blocking:
                    row["action"] = blocking[0]  # RESPAWN preconditions: a session file was found
        if r["action"] == "SKIP_CHIEF" and s:
            # The operator runs this by hand, last; an unpushed-scratch hold is a warning to read, not a refusal.
            cr = core.respawn_row(r, dict(s, holds=[h for h in s.get("holds", []) if h != "HOLD_SCRATCH_OWNER"]))
            chief_cmd = {"pane": r["pane"], "argv": core.tmux_respawn_argv(cr) if cr else None, "holds": None if cr else s.get("holds"),
                         "warnings": ["HOLD_SCRATCH_OWNER: %s" % scratch_line(s["held_scratch"])] if s.get("held_scratch") else []}
        rows.append(row)
    refused = [plan["refused"]] if plan.get("refused") else []
    if only:
        unknown = [o for o in only if not any(o in (r["pane"], r["pane_id"]) for r in rows)]
        if unknown:
            refused.append("ONLY_NOT_IN_PLAN:" + ",".join(unknown))
        rows = [r for r in rows if r["pane"] in only or r["pane_id"] in only]
    if not target.get("ok"):
        refused.append("TARGET_UNKNOWN")
    if not chief:
        refused.append("CHIEF_UNKNOWN")
    if disc["unclassified"]:
        refused.append("HOLD_UNCLASSIFIED")
    if disc["deadman_left"]:
        refused.append("PRIOR_RUN_DEADMAN_INSTALLED")
    holds, acts, modes, versions = {}, {}, {}, {}
    for r in rows:
        for kind in ([r["action"]] if r["action"] != "RESTART" else []) + r["holds"]:
            if r["pane"] not in holds.setdefault(kind, []):
                holds[kind].append(r["pane"])
        acts[r["action"]] = acts.get(r["action"], 0) + 1
        if r["action"] in CANDIDATES and r.get("mode"):
            modes[r["mode"]] = modes.get(r["mode"], 0) + 1
        if r.get("version"):
            versions[r["version"]] = versions.get(r["version"], 0) + 1
    man = {"kind": "run", "run_dir": os.path.abspath(run_dir), "created": core.now(), "snapshot_dir": os.path.abspath(snap_dir),
           "snapshot_at": inv.get("captured_at"), "chief": chief, "chief_respawn": chief_cmd, "protect": list(protect), "unprotect": list(unprotect),
           "only": list(only), "wave": wave, "busy_timeout_min": busy_timeout_min, "canary": int(canary), "strict_advisor": bool(strict_advisor),
           "align": plan["align"], "target": target, "stages": STAGES, "rows": rows, "holds": holds, "refused": refused,
           "watchers": {"pause": disc["pause_plan"], "unclassified": [j for j in disc["jobs"] if j["status"] == "HOLD_UNCLASSIFIED"],
                        "unreadable": disc["unreadable"], "registered_missing": disc["registered_missing"], "deadman_left": disc["deadman_left"]},
           "counts": {"agent_panes": sum(1 for r in rows if r.get("omp_pid")), "advisor_on": sum(1 for r in rows if (r.get("advisor") or {}).get("on")),
                      "session_files": sum(1 for r in rows if r.get("session_file")), "actions": acts, "modes": modes, "versions": versions,
                      "watchers_pause": len(disc["pause_plan"]), "watchers_unclassified": len(disc["unclassified"])}}
    man["manifest_sha256"] = core.manifest_sha(man)
    write_json(os.path.join(run_dir, RUN_MANIFEST), man)
    return man


# ---------- apply ----------

def placeholder(approval):
    return "<" in str(approval.get("approved_by", "<")) or "<" in str(approval.get("quote", "<"))


def check_approval(man, approval, unprotect, canary=None, strict_advisor=None):
    """Every behaviour the operator approved lives in the manifest; an apply flag may
    repeat it but never change it."""
    if not approval or placeholder(approval):
        return "APPROVAL_MISSING"
    if approval.get("manifest_sha256") != core.manifest_sha(man) or man.get("manifest_sha256") != core.manifest_sha(man):
        return "APPROVAL_MISMATCH"
    if man.get("refused"):
        return "MANIFEST_REFUSED:" + ",".join(man["refused"])
    if sorted(set(unprotect)) != sorted(set(man.get("unprotect", []))):
        return "UNPROTECT_NOT_IN_MANIFEST"
    if not set(unprotect) <= set(approval.get("unprotect", [])):
        return "UNPROTECT_NOT_APPROVED"
    if canary is not None and int(canary) != int(man.get("canary", 1)):
        return "CANARY_NOT_IN_MANIFEST"
    if strict_advisor is not None and bool(strict_advisor) != bool(man.get("strict_advisor")):
        return "STRICT_ADVISOR_NOT_IN_MANIFEST"
    return None


def gated(ctx, row, approval):
    """One row through core.send: allow-listed keys, or a respawn whose flags match the
    live process and whose saved facts are re-validated live right before the send;
    env check and screen re-read (idle, empty composer) first. The run approval is
    the operator's go for it."""
    if row["kind"] == "keys" and row["text"] not in core.KEYS_ALLOWED:
        raise ValueError("KEYS_NOT_ALLOWED: %r" % row["text"])
    mini = {"kind": "run-" + row["kind"], "rows": [row]}
    ap = {"manifest_sha256": core.manifest_sha(mini), "approved_by": approval["approved_by"], "quote": approval["quote"]}
    res = core.send(mini, True, ap, ctx.env, ctx.uid, ctx.capture_fn, ctx.run_fn,
                    revalidate_fn=fr_save.respawn_revalidator(ctx.inventory_fn, ctx.lsof_fn))
    if res.get("refused"):
        raise RuntimeError("send refused: %s %s" % (res["refused"], res.get("why", "")))
    return res["rows"][0]


def keys_row(r, text):
    return {"pane": r["pane"], "pane_id": r["pane_id"], "session": r["session"], "flags": r["flags"], "kind": "keys", "text": text}


def ledger_state(events):
    """Per pane: sends, the last VERIFY (evidence only), and the VERDICT. Only a
    VERDICT is terminal on --resume-run: it is written once, after the session and
    version checks, so a crash between VERIFY and VERDICT re-verifies (no re-send).
    CONTINUE_AFTER_BREAKER reopens only the HOLD_BREAKER verdicts."""
    st = {}
    for e in events:
        if e["event"] == "CONTINUE_AFTER_BREAKER":
            for s in st.values():
                if (s.get("verdict") or {}).get("result") == "HOLD_BREAKER":
                    s.pop("verdict")
            continue
        if "pane" not in e:
            continue
        s = st.setdefault(e["pane"], {"sent": 0})
        if e["event"] == "SENT":
            s["sent"] += 1
            s.pop("verify", None)
            s.pop("verdict", None)
        elif e["event"] == "VERIFY":
            s["verify"] = e["result"]
        elif e["event"] == "VERDICT":
            s["verdict"] = e
        elif e["event"] == "SEND_LOST":
            s["send_lost"] = True
        elif e["event"] == "ADVISOR":
            s["advisor"] = e["result"]
    return st


def active_breaker(events):
    """The last BREAKER not followed by CONTINUE_AFTER_BREAKER, or None."""
    trip = None
    for e in events:
        if e["event"] == "BREAKER":
            trip = {k: e.get(k) for k in ("pane", "verdict", "canary")}
        elif e["event"] == "CONTINUE_AFTER_BREAKER":
            trip = None
    return trip


def conclude(ledger, results, res):
    """Record a pane's one terminal verdict (results + VERDICT ledger event)."""
    results[res["pane"]] = res
    ledger.add("VERDICT", pane=res["pane"], result=res["result"], mode=res.get("mode"), session=res.get("session"),
               version=res.get("version"), why=res.get("why"))


def trip_verdict(res, strict, canary):
    """Verdict that trips the breaker, or None. A canary must also bring its advisor back."""
    if res["result"] in FAILURES:
        return res["result"]
    if res.get("advisor") == "ADVISOR_FAILED" and (strict or canary):
        return "ADVISOR_FAILED"
    return None


def check_trip(ledger, brk, res, canary=False):
    if brk["trip"]:
        return
    verdict = trip_verdict(res, brk["strict"], canary)
    if verdict:
        brk["trip"] = {"pane": res["pane"], "verdict": verdict, "canary": canary}
        ledger.add("BREAKER", pane=res["pane"], verdict=verdict, canary=canary)


def acted(row, agent):
    """The sent action took effect: RESPAWN -> a new omp pid; RESTART -> same pid but
    MCP children replaced or argv changed (/restart adds --resume)."""
    if row.get("mode") == "RESPAWN":
        return agent["pid"] != row["omp_pid"]
    before = set(row.get("mcp_pids") or [])
    if before and agent["mcp_pids"] and before.isdisjoint(agent["mcp_pids"]):
        return True
    return bool(row.get("args")) and agent["args"] != row["args"]


def verify_pane(ctx, row, saved, target, ledger):
    """Poll until verified or timeout. Both modes: flags equal (ignoring --resume, plus
    the declared --advisor), idle, executable realpath == target (VERSION_OK), same
    session file open (SESSION_KEPT). RESTART: same pid. RESPAWN: new pid. A screen
    model that differs from before is a MODEL_CHANGED warning, never a failure: OMP's
    /restart and our respawn both keep the launch --model, so a runtime switch reverts."""
    mode = row.get("mode") or "RESTART"
    single = {"rows": [dict(row, action="RESTART", flags=row["flags"] + row.get("added", []))]}
    ctx.sleep(ctx.verify_settle)
    deadline = ctx.clock() + ctx.verify_timeout
    while True:
        inv = ctx.inventory_fn({row["pane_id"]})
        v = core.verify(single, inv, {}, mode=mode.lower())["rows"][0]
        p = next((x for x in inv["panes"] if x["pane_id"] == row["pane_id"]), None)
        agent = core.find_agent(inv["procs"], p["pane_pid"]) if p else None
        kept, exe = None, None
        if agent:
            text = ctx.lsof_fn(agent["pid"])
            exe = fr_save.executable(text)
            exe = os.path.realpath(exe) if exe else None
            if saved.get("session_file"):
                kept = fr_save.session_kept(text, saved["session_file"])
        version_ok = exe is not None and exe == target.get("path")
        if (v["result"] == "VERIFIED" and kept is not False and version_ok) or ctx.clock() >= deadline:
            break
        ctx.sleep(ctx.verify_poll)
    evidence = "respawn: new pid" if mode == "RESPAWN" else ("mcp-pids-changed" if row.get("mcp_pids") else "no-mcp-children: same pid, flags, idle after settle")
    out = {"pane": row["pane"], "pane_id": row["pane_id"], "mode": mode, "result": v["result"], "why": list(v["why"]), "evidence": evidence,
           "new_pid": agent["pid"] if agent else None, "exe": exe, "version": "VERSION_OK" if version_ok else "VERSION_STALE"}
    ledger.add("VERIFY", pane=row["pane"], result=v["result"], why=v["why"], evidence=evidence, mode=mode, exe=exe, new_pid=out["new_pid"])
    before, after = saved.get("screen_model") or "", core.parse_screen(p["screen"] if p else [])["model"]
    if before and after and before != after:
        out["model_changed"] = {"before": before, "after": after}
        ledger.add("MODEL_CHANGED", pane=row["pane"], before=before, after=after)
    if v["result"] == "VERIFIED":
        out["session"] = "SESSION_UNKNOWN" if kept is None else "SESSION_KEPT" if kept else "SESSION_LOST"
        ledger.add("SESSION", pane=row["pane"], result=out["session"], session_file=saved.get("session_file"))
        ledger.add("VERSION", pane=row["pane"], result=out["version"], exe=exe, target=target.get("path"))
        if out["session"] == "SESSION_LOST":
            out["result"] = "SESSION_LOST"
        elif not version_ok:
            out["result"] = "VERSION_STALE"
            out["why"].append("running %s, target %s" % (exe, target.get("path")))
    ledger.add("VERDICT", pane=row["pane"], result=out["result"], mode=mode, session=out.get("session"), version=out["version"], why=out["why"],
               model_changed=out.get("model_changed"))
    return out


def poll_badge(ctx, pane_id, seconds):
    deadline = ctx.clock() + seconds
    while True:
        if core.advisor_badge(ctx.capture_fn(pane_id)):
            return True
        if ctx.clock() >= deadline:
            return False
        ctx.sleep(ctx.advisor_poll)


def advisor_step(ctx, row, saved, approval, ledger, may_send=True):
    """Advisor on before -> badge back after: wait a short grace (config/flag advisors,
    and respawns launched with --advisor, come back by themselves), else exactly one
    `/advisor on` (idempotent; bare `/advisor` toggles and is never sent), then poll.
    `may_send` False (resume after a breaker stop): no send, ADVISOR_HELD_BREAKER."""
    adv = saved.get("advisor") or {}
    if not adv.get("on"):
        result, sends = "ADVISOR_OFF", 0
    elif poll_badge(ctx, row["pane_id"], ctx.advisor_grace):
        result, sends = "ADVISOR_KEPT", 0
    elif not may_send:
        result, sends = "ADVISOR_HELD_BREAKER", 0
    else:
        sent = gated(ctx, keys_row(row, "/advisor on"), approval)
        ledger.add("ADVISOR_SENT", pane=row["pane"], text="/advisor on", result=sent["result"])
        sends = 1
        result = "ADVISOR_RESTORED" if sent["result"] == "SENT" and poll_badge(ctx, row["pane_id"], ctx.advisor_timeout) else "ADVISOR_FAILED"
    ledger.add("ADVISOR", pane=row["pane"], result=result, source=adv.get("source"), sends=sends)
    return result


def action_row(r, saved):
    """The send for this pane's mode, or (None, hold) when a saved precondition fails.
    Live preconditions (pid, session file, git child, owned scratch) are re-checked
    inside the send itself (fr_save.revalidate_respawn)."""
    if r.get("mode") != "RESPAWN":
        return keys_row(r, "/restart"), None
    row = core.respawn_row(r, saved)
    if row is None:
        return None, ([h for h in (saved or {}).get("holds", []) if h in core.RESPAWN_HOLDS] or ["HOLD_NOT_SAVED"])[0]
    return row, None


def held(r, result, why=None):
    out = {"pane": r["pane"], "pane_id": r["pane_id"], "mode": r.get("mode"), "result": result, "sends": 0}
    if why:
        out["why"] = why if isinstance(why, list) else [why]
    return out


def process_wave(ctx, rows, saved, target, approval, ledger, results, brk, canary=False):
    """Send each row's action (idle, empty composer and, for respawn, live saved facts
    re-checked at send), then verify each. Once the breaker has tripped, rows not yet
    sent get HOLD_BREAKER and zero sends; rows already sent still finish verifying.
    Returns (rows found busy at send time, number of rows actually sent)."""
    sent, busy = [], []
    for r in rows:
        s = saved.get(r["pane_id"]) or {}
        if r.get("already_sent"):
            rr = core.respawn_row(r, s) if r.get("mode") == "RESPAWN" else None
            sent.append(dict(r, added=rr["added"] if rr else []))
            continue
        if brk["trip"] or not brk["sends"]:
            conclude(ledger, results, held(r, "HOLD_BREAKER", "breaker: %s %s" % ((brk["trip"] or {}).get("pane"), (brk["trip"] or {}).get("verdict"))))
            continue
        row, hold = action_row(r, s)
        if hold:
            ledger.add("HELD", pane=r["pane"], result=hold)
            conclude(ledger, results, held(r, hold))
            continue
        out = gated(ctx, row, approval)
        if out["result"] == "SENT":
            ledger.add("SENT", pane=r["pane"], mode=r.get("mode"), argv=out.get("argv"), canary=canary)
            sent.append(dict(r, added=row.get("added", [])))
        elif out["result"] == "QUEUED_BUSY":
            busy.append(r)
        elif out["result"].startswith(("HELD_", "HOLD_")):  # zero sends, not a failure
            ledger.add("HELD", pane=r["pane"], result=out["result"], why=out.get("why"))
            conclude(ledger, results, held(r, SEND_HOLDS.get(out["result"], out["result"]), out.get("why") or out["result"]))
        else:
            ledger.add("SEND_RESULT", pane=r["pane"], result=out["result"])
            res = dict(held(r, "FAILED", out["result"]))
            conclude(ledger, results, res)
            check_trip(ledger, brk, res, canary)
    for r in sent:
        s = saved.get(r["pane_id"]) or {}
        res = verify_pane(ctx, r, s, target, ledger)
        if res["result"] in ("VERIFIED", "SESSION_LOST", "VERSION_STALE"):
            res["advisor"] = advisor_step(ctx, r, s, approval, ledger, may_send=brk["sends"])
        results[r["pane"]] = res
        if canary:
            ledger.add("CANARY", pane=r["pane"], result=res["result"], advisor=res.get("advisor"))
        check_trip(ledger, brk, res, canary)
    return busy, sum(1 for r in sent if not r.get("already_sent"))


def pick_canary(rows):
    """Canary order: a RESPAWN pane first (the riskier path), else the first row."""
    return next((r for r in rows if r.get("mode") == "RESPAWN"), rows[0])


def canary_pass(ctx, queue, saved, target, approval, ledger, results, brk):
    """Process queue rows one at a time as canaries until brk['canary_left'] panes were
    actually sent (holds do not count) or the breaker trips. Returns busy rows."""
    busy = []
    while brk["canary_left"] > 0 and queue and not brk["trip"] and brk["sends"]:
        r = pick_canary(queue)
        queue.remove(r)
        b, n = process_wave(ctx, [r], saved, target, approval, ledger, results, brk, canary=True)
        busy += b
        brk["canary_left"] -= n
    return busy


def restart_stage(ctx, man, save_doc, approval, ledger, results, resume_run, brk):
    saved = {r["pane_id"]: r for r in save_doc["rows"]}
    target = man["target"]
    prior = ledger_state(ledger.events()) if resume_run else {}
    cands = [r for r in man["rows"] if r["action"] in CANDIDATES]
    for r in man["rows"]:
        if r["action"] not in CANDIDATES:
            results[r["pane"]] = {"pane": r["pane"], "pane_id": r["pane_id"], "result": r["action"], "sends": 0}
    inv = ctx.inventory_fn({r["pane_id"] for r in cands})
    panes = {p["pane_id"]: p for p in inv["panes"]}
    reverify, idle, busy = [], [], []
    for r in cands:
        st = prior.get(r["pane"], {})
        verdict = st.get("verdict")
        if verdict:  # terminal: never re-sent; failures stay failures
            res = {"pane": r["pane"], "pane_id": r["pane_id"], "mode": r.get("mode"), "from_ledger": True, "result": verdict["result"],
                   "session": verdict.get("session"), "version": verdict.get("version"), "why": verdict.get("why") or []}
            if verdict.get("model_changed"):
                res["model_changed"] = verdict["model_changed"]
            if verdict["result"] in ("VERIFIED", "SESSION_LOST", "VERSION_STALE"):
                res["advisor"] = st["advisor"] if "advisor" in st else advisor_step(ctx, r, saved.get(r["pane_id"]) or {}, approval, ledger,
                                                                                      may_send=brk["sends"])
            results[r["pane"]] = res
            continue
        if st.get("verify"):  # VERIFY written, crash before VERDICT: re-run the checks, never re-send
            ledger.add("REVERIFY", pane=r["pane"], why="VERIFY without VERDICT")
            reverify.append(dict(r, already_sent=True))
            continue
        p = panes.get(r["pane_id"])
        agent = core.find_agent(inv["procs"], p["pane_pid"]) if p else None
        row = dict(r)
        if agent and st.get("sent"):
            if acted(r, agent):
                reverify.append(dict(row, already_sent=True))
                continue
            if st.get("send_lost"):
                res = held(r, "FAILED", "SEND_LOST twice")
                conclude(ledger, results, res)
                check_trip(ledger, brk, res)
                continue
            if not brk["sends"]:
                conclude(ledger, results, held(r, "HOLD_BREAKER", "SEND_LOST, not retried after a breaker stop"))
                continue
            ledger.add("SEND_LOST", pane=r["pane"], why="SENT without VERIFY and no effect observed; retrying once")
        if not agent or agent["pid"] != r["omp_pid"]:
            ledger.add("HELD", pane=r["pane"], result="HELD_DRIFT", why="omp pid changed since the plan")
            conclude(ledger, results, held(r, "HELD_DRIFT"))
            continue
        state = core.parse_screen(p["screen"])["state"]
        if state == "IDLE":
            idle.append(row)
        elif state == "BUSY":
            busy.append(row)
        else:
            ledger.add("HELD", pane=r["pane"], result="HELD_UNKNOWN_STATE")
            conclude(ledger, results, held(r, "HOLD_UNKNOWN_STATE"))
    if reverify:
        busy += process_wave(ctx, reverify, saved, target, approval, ledger, results, brk)[0]
    busy += canary_pass(ctx, idle, saved, target, approval, ledger, results, brk)
    wave = max(1, int(man.get("wave") or 1))
    for i in range(0, len(idle), wave):
        busy += process_wave(ctx, idle[i:i + wave], saved, target, approval, ledger, results, brk)[0]
    deadline = ctx.clock() + 60 * float(man.get("busy_timeout_min") or 0)
    while busy and ctx.clock() < deadline and not brk["trip"] and brk["sends"]:
        ctx.sleep(ctx.busy_poll)
        ready = [r for r in busy if core.parse_screen(ctx.capture_fn(r["pane_id"]))["state"] == "IDLE"]
        busy = [r for r in busy if r not in ready]
        busy += canary_pass(ctx, ready, saved, target, approval, ledger, results, brk)
        if ready:
            busy += process_wave(ctx, ready, saved, target, approval, ledger, results, brk)[0]
    for r in busy:
        if brk["trip"] or not brk["sends"]:
            conclude(ledger, results, held(r, "HOLD_BREAKER", "breaker stop before its turn boundary"))
        else:
            ledger.add("QUEUED_BUSY", pane=r["pane"], sends=0)
            conclude(ledger, results, held(r, "QUEUED_BUSY"))


def failed(res):
    return res.get("result") in FAILURES or res.get("advisor") == "ADVISOR_FAILED"


def apply_run(run_dir, ctx, approval, unprotect=(), resume_run=False, ttl_min=None, canary=None, strict_advisor=None,
              continue_after_breaker=False):
    path = os.path.join(run_dir, RUN_MANIFEST)
    if not os.path.isfile(path):
        return {"refused": "RUN_MANIFEST_MISSING", "path": path}, EXIT_REFUSED
    with open(path) as fh:
        man = json.load(fh)
    refusal = check_approval(man, approval, unprotect, canary, strict_advisor)
    ledger = Ledger(os.path.join(run_dir, LEDGER), ctx.clock)
    events = ledger.events()
    applied = any(e["event"] == "SAVE" for e in events)  # preflight-refused attempts mutate nothing
    breaker = active_breaker(events)
    if not refusal and applied != bool(resume_run):
        refusal = "RUN_ALREADY_APPLIED: continue with --resume-run" if applied else "NOTHING_TO_RESUME: no ledger yet"
    if not refusal and continue_after_breaker:
        if not resume_run:
            refusal = "CONTINUE_NEEDS_RESUME_RUN"
        elif approval.get("continue_after_breaker") is not True:
            refusal = "CONTINUE_NOT_APPROVED: the approval must carry continue_after_breaker: true"
        elif not breaker:
            refusal = "NO_BREAKER_TO_CONTINUE"
    if refusal:  # nothing written, nothing sent, no launchctl call
        return {"refused": refusal, "manifest_sha256": core.manifest_sha(man)}, EXIT_REFUSED
    started = fw.iso(ctx.clock())
    ledger.add("RUN_START", manifest_sha256=man["manifest_sha256"], approved_by=approval["approved_by"], resume_run=resume_run)
    ok, code, detail = core.env_check(ctx.env, ctx.uid)
    checks = [("check-env", ok, "%s %s" % (code, detail))]
    disc = None
    if ok:
        good, line = ctx.preflight_fn()
        checks.append(("selftest", good, line))
        al = ctx.align_fn()
        checks.append(("align", al["ok"], "stale: %s" % [s["link"] for s in al["stale"]] if not al["ok"] else al["version"]))
        tg = ctx.target_fn()
        checks.append(("target", tg.get("path") == man["target"].get("path"), "%s (planned %s)" % (tg.get("path"), man["target"].get("path"))))
        disc = fw.discover(ctx.agents_dir, ctx.registry, ctx.run_fn, ctx.uid)
        checks.append(("watchers-classified", not disc["unclassified"], ",".join(disc["unclassified"]) or "ok"))
    for name, good, why in checks:
        ledger.add("PREFLIGHT", check=name, ok=bool(good), detail=why)
    if [c for c in checks if not c[1]]:
        ledger.add("RUN_END", result="REFUSED_PREFLIGHT")
        return {"refused": "PREFLIGHT_FAILED", "checks": [{"check": n, "ok": bool(g), "detail": w} for n, g, w in checks]}, EXIT_REFUSED
    if continue_after_breaker:
        ledger.add("CONTINUE_AFTER_BREAKER", previous=breaker, approved_by=approval["approved_by"])
        breaker = None
    brk = {"trip": breaker, "sends": breaker is None, "strict": bool(man.get("strict_advisor")), "canary_left": int(man.get("canary", 1))}
    save_path = os.path.join(run_dir, "save.json")
    prior_save = fw.read_json(save_path) if resume_run else None
    if prior_save and prior_save.get("stage") == "apply":
        save_doc = prior_save  # the pre-restart state; re-saving now would read restarted panes
    else:
        save_doc = fr_save.save(ctx.inventory_fn(None), ctx.home, ctx.lsof_fn, ctx.run_fn)
        save_doc["stage"] = "apply"
        write_json(save_path, save_doc)
    ledger.add("SAVE", agent_panes=save_doc["counts"]["agent_panes"], advisor_on=save_doc["counts"]["advisor_on"], holds=save_doc["holds"])
    preserve_dir = os.path.join(run_dir, "preserve")
    manifest_path = os.path.join(preserve_dir, "manifest.json")
    if resume_run and os.path.isfile(manifest_path):
        with open(manifest_path) as fh:
            preserved = json.load(fh)
    else:
        preserved = fr_save.preserve_work(save_doc, preserve_dir)
    ledger.add("PRESERVE", ok=preserved["ok"], repos=len(preserved.get("repos") or []), scratch=len(preserved.get("scratch") or []), error=preserved.get("error"))
    if not preserved["ok"]:
        ledger.add("RUN_END", result="REFUSED_PRESERVE")
        return {"refused": "PRESERVE_FAILED", "preserve": preserved}, EXIT_REFUSED
    results, error, paused, resumed = {}, None, None, None
    ttl = ttl_min or max(90, int(man.get("busy_timeout_min") or 0) + 60)
    try:
        paused = fw.pause(run_dir, disc, ctx.run_fn, ctx.uid, ctx.clock(), ttl_min=ttl, apply=True)
        ledger.add("WATCHERS_PAUSE", rows=[{k: r.get(k) for k in ("label", "action")} for r in paused["rows"]], refused=paused.get("refused"))
        if paused.get("refused"):
            raise RuntimeError("watchers pause refused: %s" % paused["refused"])
        restart_stage(ctx, man, save_doc, approval, ledger, results, resume_run, brk)
        rc_scratch, out_scratch = ctx.run_fn(["omp-kit", "scratch", "apply", "--apply", "--yes", "--json"], None)
        ledger.add("SCRATCH_REAP", rc=rc_scratch, tail=(out_scratch or "")[-300:])
    except Exception as exc:
        error = "%s: %s" % (type(exc).__name__, exc)
        ledger.add("ERROR", error=error)
    finally:
        resumed = fw.resume(run_dir, ctx.run_fn, ctx.uid, ctx.clock(), apply=True)
        ledger.add("WATCHERS_RESUME", result=resumed["result"], rows=resumed["rows"])
    drift = fr_save.watchdog_drift(save_doc)
    ledger.add("DRIFT", changed=[d for d in drift if d["status"] != "SAME"])
    report = build_report(run_dir, man, approval, save_doc, results, paused, resumed, drift, error, started, ctx, resume_run, brk["trip"])
    rc = 0 if not error and not report["failed"] and not brk["trip"] and resumed["result"] in ("RESUMED", "NOTHING_PAUSED") else EXIT_FAILED
    ledger.add("RUN_END", result="OK" if rc == 0 else "FAILED", failed=report["failed"], error=error, breaker=brk["trip"])
    return report, rc


def build_report(run_dir, man, approval, save_doc, results, paused, resumed, drift, error, started, ctx, resume_run, breaker=None):
    saved = {r["pane_id"]: r for r in save_doc["rows"]}
    plan_rows = {r["pane_id"]: r for r in man["rows"]}
    panes = [results[r["pane"]] for r in man["rows"] if r["pane"] in results]
    counts, advisor = {}, {}
    for p in panes:
        counts[p["result"]] = counts.get(p["result"], 0) + 1
        if p.get("advisor"):
            advisor[p["advisor"]] = advisor.get(p["advisor"], 0) + 1
    fallback = []
    for p in panes:
        if p["result"] in FAILURES and p.get("mode") == "RESTART":
            pr = plan_rows[p["pane_id"]]
            row = core.respawn_row(dict(pr, flags=pr["flags"] or []), saved.get(p["pane_id"]))
            fallback.append({"pane": p["pane"], "argv": core.tmux_respawn_argv(row) if row else None,
                             "held": None if row else (saved.get(p["pane_id"]) or {}).get("holds", ["NOT_SAVED"])})
    scratch_held = []
    for p in panes:
        dirs = (saved.get(p["pane_id"]) or {}).get("held_scratch") or plan_rows.get(p["pane_id"], {}).get("held_scratch") or []
        if dirs:
            scratch_held.append({"pane": p["pane"], "dirs": dirs})
    warnings = ["MODEL_CHANGED %s: %s -> %s" % (p["pane"], p["model_changed"]["before"], p["model_changed"]["after"])
                for p in panes if p.get("model_changed")]
    rep = {"run_dir": os.path.abspath(run_dir), "manifest_sha256": man["manifest_sha256"], "approved_by": approval["approved_by"],
           "quote": approval["quote"], "resume_run": resume_run, "started": started, "finished": fw.iso(ctx.clock()), "error": error,
           "target": man["target"], "snapshot_dir": man["snapshot_dir"], "panes": panes, "counts": counts, "advisor": advisor,
           "failed": [p["pane"] for p in panes if failed(p)], "breaker": breaker, "warnings": warnings,
           "watchers": {"paused": [r for r in (paused or {}).get("rows", [])], "resume": resumed},
           "watchdog_drift": drift, "respawn_fallback": fallback, "scratch_held": scratch_held, "chief_respawn": man.get("chief_respawn")}
    write_json(os.path.join(run_dir, "report.json"), rep)
    with open(os.path.join(run_dir, "report.md"), "w") as fh:
        fh.write(render_report(rep))
    return rep


SCRATCH_ADVICE = "held scratch is copied out of reaper roots and each dirty repo is pinned on refs/preserve before any send. A preserve failure refuses the run"
BREAKER_ADVICE = ("no new sends started after it; in-flight panes finished verifying. Fix the cause, then "
                  "`run --apply --resume-run --continue-after-breaker` with `continue_after_breaker: true` in the approval")


def scratch_line(held_dirs):
    return "; ".join("%s (newest %s, %s)" % (d["path"], d.get("newest_file") or "-", fw.iso(d["newest_mtime"]) if d.get("newest_mtime") else "-")
                     for d in held_dirs)


def breaker_line(b):
    return "BREAKER: %s %s%s" % (b["pane"], b["verdict"], " (canary)" if b.get("canary") else "")


def render_report(rep):
    out = ["# Fleet restart run report", "",
           "Run: %s. Manifest sha256 %s, approved by %s. %s to %s.%s" % (rep["run_dir"], rep["manifest_sha256"][:12], rep["approved_by"], rep["started"],
                                                                         rep["finished"], " ERROR: %s" % rep["error"] if rep["error"] else ""),
           "Target: %s (%s). Stage-1 snapshot (handoff and messages read this one): %s" % (rep["target"].get("path"), rep["target"].get("version"), rep["snapshot_dir"])]
    if rep.get("breaker"):
        out += ["", "%s. %s." % (breaker_line(rep["breaker"]), BREAKER_ADVICE)]
    out += ["", "Counts: %s. Advisor: %s." % (", ".join("%s %d" % kv for kv in sorted(rep["counts"].items())) or "none",
                                             ", ".join("%s %d" % kv for kv in sorted(rep["advisor"].items())) or "none"),
            "Watchers resume: %s. WATCHDOG drift: %s." % (rep["watchers"]["resume"]["result"],
                                                          ", ".join("%s %s" % (d["status"], d["path"]) for d in rep["watchdog_drift"] if d["status"] != "SAME") or "none")]
    if rep.get("warnings"):
        out += ["", "## Warnings (not failures)", ""] + ["- %s" % w for w in rep["warnings"]]
    out += ["", "| Pane | Mode | Result | Version | Session | Advisor | Why |", "|---|---|---|---|---|---|---|"]
    for p in rep["panes"]:
        out.append("| %s | %s | %s | %s | %s | %s | %s |" % (p["pane"], p.get("mode") or "-", p["result"], p.get("version", "-"), p.get("session", "-"),
                                                          p.get("advisor", "-"), "; ".join(p.get("why") or []) or "-"))
    if rep["respawn_fallback"]:
        out += ["", "## Respawn fallback for failed /restart panes (operator-approved, one pane at a time)", ""]
        for f in rep["respawn_fallback"]:
            out.append("- %s: %s" % (f["pane"], "`%s`" % shell_line(f["argv"]) if f["argv"] else "held: %s" % ", ".join(f["held"])))
    if rep.get("scratch_held"):
        out += ["", "## Preserved scratch", "", SCRATCH_ADVICE + ".", ""]
        for h in rep["scratch_held"]:
            out.append("- %s:" % h["pane"])
            out += ["  - `%s` newest file `%s` (%s)" % (d["path"], d.get("newest_file") or "-", fw.iso(d["newest_mtime"]) if d.get("newest_mtime") else "-")
                    for d in h["dirs"]]
    ch = rep.get("chief_respawn")
    out += ["", "## Chief (never touched by the run; the operator runs this last, after reading the handoff)", ""]
    if ch and ch.get("argv"):
        out.append("- %s: `%s`" % (ch["pane"], shell_line(ch["argv"])))
        out += ["- WARNING %s" % w for w in ch.get("warnings") or []]
    else:
        out.append("- %s" % ("held: %s" % ", ".join(ch.get("holds") or []) if ch else "chief pane not found in the plan"))
    return "\n".join(out) + "\n"
