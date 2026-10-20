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
canary, or any FAILED/SESSION_LOST/SESSION_FORKED/VERSION_STALE verdict (ADVISOR_FAILED with
strict_advisor), trips the breaker: no new sends start, in-flight panes finish.
The chief pane is never touched: the report prints its respawn command. Every
action appends to ledger.jsonl; --resume-run continues from it. The only
keystrokes sent are `/restart` and `/advisor on`. All side effects go through a
Ctx of injected functions."""
import fcntl
import hashlib
import json
import multiprocessing
import os
import shlex
import signal
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
FAILURES = ("FAILED", "SESSION_LOST", "SESSION_FORKED", "VERSION_STALE")
SEND_HOLDS = {"HELD_COMPOSER": "HOLD_COMPOSER", "HELD_UNKNOWN_STATE": "HOLD_UNKNOWN_STATE"}
EXIT_REFUSED, EXIT_FAILED = 7, 6


class Ctx:
    def __init__(self, env, uid, home, agents_dir, registry, run_fn, capture_fn, inventory_fn, snapshot_fn, lsof_fn, align_fn,
                 preflight_fn, target_fn, sleep_fn=time.sleep, clock_fn=time.time, verify_timeout=120, verify_poll=5, verify_settle=10,
                 advisor_grace=6, advisor_timeout=20, advisor_poll=2, busy_poll=30, parallel=False, spawn_fn=None,
                 releases=None, version=None, run_dir=None):
        self.env, self.uid, self.home, self.agents_dir, self.registry = env, uid, home, agents_dir, registry
        self.run_fn, self.capture_fn, self.inventory_fn, self.snapshot_fn, self.lsof_fn = run_fn, capture_fn, inventory_fn, snapshot_fn, lsof_fn
        self.align_fn, self.preflight_fn, self.target_fn, self.sleep_fn, self.clock_fn = align_fn, preflight_fn, target_fn, sleep_fn, clock_fn
        self.verify_timeout, self.verify_poll, self.verify_settle = verify_timeout, verify_poll, verify_settle
        self.advisor_grace, self.advisor_timeout, self.advisor_poll, self.busy_poll = advisor_grace, advisor_timeout, advisor_poll, busy_poll
        self.parallel, self.spawn_fn = parallel, spawn_fn
        self.releases, self.version, self.run_dir = releases, version, run_dir
        self.cancel_path = None

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

    ctx = Ctx(env=env, uid=os.getuid(), home=home, agents_dir=agents_dir or os.path.join(home, "Library", "LaunchAgents"),
              registry=fw.load_registry(registry_path), run_fn=core.run, capture_fn=core.capture_live(env),
              inventory_fn=lambda only=None: core.live_inventory(env, only=only), snapshot_fn=snapshot_fn,
              lsof_fn=fr_save.lsof_live(core.run), align_fn=lambda: core.align_check(home, releases, version or core.kit_version()),
              preflight_fn=preflight_fn, target_fn=lambda: fr_save.target_live(core.run),
              parallel=True, releases=releases, version=version)
    ctx.herdr_fn = lambda target, chief: core.live_herdr_states(core.run, target, chief)
    return ctx


class Ledger:
    def __init__(self, path, clock):
        self.path, self.clock = path, clock

    def add(self, event, durable=False, **kw):
        row = dict({"schema_version": 1, "at": fw.iso(self.clock()), "event": event}, **kw)
        with open(self.path, "a") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
                fh.flush()
                if durable:
                    os.fsync(fh.fileno())
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)

    def events(self):
        try:
            with open(self.path) as fh:
                return [json.loads(ln) for ln in fh if ln.strip()]
        except FileNotFoundError:
            return []


def write_json(path, obj):
    fw.write_json(path, obj)


def doc_digest(obj):
    """Canonical sha256 of a JSON-able document (save/preserve binding)."""
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def dir_digest(path):
    """Canonical sha256 of a snapshot dir: sorted relpaths plus file bytes."""
    h = hashlib.sha256()
    for root, _dirs, files in os.walk(path):
        for name in sorted(files):
            full = os.path.join(root, name)
            rel = os.path.relpath(full, path)
            h.update(rel.encode())
            try:
                with open(full, "rb") as fh:
                    for chunk in iter(lambda: fh.read(65536), b""):
                        h.update(chunk)
            except OSError:
                h.update(b"<unreadable>")
    return h.hexdigest()


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
    herdr = {"ok": False, "why": "not collected", "rows": []}
    herdr_fn = getattr(ctx, "herdr_fn", None)
    if herdr_fn and target.get("ok"):
        try:
            herdr = herdr_fn(target.get("path"), chief)
        except Exception as exc:
            herdr = {"ok": False, "why": "herdr_fn: %s" % exc, "rows": []}
    plan["herdr"] = herdr
    write_json(os.path.join(run_dir, "plan.json"), plan)
    plat = fw.platform_status()
    if plat is not None:
        disc = {"agents_dir": ctx.agents_dir, "jobs": [], "unreadable": [], "registered_missing": sorted(ctx.registry),
                "unclassified": [], "pause_plan": [], "deadman_left": []}
    else:
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
            # The operator runs this by hand, last, and only when it is not held:
            # an owned work-scratch hold refuses even the printed respawn command.
            cr = core.respawn_row(r, s)
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
    if plat is not None:
        refused.append("WATCHERS_UNSUPPORTED: %s" % plat["reason"])
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
    if target.get("ok") and not target.get("bytes_sha256"):
        # Belt and braces: a target_fn that predates the bytes binding gets the
        # live file digest filled in; an unreadable executable stays unbound and
        # refuses at apply (TARGET_BYTES_UNBOUND).
        target["bytes_sha256"] = fr_save.sha256_file(target.get("path"))
    man = {"kind": "run", "run_dir": os.path.abspath(run_dir), "created": core.now(), "snapshot_dir": os.path.abspath(snap_dir),
           "snapshot_at": inv.get("captured_at"), "snapshot_sha256": dir_digest(snap_dir),
           "chief": chief, "chief_respawn": chief_cmd, "protect": list(protect), "unprotect": list(unprotect),
           "only": list(only), "wave": wave, "busy_timeout_min": busy_timeout_min, "canary": int(canary), "strict_advisor": bool(strict_advisor),
           "align": plan["align"], "target": target, "herdr": plan.get("herdr") or {"ok": False, "why": "not collected", "rows": []},
           "stages": STAGES, "rows": rows, "holds": holds, "refused": refused,
           "watchers": {"platform": "darwin-launchd" if plat is None else plat,
                        "pause": disc["pause_plan"], "binding": fw.approval_binding(disc, ctx.registry),
                        "unclassified": [j for j in disc["jobs"] if j["status"] == "HOLD_UNCLASSIFIED"],
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
                    revalidate_fn=fr_save.respawn_revalidator(ctx.inventory_fn, ctx.lsof_fn, ctx.run_fn, ctx.home))
    if res.get("refused"):
        raise RuntimeError("send refused: %s %s" % (res["refused"], res.get("why", "")))
    return res["rows"][0]


def keys_row(r, text):
    return {"pane": r["pane"], "pane_id": r["pane_id"], "session": r["session"], "flags": r["flags"], "kind": "keys", "text": text}


def ledger_state(events):
    """Per pane: sends, verification, verdict, and advisor effect intent/receipt."""
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
        elif e["event"] == "SEND_INTENT":
            s["send_intent"] = e
        elif e["event"] == "ADVISOR_INTENT":
            s["advisor_intent"] = e
        elif e["event"] == "ADVISOR_SENT":
            s["advisor_sent"] = e
        elif e["event"] == "ADVISOR":
            s["advisor"] = e["result"]
            s["advisor_event"] = e
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
    text = None
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
        fork = fr_save.fork_evidence(saved.get("session_file")) if saved.get("session_file") else None
        exact = fr_save.session_exact(text, saved["session_file"]) if (agent and text is not None and saved.get("session_file")) else None
        if fork:
            out["session"] = "SESSION_FORKED"
            out["result"] = "SESSION_FORKED"
            out["why"].append(fork)
        else:
            out["session"] = "SESSION_UNKNOWN" if kept is None else "SESSION_KEPT" if (kept and exact) else "SESSION_LOST"
            if kept and not exact:
                out["why"].append("open sessions %s, expected exactly [%s]" % (fr_save.session_candidates(text), saved.get("session_file")))
        ledger.add("SESSION", pane=row["pane"], result=out["session"], session_file=saved.get("session_file"))
        ledger.add("VERSION", pane=row["pane"], result=out["version"], exe=exe, target=target.get("path"))
        if out["session"] == "SESSION_LOST":
            out["result"] = "SESSION_LOST"
        elif not version_ok:
            out["result"] = "VERSION_STALE"
            out["why"].append("running %s, target %s" % (exe, target.get("path")))
    ledger.add("VERDICT", pane=row["pane"], result=out["result"], mode=mode, session=out.get("session"), version=out.get("version"), why=out["why"],
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


def advisor_step(ctx, row, saved, approval, ledger, may_send=True, prior=None):
    """Restore one saved advisor at most once and reconcile its badge on resume.

    The fsynced ADVISOR_INTENT precedes the external send. If a restart happens
    after that boundary but before a receipt/result row, resume observes the badge
    and never repeats the ambiguous /advisor on effect.
    """
    adv = saved.get("advisor") or {}
    prior = prior or {}
    intent = prior.get("advisor_intent")
    receipt = prior.get("advisor_sent")
    attempted = bool(intent or receipt)
    intent_id = (intent or receipt or {}).get("intent_id")
    baseline = {
        "badge_before": bool(adv.get("on")),
        "source": adv.get("source"),
        "config": adv.get("config"),
        "watchdog_files": list(adv.get("watchdog_files") or []),
    }
    sends = 0
    if not baseline["badge_before"]:
        result = "ADVISOR_OFF"
    elif poll_badge(ctx, row["pane_id"], ctx.advisor_grace):
        result = "ADVISOR_RESTORED" if attempted else "ADVISOR_KEPT"
    elif not may_send:
        result = "ADVISOR_HELD_BREAKER"
    elif attempted:
        result = "ADVISOR_RESTORED" if poll_badge(ctx, row["pane_id"], ctx.advisor_timeout) else "ADVISOR_FAILED"
    else:
        intent_id = "%s|%s|advisor-on" % (os.path.abspath(ctx.run_dir or "."), row["pane_id"])
        ledger.add("ADVISOR_INTENT", durable=True, pane=row["pane"], intent_id=intent_id,
                   action="/advisor on", **baseline)
        sent = gated(ctx, keys_row(row, "/advisor on"), approval)
        ledger.add("ADVISOR_SENT", pane=row["pane"], intent_id=intent_id, text="/advisor on",
                   result=sent.get("result"), rc=sent.get("rc"), argv=sent.get("argv"),
                   output=str(sent.get("out") or "")[-300:])
        sends = 1
        result = "ADVISOR_RESTORED" if sent.get("result") == "SENT" and poll_badge(ctx, row["pane_id"], ctx.advisor_timeout) else "ADVISOR_FAILED"
    ledger.add("ADVISOR", pane=row["pane"], intent_id=intent_id, result=result, sends=sends, **baseline)
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


def send_intent_id(ctx, r):
    """Deterministic identity of one pane's send in this run dir. The fsynced
    SEND_INTENT precedes the native delivery, so a resume that finds a dangling
    intent (no SENT yet) reconciles native receive/effect identity instead of
    blindly resending."""
    return "%s|%s|%s" % (os.path.abspath(ctx.run_dir or "."), r["pane_id"], r.get("mode") or "RESTART")


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
        if brk["trip"] or not brk["sends"] or cancelled(ctx):
            conclude(ledger, results, held(r, "HOLD_BREAKER", "cancel" if cancelled(ctx) else "breaker: %s %s" % ((brk["trip"] or {}).get("pane"), (brk["trip"] or {}).get("verdict"))))
            continue
        row, hold = action_row(r, s)
        if hold:
            ledger.add("HELD", pane=r["pane"], result=hold)
            conclude(ledger, results, held(r, hold))
            continue
        ledger.add("SEND_INTENT", durable=True, pane=r["pane"], intent_id=send_intent_id(ctx, r), mode=r.get("mode"),
                   kind=row.get("kind"), text=row.get("text"))
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
        if res["result"] in ("VERIFIED", "SESSION_LOST", "SESSION_FORKED", "VERSION_STALE"):
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


def cancelled(ctx):
    return bool(ctx.cancel_path and os.path.exists(ctx.cancel_path))


def should_fanout(ctx, rows, brk):
    """After the canary, live runs use one process per remaining pane. Tests stay serial."""
    return bool(ctx.parallel and rows and not brk["trip"] and brk["sends"] and ctx.run_dir)


def progress(event, **kw):
    sys.stderr.write(json.dumps(dict({"event": event, "at": fw.iso(time.time())}, **kw), ensure_ascii=False) + "\n")
    sys.stderr.flush()


def pane_payloads(rows, saved, target, approval, env, home, releases, version, run_dir, cancel, strict):
    out = []
    for row in rows:
        out.append({"row": row, "saved": saved.get(row["pane_id"]) or {}, "target": target, "approval": approval,
                    "env": env, "home": home, "releases": releases, "version": version, "run_dir": run_dir,
                    "cancel": cancel, "strict": strict, "ledger": os.path.join(run_dir, LEDGER)})
    return out


def pane_main(payload):
    """One pane, one process. Rebuilds a live context. Does not re-run selftest."""
    started = time.time()
    progress("PANE_START", pane=payload["row"]["pane"], pid=os.getpid())
    ctx = live_ctx(payload["env"], payload["home"], payload["releases"], payload.get("version"))
    ctx.parallel = False
    ctx.run_dir = payload["run_dir"]
    ctx.cancel_path = payload["cancel"]
    ctx.preflight_fn = lambda: (True, "already passed")
    ledger = Ledger(payload["ledger"], time.time)
    results, brk = {}, {"trip": None, "sends": True, "strict": payload["strict"], "canary_left": 0}
    busy, _n = process_wave(ctx, [payload["row"]], {payload["row"]["pane_id"]: payload["saved"]}, payload["target"], payload["approval"], ledger, results, brk)
    res = results.get(payload["row"]["pane"]) or held(payload["row"], "FAILED", "pane process produced no result")
    res["busy"] = bool(busy)
    res["elapsed_ms"] = int((time.time() - started) * 1000)
    out = os.path.join(payload["run_dir"], "pane-results")
    os.makedirs(out, exist_ok=True)
    safe = payload["row"]["pane"].replace("/", "_").replace(":", "_")
    with open(os.path.join(out, safe + ".json"), "w") as fh:
        json.dump(res, fh)
        fh.write("\n")
    progress("PANE_DONE", pane=payload["row"]["pane"], result=res.get("result"), elapsed_ms=res["elapsed_ms"], pid=os.getpid())
    return res


def spawn_pane_processes(payloads):
    mp = multiprocessing.get_context("spawn")
    procs = []
    for payload in payloads:
        proc = mp.Process(target=pane_main, args=(payload,), name="pane-%s" % payload["row"]["pane"])
        proc.start()
        procs.append(proc)
    return procs


def parallel_panes(ctx, rows, saved, target, approval, ledger, results, brk):
    """One process per pane. A canary failure never reaches here. Parent cancel stops a child before it sends."""
    cancel = os.path.join(ctx.run_dir, "cancel")
    ctx.cancel_path = cancel
    payloads = pane_payloads(rows, saved, target, approval, ctx.env, ctx.home, ctx.releases, ctx.version, ctx.run_dir, cancel, brk["strict"])
    progress("PANE_FANOUT", count=len(payloads), panes=[p["row"]["pane"] for p in payloads])
    ledger.add("PANE_FANOUT", count=len(payloads), panes=[p["row"]["pane"] for p in payloads])
    if ctx.spawn_fn:
        return ctx.spawn_fn(ctx, payloads, saved, target, approval, ledger, results, brk)
    procs = spawn_pane_processes(payloads)
    previous = signal.getsignal(signal.SIGTERM)

    def stop(signum, frame):
        with open(cancel, "w") as fh:
            fh.write("parent-sigterm\n")
        if callable(previous):
            previous(signum, frame)

    signal.signal(signal.SIGTERM, stop)
    try:
        for proc in procs:
            proc.join()
    finally:
        signal.signal(signal.SIGTERM, previous)
    busy = []
    for payload in payloads:
        safe = payload["row"]["pane"].replace("/", "_").replace(":", "_")
        path = os.path.join(ctx.run_dir, "pane-results", safe + ".json")
        try:
            with open(path) as fh:
                res = json.load(fh)
        except OSError:
            res = held(payload["row"], "FAILED", "pane process exited without a result")
            ledger.add("PANE_LOST", pane=payload["row"]["pane"])
        results[res["pane"]] = res
        if res.pop("busy", False):
            busy.append(payload["row"])
        check_trip(ledger, brk, res)
        if brk["trip"] and not os.path.exists(cancel):
            with open(cancel, "w") as fh:
                fh.write("breaker\n")
    return busy


def restart_stage(ctx, man, save_doc, approval, ledger, results, resume_run, brk, authorized_retry=False):
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
            if verdict["result"] in ("VERIFIED", "SESSION_LOST", "SESSION_FORKED", "VERSION_STALE"):
                res["advisor"] = st["advisor"] if "advisor" in st else advisor_step(
                    ctx, r, saved.get(r["pane_id"]) or {}, approval, ledger, may_send=brk["sends"], prior=st)
            results[r["pane"]] = res
            continue
        if st.get("verify"):  # VERIFY written, crash before VERDICT: re-run the checks, never re-send
            ledger.add("REVERIFY", pane=r["pane"], why="VERIFY without VERDICT")
            reverify.append(dict(r, already_sent=True))
            continue
        p = panes.get(r["pane_id"])
        agent = core.find_agent(inv["procs"], p["pane_pid"]) if p else None
        row = dict(r)
        if agent and (st.get("sent") or st.get("send_intent")):
            if acted(r, agent):  # native effect proves receipt: re-verify, never re-send
                reverify.append(dict(row, already_sent=True))
                continue
            if not brk["sends"]:
                conclude(ledger, results, held(r, "HOLD_BREAKER", "ambiguous send, not resolved after a breaker stop"))
                continue
            if authorized_retry:
                # Explicit operator re-authorization (continue-after-breaker in
                # this resume's approval), not a blind resend: one more attempt
                # after the operator has had the chance to reconcile natively.
                ledger.add("SEND_RETRY_AUTHORIZED", pane=r["pane"], sent=st.get("sent", 0),
                           intent_id=(st.get("send_intent") or {}).get("intent_id"),
                           why="continue-after-breaker approved: one authorized retry of an ambiguous send")
            else:
                # No-effect observation is not proof of non-delivery: delayed
                # consumption is not non-receipt. Hold for native
                # reconciliation, never blindly resend.
                ledger.add("SEND_AMBIGUOUS", pane=r["pane"], sent=st.get("sent", 0),
                           intent_id=(st.get("send_intent") or {}).get("intent_id"),
                           why="SENT/intent without VERIFY and no effect observed; held pending native reconciliation, not retried")
                conclude(ledger, results, held(r, "HOLD_AMBIGUOUS_SEND",
                                              "ambiguous delivery: SENT/intent without VERIFY and no observed effect; held pending native reconciliation"))
                continue
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
    if should_fanout(ctx, idle, brk):
        busy += parallel_panes(ctx, idle, saved, target, approval, ledger, results, brk)
    else:
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
            if should_fanout(ctx, ready, brk):
                busy += parallel_panes(ctx, ready, saved, target, approval, ledger, results, brk)
            else:
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
    ledger.add("RUN_START", manifest_sha256=man["manifest_sha256"], approved_by=approval["approved_by"], resume_run=resume_run,
               quote=approval.get("quote"))
    ok, code, detail = core.env_check(ctx.env, ctx.uid)
    checks = [("check-env", ok, "%s %s" % (code, detail))]
    disc = tg = None
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
    paused_rec = fw.read_json(os.path.join(run_dir, fw.PAUSED)) or {}
    expect_out = {r["label"] for r in paused_rec.get("rows", [])
                  if r.get("action") == "BOOTED_OUT" and not r.get("resumed")} if resume_run else set()
    # Watcher drift refuses before any other preflight failure is reported: a
    # changed or unclassified actor must never reach the save/pause/send stages.
    wdrift = fw.binding_drift((man.get("watchers") or {}).get("binding"), disc, ctx.registry, expect_out) if disc is not None else None
    if wdrift:
        ledger.add("RUN_END", result="REFUSED_WATCHERS_DRIFT", detail=wdrift)
        return {"refused": "APPROVAL_WATCHERS_DRIFT:" + wdrift, "manifest_sha256": core.manifest_sha(man)}, EXIT_REFUSED
    # Indirect inputs bound under the one run approval: the exact executable bytes
    # at the target path (a same-path binary swap is a different build), and the
    # stage-1 snapshot dir. Either drift refuses before pause/sends, like watchers.
    approved_bytes = (man.get("target") or {}).get("bytes_sha256")
    live_bytes = tg.get("bytes_sha256") if isinstance(tg, dict) else None
    if tg is None or not approved_bytes:
        ledger.add("RUN_END", result="REFUSED_TARGET_UNBOUND",
                   detail="approved bytes %r, live target %r" % (approved_bytes, (tg or {}).get("path") if isinstance(tg, dict) else tg))
        return {"refused": "TARGET_BYTES_UNBOUND: re-plan so the approval binds the exact executable bytes",
                "manifest_sha256": core.manifest_sha(man)}, EXIT_REFUSED
    if live_bytes != approved_bytes:
        ledger.add("RUN_END", result="REFUSED_TARGET_DRIFT",
                   detail="live bytes %r != approved %r at %s" % (live_bytes, approved_bytes, tg.get("path")))
        return {"refused": "APPROVAL_TARGET_DRIFT: executable bytes changed at %s" % tg.get("path"),
                "manifest_sha256": core.manifest_sha(man)}, EXIT_REFUSED
    snap_dir_live = man.get("snapshot_dir") or os.path.join(run_dir, "snapshot")
    snap_live = dir_digest(snap_dir_live) if os.path.isdir(snap_dir_live) else None
    if man.get("snapshot_sha256") and snap_live != man["snapshot_sha256"]:
        ledger.add("RUN_END", result="REFUSED_SNAPSHOT_DRIFT",
                   detail="live snapshot %r != approved %r" % (snap_live, man["snapshot_sha256"]))
        return {"refused": "APPROVAL_SNAPSHOT_DRIFT: stage-1 snapshot mutated after approval",
                "manifest_sha256": core.manifest_sha(man)}, EXIT_REFUSED
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
        baseline = next((e.get("save_sha256") for e in events if e.get("event") == "SAVE" and e.get("save_sha256")), None)
        if baseline and doc_digest(save_doc) != baseline:
            ledger.add("RUN_END", result="REFUSED_SAVE_DRIFT", detail="save.json mutated after its SAVE ledger entry")
            return {"refused": "SAVE_DRIFT: save.json mutated after approval-bound save; re-plan",
                    "manifest_sha256": core.manifest_sha(man)}, EXIT_REFUSED
    else:
        save_doc = fr_save.save(ctx.inventory_fn(None), ctx.home, ctx.lsof_fn, ctx.run_fn)
        save_doc["stage"] = "apply"
        write_json(save_path, save_doc)
    ledger.add("SAVE", agent_panes=save_doc["counts"]["agent_panes"], advisor_on=save_doc["counts"]["advisor_on"], holds=save_doc["holds"],
               save_sha256=doc_digest(save_doc))
    preserve_dir = os.path.join(run_dir, "preserve")
    manifest_path = os.path.join(preserve_dir, "manifest.json")
    if resume_run and os.path.isfile(manifest_path):
        with open(manifest_path) as fh:
            preserved = json.load(fh)
        baseline = next((e.get("preserve_sha256") for e in events if e.get("event") == "PRESERVE" and e.get("preserve_sha256")), None)
        if baseline and doc_digest(preserved) != baseline:
            ledger.add("RUN_END", result="REFUSED_PRESERVE_DRIFT", detail="preserve/manifest.json mutated after its PRESERVE ledger entry")
            return {"refused": "PRESERVE_DRIFT: preserve inputs mutated after approval-bound preserve; re-plan",
                    "manifest_sha256": core.manifest_sha(man)}, EXIT_REFUSED
    else:
        preserved = fr_save.preserve_work(save_doc, preserve_dir)
    ledger.add("PRESERVE", ok=preserved["ok"], repos=len(preserved.get("repos") or []), scratch=len(preserved.get("scratch") or []), error=preserved.get("error"),
               preserve_sha256=doc_digest(preserved))
    if not preserved["ok"]:
        ledger.add("RUN_END", result="REFUSED_PRESERVE")
        return {"refused": "PRESERVE_FAILED", "preserve": preserved}, EXIT_REFUSED
    results, error, paused, resumed = {}, None, None, None
    ttl = ttl_min or max(90, int(man.get("busy_timeout_min") or 0) + 60)
    try:
        paused = fw.pause(run_dir, disc, ctx.run_fn, ctx.uid, ctx.clock(), ttl_min=ttl, apply=True,
                          approved=(man.get("watchers") or {}).get("binding"), registry=ctx.registry)
        ledger.add("WATCHERS_PAUSE", rows=[{k: r.get(k) for k in ("label", "action")} for r in paused["rows"]], refused=paused.get("refused"))
        if paused.get("refused"):
            raise RuntimeError("watchers pause refused: %s" % paused["refused"])
        ctx.run_dir = run_dir
        restart_stage(ctx, man, save_doc, approval, ledger, results, resume_run, brk, authorized_retry=bool(continue_after_breaker))
        # No global scratch reaping: a respawn kills its owner's pid and the
        # reaper then deletes that dir, so reaping after the sends would destroy
        # held work scratch. Live-owner scratch is left; the preserve copy+pin
        # is the save, explicitly not a successor pid (ompkit-774u.4.1).
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
    advisor_evidence = []
    for p in panes:
        counts[p["result"]] = counts.get(p["result"], 0) + 1
        if p.get("advisor"):
            advisor[p["advisor"]] = advisor.get(p["advisor"], 0) + 1
        baseline = (saved.get(p["pane_id"]) or {}).get("advisor") or {}
        advisor_evidence.append({
            "pane": p["pane"],
            "pane_id": p["pane_id"],
            "badge_before": bool(baseline.get("on")),
            "source": baseline.get("source"),
            "config": baseline.get("config"),
            "watchdog_files": list(baseline.get("watchdog_files") or []),
            "result": p.get("advisor"),
        })
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
           "advisor_evidence": advisor_evidence,
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
    if rep.get("advisor_evidence"):
        out += ["", "## Advisor evidence", "", "| Pane | Before | Source | Pre-run WATCHDOG SHA-256 | Result |", "|---|---|---|---|---|"]
        for e in rep["advisor_evidence"]:
            hashes = "; ".join("%s#%s" % (f["path"], f.get("sha256") or "UNKNOWN") for f in e["watchdog_files"]) or "none"
            out.append("| %s | %s | %s | %s | %s |" % (e["pane"], "on" if e["badge_before"] else "off",
                                                       e["source"] or "UNKNOWN", hashes, e["result"] or "UNKNOWN"))
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
