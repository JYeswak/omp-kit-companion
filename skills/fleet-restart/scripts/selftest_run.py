"""Selftest gates for the autonomous run (ompkit-fp72.19.1): check-env, watchers
registry/pause/resume/dead-man, save (session file, executable, advisor state,
scratch, WATCHDOG drift), per-pane mode (RESTART only on the target build, else
RESPAWN), composer hold, version verify, advisor re-apply, respawn argv, run
plan/apply/resume-run. Called by selftest.py; every gate pairs a planted negative
with its control. launchctl, ntm, tmux, lsof, the clock and sleep are fakes:
nothing here touches the live fleet or launchd, except the opt-in gates_native
(owned selftest-prefixed labels only, swept afterwards; production watcher
loaded state is snapshotted and must be unchanged)."""
import argparse
import hashlib
import json
import os
import plistlib
import re
import shlex
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), "scripts"))
import pysafe  # noqa: E402  (bounded child runs: process-group kill on timeout)

import fleet_restart as fr
import fr_run
import fr_save
import fr_watchers as fw

HERE = os.path.dirname(os.path.abspath(__file__))
BUN_OMP = "bun ~/.bun/bin/omp"
BUN = "/opt/homebrew/Cellar/bun/1.3.8/bin/bun"
TERN = "/Users/Shared/Library/Application Support/Tern/omp/versions/"
TARGET = TERN + "18.10.3"
TARGET_INFO = {"ok": True, "command": "omp", "which": "/opt/homebrew/bin/omp", "path": TARGET, "version": "18.10.3", "via": "fake",
              "bytes_sha256": "9f2cb4109db2f7d3f1c8d4e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5"}
# The "+ 👁 0.42" spend segment is always present: OMP restores advisor spend from the transcript on resume.
STATUS = " {glyph} · ◉ {model}{badge} · 📁 ~/w · ◫ 1.0%/1M ⟲ · S1.00 + 👁 0.42"
APPROVE = {"approved_by": "selftest", "quote": "go"}


def screen_of(glyph="π", badge=False, composer="", model="Opus 5.5"):
    return ["older output", "──── 📥 task ─", "❯ " + composer, "────────", STATUS.format(glyph=glyph, badge=" 👁" if badge else "", model=model)]


class FakeLaunchd:
    def __init__(self, loaded=(), refuse_bootstrap=()):
        self.loaded, self.refuse, self.calls = set(loaded), set(refuse_bootstrap), []

    def handle(self, argv):
        self.calls.append(list(argv))
        verb = argv[1]
        if verb == "print":
            label = argv[2].split("/", 2)[2]
            return (0, "%s = {" % argv[2]) if label in self.loaded else (113, 'Could not find service "%s"' % label)
        if verb == "bootout":
            label = argv[2].split("/", 2)[2]
            if label in self.loaded:
                self.loaded.discard(label)
                return 0, ""
            return 3, "Boot-out failed: 3: No such process"
        if verb == "bootstrap":
            with open(argv[3], "rb") as fh:
                label = plistlib.load(fh)["Label"]
            if label in self.refuse:
                return 5, "Bootstrap failed: 5: Input/output error"
            self.loaded.add(label)
            return 0, ""
        return 1, "unknown verb"

    def run(self, argv, env):
        return self.handle(argv) if argv[0] == "launchctl" else (1, "unexpected")

    def mutations(self):
        return [c for c in self.calls if c[1] in ("bootout", "bootstrap")]


class Pane:
    """kind: target (compiled omp already on TARGET) | tern (older versioned build) | bun."""
    def __init__(self, name, pid, n, cwd, advisor="off", flags="--profile claude", kind="target", session=True, badge_ok=True,
                 busy_until=None, lose_session=False, drop_restart=False, composer="", stale=False, model="Opus 5.5", launch_model=None, on_idle=None,
                 extra_after_restart=False, mirror_session=None):
        self.name, self.id, self.shell, self.omp, self.cwd, self.advisor, self.kind = name, pid, n * 10, n * 10 + 1, cwd, advisor, kind
        self.flags = flags + (" --advisor" if advisor == "flag" else "")
        self.session = os.path.join(cwd, "sessions", "-w", "S%d.jsonl" % n) if session else None
        self.badge_ok, self.busy_until, self.lose_session, self.drop_restart = badge_ok, busy_until, lose_session, drop_restart
        self.composer, self.stale, self.model, self.launch_model, self.on_idle = composer, stale, model, launch_model, on_idle
        self.extra_after_restart, self.mirror_session = extra_after_restart, mirror_session
        self.badge, self.restarts, self.mcp_pid, self.suffix, self.next_pid = advisor != "off", 0, n * 10 + 2, "", n * 1000
        self.exe = TARGET if kind == "target" else BUN if kind == "bun" else TERN + "18.9.2"

    def args(self):
        head = {"target": "/opt/homebrew/bin/omp", "bun": BUN_OMP, "tern": TERN + "18.9.2"}[self.kind]
        return head + " " + self.flags + self.suffix


class FakeFleet:
    def __init__(self, panes, launchd):
        self.t, self.panes, self.ld, self.sends, self.boom, self.crash_sleep = 1_000_000.0, {p.id: p for p in panes}, launchd, [], set(), False
        self.scratch_applies = 0  # global scratch/reaper effects: the run must never cause one

    def clock(self):
        return self.t

    def sleep(self, sec):
        if self.crash_sleep:
            self.crash_sleep = False
            raise RuntimeError("simulated crash mid-verify")
        self.t += sec
        for p in self.panes.values():  # things that happen while a pane is busy, seen once it is idle
            if p.on_idle and p.busy_until is not None and self.t >= p.busy_until:
                hook, p.on_idle = p.on_idle, None
                hook(p)

    def screen(self, p):
        busy = p.busy_until is not None and self.t < p.busy_until
        return screen_of("⠹ 2m" if busy else "π", p.badge, p.composer, p.model)

    def capture(self, pane_id):
        return self.screen(self.panes[pane_id])

    def inventory(self, only=None):
        panes, procs = [], []
        for p in self.panes.values():
            panes.append({"pane": p.name, "pane_id": p.id, "pane_pid": p.shell, "cwd": p.cwd, "screen": self.screen(p) if only is None or p.id in only else []})
            procs += [{"pid": p.shell, "ppid": 1, "args": "-zsh"}, {"pid": p.omp, "ppid": p.shell, "args": p.args()},
                      {"pid": p.mcp_pid, "ppid": p.omp, "args": "npm exec rea-agents@6.3.0 mcp"}]
        return {"captured_at": "2026-10-13T00:00:00Z", "panes": panes, "procs": procs}

    def lsof(self, pid):
        p = next(x for x in self.panes.values() if x.omp == pid)
        out = "p%d\nftxt\nn%s\nftxt\nn/usr/lib/dyld\n" % (pid, p.exe)
        if p.session:
            f = p.session.replace(".jsonl", "-new.jsonl") if p.lose_session and p.restarts else p.session
            out += "f38\nn%s\nf39\nn%s\n" % (f, f[:-len(".jsonl")] + "/__advisor.jsonl")
            if p.extra_after_restart and p.restarts and not p.lose_session:
                out += "f40\nn%s\n" % f.replace(".jsonl", "-new.jsonl")
            if p.mirror_session:
                out += "f41\nn%s\n" % p.mirror_session
        elif p.mirror_session:
            out += "f41\nn%s\n" % p.mirror_session
        return out

    def run(self, argv, env):
        if argv and argv[0] == "git":
            return 0, ""
        if argv[0] == "launchctl":
            return self.ld.handle(argv)
        if argv[0] == "ntm":
            p = self.panes[next(a for a in argv if a.startswith("--panes=")).split("=", 1)[1]]
            text = argv[-1]
            self.sends.append((p.name, text, self.t))
            if p.name in self.boom:
                raise RuntimeError("simulated ntm crash")
            if text == "/restart" and not p.drop_restart:  # re-exec of process.execPath: same pid, same exe
                p.restarts += 1
                p.mcp_pid += 1000
                p.suffix = " --resume S%d" % p.restarts
                if p.advisor == "runtime":
                    p.badge = False
                if p.launch_model:  # /restart keeps the launch --model; a runtime switch reverts
                    p.model = p.launch_model
            if text == "/advisor on" and p.badge_ok:
                p.badge = True
            return 0, '{"success":true}'
        if argv[:3] == ["omp-kit", "scratch", "apply"]:
            self.scratch_applies += 1  # planted tripwire: apply_run must never reach this
            return 0, '{"ok":true}'
        if argv[:2] == ["tmux", "respawn-pane"]:
            p = self.panes[argv[argv.index("-t") + 1]]
            self.sends.append((p.name, "RESPAWN", self.t))
            if p.drop_restart:  # respawn lost (tmux error, pane gone mid-send): the old omp keeps running
                return 0, ""
            inner = shlex.split(argv[-1])[2]  # zsh -lc '<cd … && omp …; exec zsh -l>'
            toks = shlex.split(inner.split("&&", 1)[1].rsplit(";", 1)[0])
            assert toks[0] == "omp" and argv[argv.index("-c") + 1] == p.cwd, argv
            p.restarts += 1
            p.omp, p.mcp_pid = p.next_pid + p.restarts * 10, p.next_pid + p.restarts * 10 + 1
            p.kind, p.exe = ("tern", TERN + "18.9.2") if p.stale else ("target", TARGET)
            rest = fr.normalize_flags(toks[1:])
            p.flags, p.suffix = " ".join(rest), ""
            if "--resume" in toks:
                p.suffix = " --resume " + toks[toks.index("--resume") + 1]
            p.badge = "--advisor" in rest or p.advisor == "config"
            p.composer = ""
            if p.launch_model:
                p.model = p.launch_model
            return 0, ""
        return 1, "unexpected %s" % argv

    def count(self, name=None, text=None):
        return sum(1 for n, t, _ in self.sends if (name is None or n == name) and (text is None or t == text))


def write_plist(d, label, args, raw=None):
    path = os.path.join(d, label + ".plist")
    with open(path, "wb") as fh:
        if raw is not None:
            fh.write(raw)
        else:
            plistlib.dump({"Label": label, "ProgramArguments": args}, fh)
    return path


def agents_fixture(root, extra=False):
    d = os.path.join(root, "LaunchAgents")
    os.makedirs(d, exist_ok=True)
    for label in ("com.omp-kit.fleet-watch", "com.omp-kit.fleet-flush", "com.omp-kit.ci-poller"):
        write_plist(d, label, ["/x/omp-kit", "service", "run", label.rsplit(".", 1)[1]])
    if extra:
        write_plist(d, "com.example.sender", ["/bin/sh", "-c", "tmux send-keys -t %3 Enter"])
        script = os.path.join(root, "actor.py")
        with open(script, "w") as fh:
            fh.write('import subprocess\nsubprocess.run(["ntm", "send", "uds", "--panes=1", "go"])\n')
        write_plist(d, "com.example.script-actor", ["/usr/bin/python3", script])
        write_plist(d, "com.example.reader", ["/bin/echo", "hi"])
        write_plist(d, "com.example.idle-actor", ["/bin/sh", "-c", "tmux respawn-pane -k -t %9"])
        write_plist(d, "com.example.broken", None, raw=b"not a plist")
    return d


def fake_home(root):
    home = os.path.join(root, "home")
    for prof, text in [("cfgp", "advisor:\n  enabled: true\n"), ("dotp", "advisor.enabled: true\n"),
                       ("claude", "modelRoles:\n  advisor: openai-codex/gpt-6.1-sol\n")]:
        d = os.path.join(home, ".omp", "profiles", prof, "agent")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "config.yml"), "w") as fh:
            fh.write(text)
    return home


def ctx_for(fleet, home, agents_dir, env, uid, aligned, preflight=(True, "selftest: PASS (fake)")):
    return fr_run.Ctx(env=env, uid=uid, home=home, agents_dir=agents_dir, registry=fw.load_registry(), run_fn=fleet.run,
                      capture_fn=fleet.capture, inventory_fn=fleet.inventory,
                      snapshot_fn=lambda d: (os.makedirs(d, exist_ok=True), fleet.inventory())[1], lsof_fn=fleet.lsof,
                      align_fn=lambda: aligned, preflight_fn=lambda: preflight, target_fn=lambda: dict(TARGET_INFO),
                      sleep_fn=fleet.sleep, clock_fn=fleet.clock,
                      verify_timeout=30, verify_poll=5, verify_settle=1, advisor_grace=4, advisor_timeout=20, advisor_poll=2, busy_poll=30)


def approve(run_dir, **extra):
    with open(os.path.join(run_dir, fr_run.RUN_MANIFEST)) as fh:
        man = json.load(fh)
    return dict(APPROVE, manifest_sha256=fr.manifest_sha(man), **extra)


def gates(case, tmp, uid, good_env, plan, aligned, inventory, IDLE):
    gate_check_env(case, tmp, good_env)
    gate_watchers(case, tmp, uid)
    gate_watchers_binding(case, tmp, uid, good_env, aligned)
    gate_portability(case, tmp)
    gate_save(case, tmp)
    gate_preserve(case, tmp)
    gate_parallel(case, tmp)
    gate_mode(case, tmp)
    gate_respawn(case, tmp, uid, good_env, plan)
    gate_run(case, tmp, uid, good_env, aligned)
    gate_approval_binding(case, tmp, uid, good_env, aligned)
    gate_uxr3(case, tmp, plan, inventory, aligned)
    gate_advisor_resume_crash(case, tmp, uid, good_env, aligned)

def gate_advisor_resume_crash(case, tmp, uid, good_env, aligned):
    """Crash after the advisor send returns, then prove resume reconciles once."""
    root = os.path.join(tmp, "advisor-resume-crash")
    os.makedirs(root, exist_ok=True)
    home = fake_home(root)
    agents = agents_fixture(root)
    launchd = FakeLaunchd(loaded={"com.omp-kit.fleet-watch"})
    cwd = os.path.join(root, "runtime-pane")
    os.makedirs(cwd, exist_ok=True)
    os.makedirs(os.path.join(cwd, ".git"), exist_ok=True)
    watchdog_user = os.path.join(fr_save.agent_dir(home, "claude"), "WATCHDOG.yml")
    watchdog_project = os.path.join(cwd, "WATCHDOG.yaml")
    with open(watchdog_user, "w") as fh:
        fh.write("advisor: selftest-user\n")
    with open(watchdog_project, "w") as fh:
        fh.write("advisor: selftest-project\n")
    pane = Pane("w:0.1", "%101", 101, cwd, advisor="runtime", flags="--profile claude")
    fleet = FakeFleet([pane], launchd)
    original_run = fleet.run

    show_badge_after: dict[str, float] = {}

    def delayed_advisor_run(argv, env):
        out = original_run(argv, env)
        if argv and argv[0] == "ntm" and argv[-1] == "/advisor on":
            show_badge_after["at"] = fleet.t + 10
        return out

    original_capture = fleet.capture

    def delayed_advisor_capture(pane_id):
        screen = original_capture(pane_id)
        due = show_badge_after.get("at")
        if due is not None and fleet.t < due:
            return [line.replace(" 👁", "") for line in screen]
        return screen

    ctx = ctx_for(fleet, home, agents, good_env, uid, aligned)
    ctx.run_fn = delayed_advisor_run
    ctx.capture_fn = delayed_advisor_capture
    run_dir = os.path.join(root, "run")
    fr_run.plan_run(run_dir, ctx, "%3", fr.DEFAULT_PROTECT, wave=1, busy_timeout_min=0, only=["w:0.1"])
    approval = approve(run_dir)
    original_add = fr_run.Ledger.add

    class CrashAfterAdvisorReceipt(BaseException):
        pass

    def crash_before_advisor_result(ledger, event, **kw):
        if event == "ADVISOR_SENT":
            raise CrashAfterAdvisorReceipt()
        return original_add(ledger, event, **kw)

    fr_run.Ledger.add = crash_before_advisor_result
    crashed = False
    try:
        fr_run.apply_run(run_dir, ctx, approval)
    except CrashAfterAdvisorReceipt:
        crashed = True
    finally:
        fr_run.Ledger.add = original_add

    events = fr_run.Ledger(os.path.join(run_dir, fr_run.LEDGER), fleet.clock).events()
    intents = [event for event in events if event["event"] == "ADVISOR_INTENT"]
    receipts = [event for event in events if event["event"] == "ADVISOR_SENT"]
    case("NEG crash after advisor send receipt preserves a durable intent before the result ledger",
         crashed and len(intents) == 1 and not receipts and fleet.count("w:0.1", "/advisor on") == 1
         and intents[0].get("source") == "runtime" and intents[0].get("badge_before") is True,
         json.dumps({"crashed": crashed, "intent": intents, "receipts": receipts}))

    save_doc = fw.read_json(os.path.join(run_dir, "save.json"))
    saved_advisor = next(row["advisor"] for row in save_doc["rows"] if row["pane"] == "w:0.1")
    expected_watchdogs = [
        {"scope": "user", "path": watchdog_user, "sha256": fr_save.sha256_file(watchdog_user)},
        {"scope": "project", "path": watchdog_project, "sha256": fr_save.sha256_file(watchdog_project)},
    ]
    case("CTL save.json exports pre-run runtime badge/source and exact WATCHDOG hashes",
         saved_advisor.get("on") is True and saved_advisor.get("source") == "runtime"
         and saved_advisor.get("watchdog_files") == expected_watchdogs, json.dumps(saved_advisor))

    report, rc = fr_run.apply_run(run_dir, ctx, approval, resume_run=True)
    exported = fw.read_json(os.path.join(run_dir, "report.json"))
    evidence = next((row for row in exported.get("advisor_evidence", []) if row["pane"] == "w:0.1"), {})
    case("CTL report.json exports advisor restoration with its pre-run source and hashes",
         evidence.get("badge_before") is True and evidence.get("source") == "runtime"
         and evidence.get("watchdog_files") == expected_watchdogs and evidence.get("result") == "ADVISOR_RESTORED"
         and all(row["status"] == "SAME" for row in exported["watchdog_drift"]),
         json.dumps({"evidence": evidence, "drift": exported.get("watchdog_drift")}))
    case("CTL resume reconciles the delayed badge without a duplicate /advisor on",
         rc == 0 and pane.badge and fleet.count("w:0.1", "/advisor on") == 1
         and next((row.get("advisor") for row in report["panes"] if row["pane"] == "w:0.1"), None) == "ADVISOR_RESTORED",
         json.dumps({"rc": rc, "sends": fleet.count("w:0.1", "/advisor on"), "panes": report.get("panes")}))


# ---------- 1. check-env ----------

def gate_check_env(case, tmp, good_env):
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}
    env.update(good_env)
    script = os.path.join(HERE, "fleet_restart.py")
    p = subprocess.run([sys.executable, script, "check-env"], capture_output=True, text=True, env=env)
    case("CTL check-env with the fleet socket -> exit 0, ok", p.returncode == 0 and json.loads(p.stdout)["ok"] is True, p.stdout + p.stderr)
    p = subprocess.run([sys.executable, script, "env"], capture_output=True, text=True, env=env)
    case("NEG removed subcommand `env` rejected by argparse (uxr3: ran /usr/bin/env)",
         p.returncode == 2 and "invalid choice" in p.stderr and not p.stdout, "rc=%d %s" % (p.returncode, p.stderr[-200:]))


# ---------- 2. watchers ----------

def gate_watchers(case, tmp, uid):
    root = os.path.join(tmp, "watchers")
    d = agents_fixture(root, extra=True)
    reg = fw.load_registry()
    ld = FakeLaunchd(loaded={"com.omp-kit.fleet-watch", "com.omp-kit.ci-poller", "com.example.sender", "com.example.script-actor", "com.example.reader"})
    disc = fw.discover(d, reg, ld.run, uid)
    status = {j["label"]: j["status"] for j in disc["jobs"]}
    case("CTL pause plan = exactly the loaded pause:true jobs (unloaded fleet-flush and reader ci-poller excluded)",
         disc["pause_plan"] == ["com.omp-kit.fleet-watch"], json.dumps(disc["pause_plan"]))
    case("NEG unregistered plist with `tmux send-keys` in ProgramArguments -> HOLD_UNCLASSIFIED",
         status.get("com.example.sender") == "HOLD_UNCLASSIFIED", json.dumps(status))
    case("NEG unregistered job whose named script calls [\"ntm\", \"send\"] -> HOLD_UNCLASSIFIED",
         status.get("com.example.script-actor") == "HOLD_UNCLASSIFIED", json.dumps(status))
    case("CTL unregistered job without a pane-actor signature is not held",
         status.get("com.example.reader") == "UNREGISTERED" and status.get("com.example.idle-actor") == "UNCLASSIFIED_NOT_LOADED", json.dumps(status))
    case("CTL unreadable plist reported, not fatal", [os.path.basename(u["plist"]) for u in disc["unreadable"]] == ["com.example.broken.plist"],
         json.dumps(disc["unreadable"]))
    case("CTL registry seed: 5 pause:true, 7 readers",
         sorted(k for k, v in reg.items() if v["pause"]) == ["com.omp-kit.fleet-flush", "com.omp-kit.fleet-watch", "com.omp-kit.kit-update",
                                                              "com.omp-kit.omp-watch", "com.omp-kit.scratch-reaper"]
         and sum(1 for v in reg.values() if not v["pause"] and v["class"] == "reader") == 7)

    run_dir = os.path.join(root, "run1")
    os.makedirs(run_dir)
    ld = FakeLaunchd(loaded={"com.omp-kit.fleet-watch", "com.omp-kit.ci-poller"})
    d = agents_fixture(os.path.join(root, "clean"))
    disc = fw.discover(d, reg, ld.run, uid)
    dry = fw.pause(run_dir, disc, ld.run, uid, 1000, apply=False)
    case("CTL watchers pause default is a dry run (no bootout/bootstrap)", not ld.mutations() and dry["mode"] == "DRY_RUN")
    rec = fw.pause(run_dir, disc, ld.run, uid, 1000, ttl_min=90, apply=True)
    dm = rec["deadman"]
    with open(dm["plist"], "rb") as fh:
        dmp = plistlib.load(fh)
    case("CTL pause apply: dead-man installed (StartInterval 300, resume --if-expired --apply) before any bootout",
         dmp["StartInterval"] == 300 and dmp["ProgramArguments"][1:] == [fw.SCRIPT_PATH, "watchers", "resume", "--run", run_dir, "--if-expired", "--apply"]
         and ld.mutations()[0][1] == "bootstrap" and ld.mutations()[0][3] == dm["plist"], json.dumps(ld.mutations()))
    rows = {r["label"]: r["action"] for r in rec["rows"]}
    case("CTL pause apply: loaded fleet-watch booted out, unloaded fleet-flush recorded SKIP_NOT_LOADED",
         rows == {"com.omp-kit.fleet-watch": "BOOTED_OUT", "com.omp-kit.fleet-flush": "SKIP_NOT_LOADED"}
         and "com.omp-kit.fleet-watch" not in ld.loaded and "com.omp-kit.ci-poller" in ld.loaded, json.dumps(rows))
    n = len(ld.mutations())
    res = fw.resume(run_dir, ld.run, uid, 1000 + 89 * 60, if_expired=True, apply=True)
    case("NEG resume --if-expired before expires_at -> no-op", res["result"] == "NOT_EXPIRED" and len(ld.mutations()) == n
         and "com.omp-kit.fleet-watch" not in ld.loaded, res["result"])
    res = fw.resume(run_dir, ld.run, uid, 1000 + 91 * 60, if_expired=True, apply=True)
    boots = [c[3] for c in ld.mutations()[n:] if c[1] == "bootstrap"]
    case("CTL resume after expiry bootstraps only the paused-and-loaded row; unloaded-before job stays unloaded",
         res["result"] == "RESUMED" and boots == [os.path.join(d, "com.omp-kit.fleet-watch.plist")]
         and "com.omp-kit.fleet-watch" in ld.loaded and "com.omp-kit.fleet-flush" not in ld.loaded, json.dumps(boots))
    case("CTL resume removes the dead-man job and plist, writes watchers-resumed.json",
         dm["label"] not in ld.loaded and not os.path.exists(dm["plist"]) and os.path.isfile(os.path.join(run_dir, fw.RESUMED)))
    n = len(ld.mutations())
    res = fw.resume(run_dir, ld.run, uid, 1000 + 92 * 60, apply=True)
    case("CTL resume twice is idempotent (ALREADY_LOADED, zero launchctl mutations)",
         res["result"] == "RESUMED" and [r["action"] for r in res["rows"]] == ["ALREADY_LOADED"] and len(ld.mutations()) == n, json.dumps(res["rows"]))

    run_dir = os.path.join(root, "run2")
    os.makedirs(run_dir)
    ld = FakeLaunchd(loaded={"com.omp-kit.fleet-watch"}, refuse_bootstrap={fw.deadman_label(run_dir)})
    disc = fw.discover(d, reg, ld.run, uid)
    rec = fw.pause(run_dir, disc, ld.run, uid, 1000, apply=True)
    case("NEG dead-man fails to load -> pause refused, zero bootouts",
         rec.get("refused") == "DEADMAN_NOT_LOADED" and not [c for c in ld.mutations() if c[1] == "bootout"] and "com.omp-kit.fleet-watch" in ld.loaded,
         json.dumps(rec.get("refused")))

# ---------- 2b. watchers approval binding (ompkit-rhy9.3) ----------

def gate_watchers_binding(case, tmp, uid, good_env, aligned):
    """The run approval binds classification + the loaded pause:true set + exact
    plist bytes; drift refuses before effects. Resume restores exactly the rows
    this run booted out, verifies loaded state, and never bootstraps changed
    bytes. launchctl, ntm, tmux, the clock and sleep are fakes: nothing here
    touches the live fleet or launchd (native proof lives in gates_native)."""
    root = os.path.join(tmp, "watchers-binding")
    os.makedirs(root, exist_ok=True)
    home = fake_home(root)

    def fresh_run(name, loaded=("com.omp-kit.fleet-watch", "com.omp-kit.ci-poller")):
        ld = FakeLaunchd(loaded=set(loaded))
        ag = agents_fixture(os.path.join(root, "a-" + name))
        fl = fleet_fixture(os.path.join(root, "f-" + name), ld)
        ctx = ctx_for(fl, home, ag, good_env, uid, aligned)
        rd = os.path.join(root, "rb-" + name)
        man = fr_run.plan_run(rd, ctx, "%3", fr.DEFAULT_PROTECT, wave=1, busy_timeout_min=0)
        return ld, ag, fl, ctx, rd, man

    ld, ag, fl, ctx, rd, man = fresh_run("ctl")
    binding = man["watchers"]["binding"]
    want_plist = os.path.join(ag, "com.omp-kit.fleet-watch.plist")
    case("CTL run manifest binds classification + loaded pause:true set + plist bytes",
         [(r["label"], r["plist"], r["class"]) for r in binding["pause"]]
         == [("com.omp-kit.fleet-watch", want_plist, "pane-actor")]
         and all(len(r["plist_sha256"]) == 64 for r in binding["pause"])
         and binding["registry_sha256"] == fw.registry_digest(ctx.registry)
         and binding["unclassified"] == [], json.dumps(binding))
    case("CTL fresh discovery still matches the approval binding (no drift)",
         fw.binding_drift(binding, fw.discover(ag, ctx.registry, ld.run, uid), ctx.registry) is None)
    tpl_res = pysafe.run_bounded([sys.executable, os.path.join(HERE, "fleet_restart.py"), "approval-template", "--manifest",
                                  os.path.join(rd, fr_run.RUN_MANIFEST)], timeout=120)
    tpl = json.loads(tpl_res.text())
    case("CTL approval-template names the precise observed set/plist identities",
         tpl["watchers_pause"] == ["com.omp-kit.fleet-watch"]
         and [(r["label"], r["plist"]) for r in tpl["watchers_pause_detail"]] == [("com.omp-kit.fleet-watch", want_plist)]
         and all(len(r["plist_sha256"]) == 64 for r in tpl["watchers_pause_detail"])
         and tpl["watchers_registry_sha256"] == binding["registry_sha256"], json.dumps(tpl)[:300])

    def drift_case(name, mutate, fragment):
        ld2, ag2, fl2, ctx2, rd2, man2 = fresh_run(name)
        approval = approve(rd2)
        mutate(ld2, ag2, fl2, ctx2)
        rep, rc = fr_run.apply_run(rd2, ctx2, approval)
        ev = [json.loads(ln)["event"] for ln in open(os.path.join(rd2, fr_run.LEDGER))]
        case("NEG %s -> APPROVAL_WATCHERS_DRIFT, zero sends, zero launchctl mutations" % name,
             rep.get("refused", "").startswith("APPROVAL_WATCHERS_DRIFT:") and fragment in rep.get("refused", "")
             and rc == fr_run.EXIT_REFUSED and not fl2.sends and not ld2.mutations() and "WATCHERS_PAUSE" not in ev,
             json.dumps(rep.get("refused")))

    def add_actor(ld2, ag2, fl2, ctx2):
        write_plist(ag2, "com.example.sender", ["/bin/sh", "-c", "tmux send-keys -t %3 Enter"])
        ld2.loaded.add("com.example.sender")

    def change_bytes(ld2, ag2, fl2, ctx2):
        write_plist(ag2, "com.omp-kit.fleet-watch", ["/x/omp-kit", "service", "run", "watch-changed"])

    def unload(ld2, ag2, fl2, ctx2):
        ld2.loaded.discard("com.omp-kit.fleet-watch")

    def reclassify(ld2, ag2, fl2, ctx2):
        reg = dict(ctx2.registry)
        entry = dict(reg["com.omp-kit.fleet-watch"])
        entry["pause"] = False
        reg["com.omp-kit.fleet-watch"] = entry
        ctx2.registry = reg

    def add_member(ld2, ag2, fl2, ctx2):
        write_plist(ag2, "com.omp-kit.kit-update", ["/x/omp-kit", "service", "run", "kit-update"])
        ld2.loaded.add("com.omp-kit.kit-update")

    drift_case("loaded unregistered tmux send-keys actor after plan", add_actor, "HOLD_UNCLASSIFIED")
    drift_case("approved plist bytes changed after plan", change_bytes, "plist bytes changed")
    drift_case("approved job unloaded before apply", unload, "no longer loaded")
    drift_case("registry reclassifies an approved job after plan", reclassify, "classification changed")
    drift_case("loaded pause:true membership changed after plan", add_member, "set changed")

    # crash before the pause: nothing booted out, so the resume still matches.
    ld3, ag3, fl3, ctx3, rd3, man3 = fresh_run("crashsave")
    restore = crash_on("PRESERVE")
    try:
        fr_run.apply_run(rd3, ctx3, approve(rd3))
        crashed = False
    except RuntimeError:
        crashed = True
    finally:
        restore()
    rep, rc = fr_run.apply_run(rd3, ctx3, approve(rd3), resume_run=True)
    w101 = next((p for p in rep.get("panes", []) if p["pane"] == "w:0.1"), {})
    case("CTL crash before pause: resume_run still matches the binding and verifies (no false drift)",
         crashed and "APPROVAL_WATCHERS_DRIFT" not in str(rep.get("refused")) and w101.get("result") == "VERIFIED"
         and rc == fr_run.EXIT_FAILED, json.dumps([crashed, rep.get("refused"), w101.get("result"), rc]))

    # resume restores service state with zero pane sends: restoration is not dispatch.
    ld4, ag4, fl4, ctx4, rd4, man4 = fresh_run("barrier")
    real_resume = fw.resume
    seen = {}

    def guarded(run_dir, run_fn, uid_arg, now, **kw):
        n0 = len(fl4.sends)
        try:
            return real_resume(run_dir, run_fn, uid_arg, now, **kw)
        finally:
            seen["new_sends"] = len(fl4.sends) - n0

    fw.resume = guarded
    try:
        rep, rc = fr_run.apply_run(rd4, ctx4, approve(rd4))
    finally:
        fw.resume = real_resume
    case("CTL watchers resume restores service state with zero pane sends (restoration is not dispatch)",
         seen.get("new_sends") == 0 and rep["watchers"]["resume"]["result"] == "RESUMED"
         and "com.omp-kit.fleet-watch" in ld4.loaded, json.dumps(rep["watchers"]["resume"]))

    # resume-side byte binding, bootstrap failure, TTL kill, raised step (fake launchctl).
    rd = os.path.join(root, "resume-tamper")
    os.makedirs(rd)
    ag = agents_fixture(os.path.join(root, "a-tamper"))
    ld = FakeLaunchd(loaded={"com.omp-kit.fleet-watch", "com.omp-kit.ci-poller"})
    reg = fw.load_registry()
    rec = fw.pause(rd, fw.discover(ag, reg, ld.run, uid), ld.run, uid, 1000, apply=True)
    write_plist(ag, "com.omp-kit.fleet-watch", ["/x/omp-kit", "service", "run", "watch-tampered"])
    res = fw.resume(rd, ld.run, uid, 1000 + 10, apply=True)
    by = {r["label"]: r["action"] for r in res["rows"]}
    case("NEG plist bytes changed between pause and resume -> RESUME_REFUSED_DRIFT, overall RESUME_FAILED, dead-man retained",
         by.get("com.omp-kit.fleet-watch") == "RESUME_REFUSED_DRIFT" and res["result"] == "RESUME_FAILED"
         and fw.deadman_label(rd) in ld.loaded and os.path.exists(rec["deadman"]["plist"])
         and "com.omp-kit.fleet-watch" not in ld.loaded, json.dumps(res["rows"]))

    rd = os.path.join(root, "resume-fail")
    os.makedirs(rd)
    ag = agents_fixture(os.path.join(root, "a-fail"))
    ld = FakeLaunchd(loaded={"com.omp-kit.fleet-watch", "com.omp-kit.ci-poller"}, refuse_bootstrap={"com.omp-kit.fleet-watch"})
    fw.pause(rd, fw.discover(ag, reg, ld.run, uid), ld.run, uid, 2000, apply=True)
    res = fw.resume(rd, ld.run, uid, 2000 + 10, apply=True)
    case("NEG failed bootstrap is RESUME_FAILED, never reported as success",
         res["result"] == "RESUME_FAILED" and [r["action"] for r in res["rows"]] == ["RESUME_FAILED"], json.dumps(res["rows"]))

    rd = os.path.join(root, "ttl-kill")
    os.makedirs(rd)
    ag = agents_fixture(os.path.join(root, "a-ttl"))
    ld = FakeLaunchd(loaded={"com.omp-kit.fleet-watch", "com.omp-kit.ci-poller"})
    fw.pause(rd, fw.discover(ag, reg, ld.run, uid), ld.run, uid, 3000, ttl_min=1, apply=True)
    n = len(ld.mutations())
    dead = fw.read_json(os.path.join(rd, fw.PAUSED))
    res = fw.resume(rd, ld.run, uid, dead["expires_epoch"] + 1, if_expired=True, apply=True)
    boots = [c[3] for c in ld.mutations()[n:] if c[1] == "bootstrap"]
    case("CTL killed run past TTL: the dead-man path recovers exactly the actually-paused set and verifies loaded state",
         res["result"] == "RESUMED" and [r["action"] for r in res["rows"]] == ["RESUMED"]
         and boots == [os.path.join(ag, "com.omp-kit.fleet-watch.plist")]
         and "com.omp-kit.fleet-watch" in ld.loaded and "com.omp-kit.fleet-flush" not in ld.loaded
         and fw.deadman_label(rd) not in ld.loaded, json.dumps(res["rows"]))

    rd = os.path.join(root, "raised")
    os.makedirs(rd)
    ag = agents_fixture(os.path.join(root, "a-raised"))
    ld = FakeLaunchd(loaded={"com.omp-kit.fleet-watch", "com.omp-kit.ci-poller"})
    fw.pause(rd, fw.discover(ag, reg, ld.run, uid), ld.run, uid, 4000, apply=True)
    try:
        raise RuntimeError("simulated restart-step crash")
    except RuntimeError:
        resumed = fw.resume(rd, ld.run, uid, 4000 + 5, apply=True)  # the apply_run finally line
    case("CTL raised step still resumes exactly the paused set in finally, verified loaded, dead-man gone",
         resumed["result"] == "RESUMED" and [r["label"] for r in resumed["rows"]] == ["com.omp-kit.fleet-watch"]
         and "com.omp-kit.fleet-watch" in ld.loaded and "com.omp-kit.fleet-flush" not in ld.loaded
         and fw.deadman_label(rd) not in ld.loaded, json.dumps(resumed["rows"]))

    # standalone pause approval through the real manifest_sha: a byte change with
    # identical labels must change the approval sha (a success-path --apply here
    # would boot out live production watchers, so the live-command refusal lives
    # in gates_native with owned labels).
    agb = agents_fixture(os.path.join(root, "a-bytes"))
    ldb = FakeLaunchd(loaded={"com.omp-kit.fleet-watch"})
    regb = fw.load_registry()
    man1 = fw.pause_plan_manifest(fw.discover(agb, regb, ldb.run, uid))
    sha1 = fr.manifest_sha(dict(man1))
    write_plist(agb, "com.omp-kit.fleet-watch", ["/x/omp-kit", "service", "run", "watch-drifted"])
    man2 = fw.pause_plan_manifest(fw.discover(agb, regb, ldb.run, uid))
    sha2 = fr.manifest_sha(dict(man2))
    bare = lambda m: {"kind": m["kind"], "rows": [{k: r[k] for k in ("pane", "label")} for r in m["rows"]]}
    case("NEG standalone pause approval is byte-sensitive: same labels, changed plist bytes -> different sha",
         bool(man1["rows"]) and sha1 != sha2
         and man1["rows"][0]["plist_sha256"] != man2["rows"][0]["plist_sha256"]
         and fr.manifest_sha(bare(man1)) == fr.manifest_sha(bare(man2)), json.dumps([sha1[:12], sha2[:12]]))


# ---------- 3. save ----------

def gate_save(case, tmp):
    root = os.path.join(tmp, "save")
    home = fake_home(root)
    sess = "/h/.omp/agent/sessions/-Developer-x/2026-10-13T00-00-00-000Z_abc.jsonl"
    lsof = "p501\nfcwd\nn/tmp/x\nftxt\nn%s\nftxt\nn/usr/lib/dyld\nf38\nn%s\nf39\nn%s\nf40\nn%s\n" % (
        TERN + "18.9.2", sess[:-6] + "/__advisor.jsonl", sess, sess[:-6] + "/FleetWorker.jsonl")
    case("CTL lsof fixture -> main session file (subagent and __advisor transcripts excluded)",
         fr_save.pick_session(fr_save.session_candidates(lsof), None) == (sess, None), json.dumps(fr_save.session_candidates(lsof)))
    case("CTL lsof fixture -> running executable is the first txt name, not a dylib or cwd", fr_save.executable(lsof) == TERN + "18.9.2",
         str(fr_save.executable(lsof)))
    case("NEG no open session jsonl -> HOLD_NO_SESSION", fr_save.pick_session(fr_save.session_candidates("p1\nn/dev/null\n"), None) == (None, "HOLD_NO_SESSION"))
    two = lsof + "n/h/.omp/agent/sessions/-Developer-x/2026-10-12T00-00-00-000Z_old.jsonl\n"
    case("NEG two main session files, no --resume id -> HOLD_SESSION_AMBIGUOUS",
         fr_save.pick_session(fr_save.session_candidates(two), None)[1] == "HOLD_SESSION_AMBIGUOUS")
    case("CTL --resume id in argv picks its session file", fr_save.pick_session(fr_save.session_candidates(two), "abc") == (sess, None))
    case("CTL -r / --restore= session ids read from live argv", fr_save.resume_id("omp --profile x -r abc") == "abc"
         and fr_save.resume_id("omp --restore=abc --model m") == "abc")
    on = [" ⠹ 20m · ◉ Opus 5.5 👁 · 📁 ~/Developer/omp-test · ◫ 38.1%/1M ⟲ · S746.27 (+264.69) + 👁 43.76 "]
    off = [" π · ◉ Opus 5.5 · 📁 ~/Developer/omp-test · ◫ 38.1%/1M"]
    scroll = [" π · ◉ Opus 5.5 👁 · 📁 ~/x · ◫ 1%"] + ["line %d" % i for i in range(10)] + off
    case("CTL 👁 in the live status line -> advisor on", fr.advisor_badge(on) is True)
    case("NEG status line without 👁 -> off", fr.advisor_badge(off) is False)
    case("NEG 👁 only in scrollback -> off", fr.advisor_badge(scroll) is False)
    cost_only = [" π > ◒ Sonnet 5.5 > 📁 ~/Developer/jev > ⑂ main *68 > S170.24 (+1.23) + 👁 19.69 ▶────55%───┃──1M─", "╰─"]
    case("NEG `+ 👁 <cost>` spend segment after 📁 (restored on resume, advisor off) -> off", fr.advisor_badge(cost_only) is False)
    closed = [" π > ◒ Sonnet 5.5 🙈 > 📁 ~/Developer/jev > ⑂ main *68 > S170.24 (+1.23) + 👁 19.69 ▶────55%───┃──1M─", "╰─"]
    case("CTL closed-eye 🙈 (advisors yielded the turn) after the model -> on, model name clean",
         fr.advisor_badge(closed) is True and fr.parse_screen(closed) == {"state": "IDLE", "model": "Sonnet 5.5"}, json.dumps(fr.parse_screen(closed)))
    case("CTL badge does not leak into the parsed model name", fr.parse_screen(on) == {"state": "BUSY", "model": "Opus 5.5"}, json.dumps(fr.parse_screen(on)))
    case("CTL v18.12 `π-<profile>` prompt prefix -> IDLE with badge and clean model",
         fr.parse_screen(screen_of(glyph="π-flag", badge=True)) == {"state": "IDLE", "model": "Opus 5.5"}
         and fr.advisor_badge(screen_of(glyph="π-flag", badge=True)) is True,
         json.dumps(fr.parse_screen(screen_of(glyph="π-flag", badge=True))))
    case("NEG `π-<profile>` prompt without badge -> IDLE but advisor off",
         fr.parse_screen(screen_of(glyph="π-runtime")) == {"state": "IDLE", "model": "Opus 5.5"}
         and fr.advisor_badge(screen_of(glyph="π-runtime")) is False,
         json.dumps(fr.parse_screen(screen_of(glyph="π-runtime"))))
    adir = lambda p: fr_save.agent_dir(home, p)  # noqa: E731
    case("CTL --advisor in live argv -> source flag", fr_save.advisor_state(on, ["--profile", "claude", "--advisor"], adir("claude"))["source"] == "flag")
    case("CTL profile config.yml advisor.enabled (nested) -> source config", fr_save.advisor_state(on, ["--profile", "cfgp"], adir("cfgp"))["source"] == "config")
    case("CTL profile config.yml advisor.enabled (dotted) -> source config", fr_save.advisor_state(on, ["--profile", "dotp"], adir("dotp"))["source"] == "config")
    st = fr_save.advisor_state(on, ["--profile", "claude"], adir("claude"))
    case("NEG modelRoles.advisor model line is not advisor.enabled -> source runtime", st["source"] == "runtime" and st["config"] == "absent", json.dumps(st))

    repo = os.path.join(root, "repo")
    for sub in (".git/logs/refs/remotes/origin", "var/agent-tmp/mine", "var/agent-tmp/theirs", "var/agent-tmp/jsonowner", "var/agent-tmp/pushed",
                "var/agent-tmp/omp.71"):
        os.makedirs(os.path.join(repo, sub))
    for sub, text in [("mine", "pid=71\nlabel=x\n"), ("theirs", "pid: 9999\n"), ("jsonowner", '{"pid": 71}'), ("pushed", "pid=71\n"), ("omp.71", "pid=71\n")]:
        with open(os.path.join(repo, "var/agent-tmp", sub, ".owner"), "w") as fh:
            fh.write(text)
    for sub, mtime in [("mine", 2_000_000_100), ("pushed", 2_000_000_000 - 50), ("omp.71", 2_000_000_900)]:
        path = os.path.join(repo, "var/agent-tmp", sub, "work.txt")
        with open(path, "w") as fh:
            fh.write("x")
        os.utime(path, (mtime, mtime))
    with open(os.path.join(repo, ".git/logs/refs/remotes/origin/main"), "w") as fh:
        fh.write("%s %s Josh <j@x> 1999999000 -0600\tfetch: fast-forward\n" % ("0" * 40, "1" * 40))
        fh.write("%s %s Josh <j@x> 2000000000 -0600\tupdate by push\n" % ("1" * 40, "2" * 40))
    with open(os.path.join(repo, "WATCHDOG.yml"), "w") as fh:
        fh.write("advisors: []\n")
    pane = {"pane": "w:0.9", "pane_id": "%9", "pane_pid": 70, "cwd": os.path.join(repo, "sub"), "screen": on}
    os.makedirs(pane["cwd"])
    procs = [{"pid": 70, "ppid": 1, "args": "-zsh"}, {"pid": 71, "ppid": 70, "args": BUN_OMP + " --profile claude --model m1"}]
    git_calls = []

    def run(argv, env):
        git_calls.append(argv)
        return 0, " M a\n?? b\n"
    row = fr_save.save_pane(pane, procs, home, lambda pid: "p71\nftxt\nn%s\nf9\nn%s\n" % (BUN, sess), run, {})
    owned = {os.path.basename(s["path"]): s["newest_mtime"] for s in row["owned_scratch"]}
    case("CTL last push read from the remote-tracking reflog (`update by push`, not fetch)", row["last_push"] == 2_000_000_000, str(row["last_push"]))
    case("NEG owned work scratch newer than the last push is a HOLD_SCRATCH_OWNER hold; other pid's scratch not owned",
         sorted(owned) == ["jsonowner", "mine", "pushed"] and owned["mine"] == 2_000_000_100 and row["held_scratch"] and row["holds"] == ["HOLD_SCRATCH_OWNER"], json.dumps(owned))
    case("NEG omp.<pid> (the process's own TMPDIR) plus newer work scratch -> HOLD_SCRATCH_OWNER names only the work dir, newest file recorded",
         [os.path.basename(s["path"]) for s in row["held_scratch"]] == ["mine"] and row["held_scratch"][0]["newest_file"].endswith("mine/work.txt")
         and [os.path.basename(s["path"]) for s in row["runtime_scratch"]] == ["omp.71"] and row["holds"] == ["HOLD_SCRATCH_OWNER"], json.dumps(row["held_scratch"]))
    for name, files, want_hold, label in [
            ("only-runtime", [("omp.71", None)], False, "CTL pane owning only omp.<pid> (newer than any push) -> no hold, listed as runtime_scratch"),
            ("other-runtime", [("omp.999", "pid=71\n")], True, "NEG omp.<otherpid> owned by this pid is work, not runtime -> HOLD_SCRATCH_OWNER")]:
        r2 = os.path.join(root, name)
        os.makedirs(os.path.join(r2, "sub"))
        os.makedirs(os.path.join(r2, ".git"))  # a repo with no push recorded: any newer work scratch holds
        for sub, owner in files:
            os.makedirs(os.path.join(r2, "var/agent-tmp", sub))
            if owner:
                with open(os.path.join(r2, "var/agent-tmp", sub, ".owner"), "w") as fh:
                    fh.write(owner)
            with open(os.path.join(r2, "var/agent-tmp", sub, "cache.bin"), "w") as fh:
                fh.write("x")
        rr = fr_save.save_pane(dict(pane, cwd=os.path.join(r2, "sub")), procs, home, lambda pid: "p71\nftxt\nn%s\nf9\nn%s\n" % (BUN, sess), run, {})
        ok = (bool(rr["held_scratch"]) == want_hold) and (("HOLD_SCRATCH_OWNER" in rr["holds"]) == want_hold)
        ok = ok and (bool(rr["runtime_scratch"]) != want_hold)
        case(label, ok, json.dumps({k: rr[k] for k in ("holds", "runtime_scratch", "held_scratch")}))
    row2 = fr_save.save_pane(pane, procs, home, lambda pid: "p71\nftxt\nn%s\nf9\nn%s\n" % (BUN, sess), run, {})
    os.unlink(os.path.join(repo, "var/agent-tmp/mine/work.txt"))
    row3 = fr_save.save_pane(pane, procs, home, lambda pid: "p71\nftxt\nn%s\nf9\nn%s\n" % (BUN, sess), run, {})
    case("NEG owned work scratch newer than the last push holds the pane; once its files predate the push the hold clears",
         row2["held_scratch"] and "HOLD_SCRATCH_OWNER" in row2["holds"] and not row3["held_scratch"] and "HOLD_SCRATCH_OWNER" not in row3["holds"], json.dumps(row3["holds"]))
    # --- ompkit-774u.4.1 AC4: seat-owned scratch carries over the respawn ---
    sid = "abcdef12"
    sess2 = "/h/.omp/agent/sessions/-Developer-x/2026-10-13T00-00-00-000Z_%s.jsonl" % sid
    lsof2 = lambda pid: "p71\nftxt\nn%s\nf9\nn%s\n" % (BUN, sess2)  # noqa: E731
    case("CTL owner seat parses JSON, key=value and legacy 'key: value'; pid-only and half seats are no seat",
         fr_save.owner_seat('{"pid": 71, "agent": "TestAgent", "session": "%s"}' % sid) == ("TestAgent", sid)
         and fr_save.owner_seat("pid=71\nagent=TestAgent\nsession=%s\n" % sid) == ("TestAgent", sid)
         and fr_save.owner_seat("pid: 71\nagent: TestAgent\nsession: %s" % sid) == ("TestAgent", sid)
         and fr_save.owner_seat("pid=71 agent=TestAgent session=%s" % sid) == ("TestAgent", sid)
         and fr_save.owner_seat("pid=71\n") == (None, None)
         and fr_save.owner_seat('{"pid": 71, "agent": "TestAgent"}') == (None, None)
         and fr_save.owner_seat("pid=71\nagent=TestAgent\nsession=abc_defgh\n") == (None, None)
         and fr_save.owner_seat("not an owner") == (None, None)
         and fr_save.owner_seat("") == (None, None), "")
    case("CTL session id from a main transcript path; short ids, advisor-nested and bare paths are None",
         fr_save.session_id_of(sess2) == sid and fr_save.session_id_of(sess) is None
         and fr_save.session_id_of("/h/.omp/agent/sessions/slug/%s/FleetWorker.jsonl" % sid) is None
         and fr_save.session_id_of("/tmp/x.jsonl") is None, "")
    repo2 = os.path.join(root, "repo2")
    os.makedirs(os.path.join(repo2, ".git/logs/refs/remotes/origin"))
    os.makedirs(os.path.join(repo2, "sub"))
    seat_dir = os.path.join(repo2, "var/agent-tmp/seat")
    legacy_dir = os.path.join(repo2, "var/agent-tmp/legacy")
    other_dir = os.path.join(repo2, "var/agent-tmp/other")
    for d in (seat_dir, legacy_dir, other_dir):
        os.makedirs(d)
    with open(os.path.join(seat_dir, ".owner"), "w") as fh:
        fh.write('{"pid": 71, "agent": "TestAgent", "session": "%s"}' % sid)
    with open(os.path.join(legacy_dir, ".owner"), "w") as fh:
        fh.write("pid=71\n")
    with open(os.path.join(other_dir, ".owner"), "w") as fh:
        fh.write('{"pid": 71, "agent": "TestAgent", "session": "ffffffff"}')
    for d in (seat_dir, legacy_dir, other_dir):
        path = os.path.join(d, "work.txt")
        with open(path, "w") as fh:
            fh.write("x")
        os.utime(path, (2_000_000_100, 2_000_000_100))
    with open(os.path.join(repo2, ".git/logs/refs/remotes/origin/main"), "w") as fh:
        fh.write("%s %s Josh <j@x> 2000000000 -0600\tupdate by push\n" % ("1" * 40, "2" * 40))
    lease_dir = os.path.join(home, ".omp", "run", "session-owners")
    os.makedirs(lease_dir)
    with open(os.path.join(lease_dir, sid + ".lock"), "w") as fh:
        fh.write("")
    with open(os.path.join(lease_dir, "ffffffff.lock"), "w") as fh:
        fh.write("")
    live = {"lease": True, "version": "omp-kit 0.2.61\n"}

    def run2(argv, env):
        if argv[:2] == ["omp-kit", "--version"]:
            return 0, live["version"]
        if argv[:2] == ["lsof", "-t"]:
            return (0, "4242\n") if live["lease"] else (1, "")
        return run(argv, env)
    pane2 = dict(pane, cwd=os.path.join(repo2, "sub"))
    carried = fr_save.save_pane(pane2, procs, home, lsof2, run2, {})
    case("CTL seat-owned scratch on a live session lease carries over: the hold narrows to pid-only and foreign-seat dirs; the seat dir is named in carried_scratch",
         carried["session_file"] == sess2 and carried["carried_scratch"] == [seat_dir]
         and sorted(os.path.basename(s["path"]) for s in carried["held_scratch"]) == ["legacy", "other"]
         and carried["holds"] == ["HOLD_SCRATCH_OWNER"], json.dumps({k: carried[k] for k in ("holds", "carried_scratch", "held_scratch")}))
    live["lease"] = False
    unheld = fr_save.save_pane(pane2, procs, home, lsof2, run2, {})
    case("NEG a provably unheld session lease does not carry over: HOLD_SCRATCH_OWNER names the seat dir too",
         "HOLD_SCRATCH_OWNER" in unheld["holds"]
         and sorted(os.path.basename(s["path"]) for s in unheld["held_scratch"]) == ["legacy", "other", "seat"], json.dumps(unheld["holds"]))
    live["lease"] = True
    os.unlink(os.path.join(lease_dir, sid + ".lock"))
    nolock = fr_save.save_pane(pane2, procs, home, lsof2, run2, {})
    case("NEG a missing session-lease lock does not carry over: HOLD_SCRATCH_OWNER stays",
         "HOLD_SCRATCH_OWNER" in nolock["holds"], json.dumps(nolock["holds"]))
    with open(os.path.join(lease_dir, sid + ".lock"), "w") as fh:
        fh.write("")
    def run_old(argv, env):  # noqa: E306
        if argv[:2] == ["omp-kit", "--version"]:
            return 0, "omp-kit 0.2.48\n"
        return run2(argv, env)
    oldkit = fr_save.save_pane(pane2, procs, home, lsof2, run_old, {})
    case("NEG a kit predating seat liveness does not carry over: HOLD_SCRATCH_OWNER stays",
         "HOLD_SCRATCH_OWNER" in oldkit["holds"] and oldkit["carried_scratch"] == [], json.dumps(oldkit["holds"]))
    os.unlink(os.path.join(legacy_dir, "work.txt"))
    os.unlink(os.path.join(other_dir, "work.txt"))
    inv2 = {"panes": [dict(pane2, pane_pid=70)], "procs": procs}
    row_live = fr_save.save_pane(pane2, procs, home, lsof2, run2, {})
    case("CTL once only carried scratch is newer than the push the hold clears",
         row_live["held_scratch"] == [] and row_live["holds"] == [] and row_live["carried_scratch"] == [seat_dir],
         json.dumps(row_live["holds"]))
    case("CTL live re-check before the send drops the hold for carried scratch",
         fr_save.revalidate_respawn(row_live, inv2, lsof2, run2, home) == (None, None),
         json.dumps(fr_save.revalidate_respawn(row_live, inv2, lsof2, run2, home)))
    case("NEG live re-check without run/home keeps today's rule: carried scratch still holds",
         fr_save.revalidate_respawn(row_live, inv2, lsof2)[0] == "HOLD_SCRATCH_OWNER", "")
    live["lease"] = False
    case("NEG live re-check with a dead lease holds on the seat dir",
         fr_save.revalidate_respawn(row_live, inv2, lsof2, run2, home)[0] == "HOLD_SCRATCH_OWNER", "")
    live["lease"] = True
    case("CTL save row: repo, dirt via git --no-optional-locks, profile, model, session, bun executable",
         row["repo"] == repo and row["repo_dirt_count"] == 2 and git_calls and git_calls[0][:2] == ["git", "--no-optional-locks"]
         and row["profile"] == "claude" and row["model"] == "m1" and row["session_file"] == sess and row["bun"] and row["version"] == "bun",
         json.dumps({k: row[k] for k in ("repo", "repo_dirt_count", "model", "version")}))
    wd = row["advisor"]["watchdog_files"]
    case("CTL project-scope WATCHDOG.yml recorded with sha256", [w["scope"] for w in wd] == ["project"] and wd[0]["sha256"], json.dumps(wd))
    doc = {"rows": [row]}
    same = fr_save.watchdog_drift(doc)
    with open(os.path.join(repo, "WATCHDOG.yml"), "a") as fh:
        fh.write("# edited\n")
    changed = fr_save.watchdog_drift(doc)
    case("NEG WATCHDOG roster edited during the run -> drift CHANGED (reported, not rewritten)",
         same[0]["status"] == "SAME" and changed[0]["status"] == "CHANGED" and open(os.path.join(repo, "WATCHDOG.yml")).read().endswith("# edited\n"))



def gate_parallel(case, tmp):
    rows = [{"pane": "a:0.1", "pane_id": "%1", "mode": "RESTART"}, {"pane": "a:0.2", "pane_id": "%2", "mode": "RESTART"}]
    payloads = fr_run.pane_payloads(rows, {}, {"path": "/t"}, {"quote": "go"}, {"TMUX_TMPDIR": "/s"}, "/h", "/rel", None, tmp, os.path.join(tmp, "cancel"), False)
    case("CTL one payload per remaining pane", len(payloads) == 2 and [p["row"]["pane"] for p in payloads] == ["a:0.1", "a:0.2"]
         and payloads[0]["ledger"].endswith("ledger.jsonl"), json.dumps([p["row"]["pane"] for p in payloads]))
    case("NEG fanout refused when the canary breaker has tripped or no run dir is set",
         not fr_run.should_fanout(type("C", (), {"parallel": True, "run_dir": tmp})(), rows, {"trip": {"pane": "c"}, "sends": False})
         and not fr_run.should_fanout(type("C", (), {"parallel": True, "run_dir": None})(), rows, {"trip": None, "sends": True})
         and fr_run.should_fanout(type("C", (), {"parallel": True, "run_dir": tmp})(), rows, {"trip": None, "sends": True}))
def gate_preserve(case, tmp):
    repo = os.path.join(tmp, "preserve-repo")
    os.makedirs(repo)
    subprocess.run(["git", "init", "-q", repo], check=True)
    subprocess.run(["git", "-C", repo, "config", "user.email", "preserve@example.invalid"], check=True)
    subprocess.run(["git", "-C", repo, "config", "user.name", "preserve"], check=True)
    kept = os.path.join(repo, "kept.txt")
    with open(kept, "w") as fh:
        fh.write("base\n")
    subprocess.run(["git", "-C", repo, "add", "kept.txt"], check=True)
    subprocess.run(["git", "-C", repo, "commit", "-q", "-m", "base [test]"], check=True)
    head = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    with open(kept, "w") as fh:
        fh.write("dirty\n")
    scratch = os.path.join(repo, "var", "agent-tmp", "job.9")
    os.makedirs(scratch)
    with open(os.path.join(scratch, "notes.txt"), "w") as fh:
        fh.write("keep-me\n")
    dest = os.path.join(tmp, "preserve-out")
    doc = {"rows": [{"pane": "w:0.9", "repo": repo, "repo_dirt_count": 1,
                     "held_scratch": [{"path": scratch, "newest_mtime": 1, "newest_file": os.path.join(scratch, "notes.txt")}]}]}
    result = fr_save.preserve_work(doc, dest)
    pinned = subprocess.run(["git", "-C", repo, "rev-parse", result["repos"][0]["ref"]], capture_output=True, text=True)
    still = open(kept).read()
    main = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    case("CTL dirty repo pinned on refs/preserve; worktree and HEAD untouched; scratch copied",
         result["ok"] and pinned.returncode == 0 and still == "dirty\n" and main == head
         and open(os.path.join(dest, "scratch", "w:0.9", "job.9", "notes.txt")).read() == "keep-me\n",
         json.dumps(result)[:300])
    missing = fr_save.preserve_work({"rows": [{"pane": "w:0.8", "repo": None, "repo_dirt_count": 0,
                                               "held_scratch": [{"path": os.path.join(tmp, "no-such-scratch")}]}]},
                                    os.path.join(tmp, "preserve-miss"))
    case("NEG missing held scratch refuses preserve", not missing["ok"] and missing["error"], json.dumps(missing)[:200])


def gate_mode(case, tmp):
    def row(exe, args):
        return {"exe_real": exe, "bun": fr_save.is_bun(exe, args)}
    case("NEG versioned older execPath (Tern 18.9.2) -> RESPAWN (/restart re-execs the same build)",
         fr_save.pane_mode(row(TERN + "18.9.2", TERN + "18.9.2 --profile x"), TARGET_INFO) == "RESPAWN")
    case("CTL running executable == target realpath -> RESTART",
         fr_save.pane_mode(row(TARGET, "omp --profile x"), TARGET_INFO) == "RESTART")
    case("NEG bun launch -> RESPAWN (bun re-execs the bun-global package)",
         fr_save.pane_mode(row(BUN, BUN_OMP + " --profile x"), TARGET_INFO) == "RESPAWN")
    case("NEG bun-shaped argv even with the target exe -> RESPAWN", fr_save.pane_mode({"exe_real": TARGET, "bun": True}, TARGET_INFO) == "RESPAWN")
    case("NEG executable unknown -> RESPAWN (never assume RESTART)", fr_save.pane_mode({"exe_real": None, "bun": False}, TARGET_INFO) == "RESPAWN")
    case("CTL version parsed from the Tern versions path", fr_save.version_of(TARGET) == "18.10.3" and fr_save.version_of(BUN) is None)

    def fake_zsh(out, rc=0):
        return lambda argv, env: (rc, out) if argv[:2] == ["zsh", "-lc"] else (1, "")
    link_dir = os.path.join(tmp, "mode", "bin")
    os.makedirs(link_dir)
    real = os.path.join(tmp, "mode", "versions", "18.10.3")
    os.makedirs(os.path.dirname(real))
    open(real, "w").close()
    os.symlink(real, os.path.join(link_dir, "omp"))
    t = fr_save.target_live(fake_zsh(os.path.join(link_dir, "omp") + "\n"))
    case("CTL target = realpath of the login shell's `omp`, version recorded",
         t["ok"] and t["path"] == os.path.realpath(real) and t["version"] == "18.10.3", json.dumps(t))
    case("NEG login shell without omp -> target not ok (plan refuses TARGET_UNKNOWN)", not fr_save.target_live(fake_zsh("", 1))["ok"])

    for args, want in [(TERN + "18.9.2 --profile codex -r abc --model m", ["--profile", "codex", "--model", "m"]),
                       ("omp --restore=abc --thinking high", ["--thinking", "high"]),
                       (BUN_OMP + " --profile muse --resume S1 --auto-approve", ["--profile", "muse", "--auto-approve"])]:
        got = fr.normalize_flags(fr.omp_match(args))
        case("CTL argv0 and --resume/-r/--restore stripped: %s" % args[-40:], got == want, json.dumps(got))
    r = {"pane": "w:0.1", "pane_id": "%1", "session": "w", "cwd": "/w d", "flags": ["--profile", "codex", "--model", "m"]}
    rr = fr.respawn_row(r, {"session_file": "/s/sessions/-w/S.jsonl", "holds": [], "advisor": {"on": True, "source": "runtime"}})
    argv = fr.tmux_respawn_argv(rr)
    inner = shlex.split(argv[-1])
    toks = shlex.split(inner[2].split("&&", 1)[1].rsplit(";", 1)[0])
    case("CTL respawn argv: tmux respawn-pane -k -t <id> -c <cwd> zsh -lc 'cd … && omp <live flags> --resume <file> --advisor; exec zsh -l'",
         argv[:7] == ["tmux", "respawn-pane", "-k", "-t", "%1", "-c", "/w d"] and inner[:2] == ["zsh", "-lc"] and inner[2].endswith("; exec zsh -l")
         and inner[2].startswith("cd '/w d' && ") and toks == ["omp", "--profile", "codex", "--model", "m", "--resume", "/s/sessions/-w/S.jsonl", "--advisor"],
         json.dumps(argv))
    case("NEG respawn command never carries a versioned path or bun", TERN not in argv[-1] and "bun" not in argv[-1])

    case("CTL empty composer (plain '❯' row) -> ''", fr.composer_text(screen_of()) == "")
    case("NEG typed text in the composer -> returned (HOLD_COMPOSER)", fr.composer_text(screen_of(composer="please also fix the README")) == "please also fix the README")
    boxed_empty = ["╭── π > ⟳ Sonnet 5.5 > 📁 ~/m > (sub) ▶──9%──╮", "│                         │", "╰─                      ─╯"]
    boxed_text = ["╭── π > ⟳ Sonnet 5.5 > 📁 ~/m > (sub) ▶──9%──╮", "│ queued: rebase first    │", "╰─                      ─╯"]
    case("CTL boxed composer empty -> ''", fr.composer_text(boxed_empty) == "")
    case("NEG boxed composer with text -> held", fr.composer_text(boxed_text) == "queued: rebase first")
    case("NEG unknown layout under the status bar -> None (fail closed)", fr.composer_text([STATUS.format(glyph="π", badge="", model="M"), "autocomplete: /restart"]) is None)


# ---------- 5. respawn ----------

def gate_respawn(case, tmp, uid, good_env, plan):
    rows = [r for r in plan["rows"] if r["action"] == "RESTART"]
    a, b = rows[0], rows[1]

    def saved(r, source="runtime", on=True, holds=()):
        return {"pane_id": r["pane_id"], "session_file": "/s/sessions/-w/%s.jsonl" % r["pane_id"][1:], "holds": list(holds), "advisor": {"on": on, "source": source}}
    row = fr.respawn_row(a, saved(a))
    toks = row["cmd"].split()
    case("CTL respawn argv = live flags + --resume <session file> + --advisor (runtime advisor)",
         toks[toks.index("--resume") + 1] == "/s/sessions/-w/%s.jsonl" % a["pane_id"][1:] and toks.count("--advisor") == 1 and row["added"] == ["--advisor"]
         and fr.check_cmd_flags(row["cmd"], a["flags"], row["added"], row["session_file"])[0], row["cmd"])
    case("CTL config-sourced advisor -> respawn adds no --advisor", "--advisor" not in fr.respawn_row(a, saved(a, "config"))["cmd"].split())
    flagged = dict(a, flags=a["flags"] + ["--advisor"])
    case("CTL flag-sourced advisor -> exactly one --advisor", fr.respawn_row(flagged, saved(flagged, "flag"))["cmd"].split().count("--advisor") == 1)
    case("CTL advisor off -> no --advisor", "--advisor" not in fr.respawn_row(a, saved(a, on=False))["cmd"].split())
    sv = {"rows": [saved(a, holds=["HOLD_SCRATCH_OWNER"]), dict(saved(b), session_file=None, holds=["HOLD_NO_SESSION"])]}
    man = fr.restart_manifest(plan, mode="respawn", save=sv)
    case("NEG HOLD_SCRATCH_OWNER gets no respawn row (zero respawn), like HOLD_NO_SESSION",
         [r["pane"] for r in man["rows"]] == [] and sorted(h["pane"] for h in man["held"]) == sorted([a["pane"], b["pane"]]), json.dumps(man["held"]))
    try:
        fr.restart_manifest(plan, mode="respawn")
        code = "NO_ERROR"
    except ValueError as exc:
        code = str(exc).split(":", 1)[0]
    case("NEG respawn manifest without save.json -> SAVE_REQUIRED (a fresh session would drop the conversation)", code == "SAVE_REQUIRED", code)
    man = fr.restart_manifest(plan, mode="respawn", save={"rows": [saved(a), saved(b, on=False)]})
    for r in man["rows"]:
        if r["pane_id"] == b["pane_id"]:
            r["cmd"] = r["cmd"].replace(r["session_file"], "/s/sessions/-w/other.jsonl")
    calls = []
    passing = lambda r: (None, None)  # noqa: E731  (live revalidation has its own gates below)
    res = fr.send(man, apply=True, approval=dict(APPROVE, manifest_sha256=fr.manifest_sha(man)), env=good_env, uid=uid,
                  capture_fn=lambda pid: screen_of(), run_fn=lambda argv, env: (calls.append(argv), (0, "{}"))[1], revalidate_fn=passing)
    by = {r["pane"]: r["result"] for r in res["rows"]}
    case("NEG respawn row resuming a different session file -> REFUSED_RESUME_NOT_SAVED_SESSION; intact row SENT",
         by.get(b["pane"]) == "REFUSED_RESUME_NOT_SAVED_SESSION" and by.get(a["pane"]) == "SENT" and len(calls) == 1, json.dumps(by))
    calls.clear()
    res = fr.send(man, apply=True, approval=dict(APPROVE, manifest_sha256=fr.manifest_sha(man)), env=good_env, uid=uid,
                  capture_fn=lambda pid: screen_of(composer="half-typed reply"), run_fn=lambda argv, env: (calls.append(argv), (0, "{}"))[1],
                  revalidate_fn=passing)
    case("NEG non-empty composer at send time -> HELD_COMPOSER, nothing sent",
         res["rows"][0]["result"] == "HELD_COMPOSER" and not calls, json.dumps(res["rows"]))
    calls.clear()
    res = fr.send(man, apply=True, approval=dict(APPROVE, manifest_sha256=fr.manifest_sha(man)), env=good_env, uid=uid,
                  capture_fn=lambda pid: screen_of(), run_fn=lambda argv, env: (calls.append(argv), (0, "{}"))[1])
    case("NEG manual respawn send without live revalidation -> REFUSED_NO_REVALIDATION, nothing sent",
         {r["result"] for r in res["rows"]} <= {"REFUSED_NO_REVALIDATION", "REFUSED_RESUME_NOT_SAVED_SESSION"}
         and any(r["result"] == "REFUSED_NO_REVALIDATION" for r in res["rows"]) and not calls, json.dumps(res["rows"]))


# ---------- 4 + 6. advisor re-apply and the autonomous run ----------

def fleet_fixture(root, ld):
    cwd = os.path.join(root, "w")
    os.makedirs(cwd, exist_ok=True)
    os.makedirs(os.path.join(cwd, ".git"), exist_ok=True)
    panes = [Pane("w:0.1", "%101", 101, cwd, advisor="runtime"),
             Pane("w:0.2", "%102", 102, cwd),
             Pane("w:0.3", "%103", 103, cwd, advisor="config", flags="--profile cfgp"),
             Pane("w:0.4", "%104", 104, cwd, advisor="flag"),
             Pane("w:0.5", "%105", 105, cwd, advisor="runtime", badge_ok=False),
             Pane("w:0.6", "%106", 106, cwd, busy_until=1e12),
             Pane("w:0.7", "%107", 107, cwd, busy_until=1_000_000.0 + 90),
             Pane("r:0.1", "%201", 201, cwd, kind="tern", advisor="runtime", flags="--profile codex --model gpt-6-luna"),
             Pane("r:0.2", "%202", 202, cwd, kind="bun", flags="--profile muse --thinking high"),
             Pane("r:0.4", "%204", 204, cwd, kind="tern", composer="unsent operator note"),
             Pane("r:0.5", "%205", 205, cwd, kind="bun", session=False),
             Pane("r:0.6", "%206", 206, cwd, kind="tern"),
             Pane("uds--burn-down:0.0", "%31", 31, cwd),
             Pane("omp-test:0.1", "%3", 3, cwd, kind="bun", advisor="runtime")]
    for name, owner, fname in [("job.2061", "pid=2061\n", "notes.txt"), ("omp.2011", "pid=2011\n", "compile-cache.bin")]:
        d = os.path.join(cwd, "var", "agent-tmp", name)  # r:0.6 (omp 2061) owns unpushed work; r:0.1 (omp 2011) only its runtime dir
        os.makedirs(d, exist_ok=True)
        for f, text in [(".owner", owner), (fname, "x")]:
            with open(os.path.join(d, f), "w") as fh:
                fh.write(text)
    return FakeFleet(panes, ld)


def gate_run(case, tmp, uid, good_env, aligned):
    root = os.path.join(tmp, "run")
    home = fake_home(root)
    agents = agents_fixture(root)
    ld = FakeLaunchd(loaded={"com.omp-kit.fleet-watch", "com.omp-kit.ci-poller"})
    fleet = fleet_fixture(root, ld)
    ctx = ctx_for(fleet, home, agents, good_env, uid, aligned)
    run_dir = os.path.join(root, "r1")
    man = fr_run.plan_run(run_dir, ctx, "%3", fr.DEFAULT_PROTECT, wave=3, busy_timeout_min=5)
    rows = {r["pane"]: r for r in man["rows"]}
    acts = {p: r["action"] for p, r in rows.items()}
    case("CTL run --plan: manifest has target, stages, rows, watchers to pause, holds, stage-1 snapshot; nothing sent or booted out",
         man["target"]["path"] == TARGET and man["stages"][0] == "preflight" and man["watchers"]["pause"] == ["com.omp-kit.fleet-watch"]
         and man["snapshot_dir"].endswith("/snapshot") and acts["w:0.6"] == "QUEUE_BUSY" and acts["uds--burn-down:0.0"] == "SKIP_PROTECTED"
         and not fleet.sends and not ld.mutations() and man["counts"]["advisor_on"] == 6, json.dumps(man["counts"]))
    case("CTL plan modes: target exe -> RESTART; Tern 18.9.2 and bun -> RESPAWN",
         rows["w:0.1"]["mode"] == "RESTART" and rows["r:0.1"]["mode"] == "RESPAWN" and rows["r:0.2"]["mode"] == "RESPAWN"
         and man["counts"]["versions"].get("bun") == 3 and man["counts"]["versions"].get("18.9.2") == 3, json.dumps(man["counts"]))
    case("NEG plan: typed text in a composer -> HOLD_COMPOSER; RESPAWN pane without a session file -> HOLD_NO_SESSION",
         acts["r:0.4"] == "HOLD_COMPOSER" and acts["r:0.5"] == "HOLD_NO_SESSION", json.dumps({k: acts[k] for k in ("r:0.4", "r:0.5")}))
    case("NEG plan: RESPAWN pane owning unpushed work scratch -> HOLD_SCRATCH_OWNER, zero respawn even though preserve succeeds",
         acts["r:0.6"] == "HOLD_SCRATCH_OWNER" and rows["r:0.6"]["holds"] == ["HOLD_SCRATCH_OWNER"], json.dumps(rows["r:0.6"]))
    ch = man["chief_respawn"]
    case("CTL chief never in the run: SKIP_CHIEF, and its exact respawn command printed for the operator",
         acts["omp-test:0.1"] == "SKIP_CHIEF" and ch and ch["argv"][:5] == ["tmux", "respawn-pane", "-k", "-t", "%3"] and "--resume" in ch["argv"][-1]
         and "--advisor" in ch["argv"][-1], json.dumps(ch))
    tpl = json.loads(subprocess.run([sys.executable, os.path.join(HERE, "fleet_restart.py"), "approval-template", "--manifest",
                                     os.path.join(run_dir, fr_run.RUN_MANIFEST)], capture_output=True, text=True).stdout)
    case("CTL approval-template binds the run manifest sha, lists watchers to pause and the target",
         tpl["manifest_sha256"] == man["manifest_sha256"] and tpl["watchers_pause"] == ["com.omp-kit.fleet-watch"] and tpl["unprotect"] == []
         and tpl["target"]["path"] == TARGET, json.dumps(tpl)[:200])

    for label, approval in [("no approval -> APPROVAL_MISSING", None),
                            ("unfilled template -> APPROVAL_MISSING", dict(tpl)),
                            ("approval for another sha -> APPROVAL_MISMATCH", dict(APPROVE, manifest_sha256="0" * 64))]:
        rep, rc = fr_run.apply_run(run_dir, ctx, approval)
        case("NEG run --apply %s, zero sends, zero launchctl mutations, no ledger" % label,
             rc == fr_run.EXIT_REFUSED and rep["refused"] == label.rsplit("-> ", 1)[1] and not fleet.sends and not ld.mutations()
             and not os.path.exists(os.path.join(run_dir, fr_run.LEDGER)), json.dumps(rep))
    good = approve(run_dir)
    path = os.path.join(run_dir, fr_run.RUN_MANIFEST)
    with open(path) as fh:
        stale = json.load(fh)
    stale["wave"] = 30
    fw.write_json(path, stale)
    rep, rc = fr_run.apply_run(run_dir, ctx, good)
    case("NEG manifest changed after approval (stale sha) -> APPROVAL_MISMATCH, no side effect",
         rep.get("refused") == "APPROVAL_MISMATCH" and not fleet.sends and not ld.mutations(), json.dumps(rep))
    fr_run.plan_run(run_dir, ctx, "%3", fr.DEFAULT_PROTECT, wave=3, busy_timeout_min=5)
    rep, rc = fr_run.apply_run(run_dir, ctx_for(fleet, home, agents, good_env, uid, aligned, preflight=(False, "selftest: FAIL (1 failing)")), approve(run_dir))
    case("NEG preflight selftest red -> PREFLIGHT_FAILED before save, zero sends, zero launchctl mutations",
         rep.get("refused") == "PREFLIGHT_FAILED" and not fleet.sends and not ld.mutations(), json.dumps(rep)[:200])

    rep, rc = fr_run.apply_run(run_dir, ctx, approve(run_dir))
    res = {p["pane"]: p for p in rep["panes"]}
    case("CTL runtime advisor lost by /restart -> exactly one `/advisor on`, badge back -> ADVISOR_RESTORED",
         res["w:0.1"].get("advisor") == "ADVISOR_RESTORED" and fleet.count("w:0.1", "/advisor on") == 1, json.dumps(res["w:0.1"]))
    case("NEG badge never returns -> ADVISOR_FAILED (one send) and run exit non-zero",
         res["w:0.5"].get("advisor") == "ADVISOR_FAILED" and fleet.count("w:0.5", "/advisor on") == 1 and rc == fr_run.EXIT_FAILED and "w:0.5" in rep["failed"],
         json.dumps(res["w:0.5"]))
    case("CTL advisor off before -> zero advisor sends (ADVISOR_OFF)",
         res["w:0.2"].get("advisor") == "ADVISOR_OFF" and fleet.count("w:0.2", "/advisor on") == 0, json.dumps(res["w:0.2"]))
    case("CTL config-sourced advisor showing the badge after restart -> zero sends (ADVISOR_KEPT)",
         res["w:0.3"].get("advisor") == "ADVISOR_KEPT" and fleet.count("w:0.3", "/advisor on") == 0, json.dumps(res["w:0.3"]))
    case("CTL flag-sourced advisor kept by /restart argv -> zero sends", res["w:0.4"].get("advisor") == "ADVISOR_KEPT" and fleet.count("w:0.4", "/advisor on") == 0)
    case("NEG bare `/advisor` (toggle) never sent; only /restart, /advisor on and respawn reach panes",
         fleet.count(text="/advisor") == 0 and {t for _, t, _ in fleet.sends} == {"/restart", "/advisor on", "RESPAWN"}, json.dumps(sorted({t for _, t, _ in fleet.sends})))
    case("CTL SESSION_KEPT + VERSION_OK: same session file and target exe after /restart (same pid)",
         res["w:0.1"].get("session") == "SESSION_KEPT" and res["w:0.1"]["version"] == "VERSION_OK" and res["w:0.1"]["result"] == "VERIFIED"
         and res["w:0.1"]["new_pid"] == 1011, json.dumps(res["w:0.1"]))
    case("CTL RESPAWN (Tern 18.9.2 pane): new pid, target exe, session kept, --advisor brought the runtime advisor back with zero /advisor sends",
         res["r:0.1"]["result"] == "VERIFIED" and res["r:0.1"]["mode"] == "RESPAWN" and res["r:0.1"]["new_pid"] != 2011 and res["r:0.1"]["version"] == "VERSION_OK"
         and res["r:0.1"]["session"] == "SESSION_KEPT" and res["r:0.1"]["advisor"] == "ADVISOR_KEPT" and fleet.count("r:0.1", "/restart") == 0
         and fleet.count("r:0.1", "/advisor on") == 0, json.dumps(res["r:0.1"]))
    case("CTL RESPAWN (bun pane) -> VERIFIED on the target build, no /restart sent", res["r:0.2"]["result"] == "VERIFIED" and fleet.count("r:0.2", "/restart") == 0
         and fleet.count("r:0.2", "RESPAWN") == 1, json.dumps(res["r:0.2"]))
    case("NEG HOLD_COMPOSER and HOLD_NO_SESSION panes: zero sends", fleet.count("r:0.4") == 0 and fleet.count("r:0.5") == 0
         and res["r:0.4"]["result"] == "HOLD_COMPOSER")
    md = open(os.path.join(run_dir, "report.md")).read()
    held_dir = os.path.join(root, "w", "var", "agent-tmp", "job.2061")
    case("NEG work-scratch owner is HOLD_SCRATCH_OWNER with zero respawn; scratch stays at original path/ownership/content and preserve still copies it; report names the dir",
         res["r:0.6"]["result"] == "HOLD_SCRATCH_OWNER" and fleet.count("r:0.6") == 0 and ("`%s`" % held_dir) in md
         and os.path.join(held_dir, "notes.txt") in md and fr_run.SCRATCH_ADVICE in md
         and "refuses the run" in fr_run.SCRATCH_ADVICE
         and open(os.path.join(held_dir, "notes.txt")).read() == "x" and open(os.path.join(held_dir, ".owner")).read() == "pid=2061\n"
         and os.path.isfile(os.path.join(run_dir, "preserve", "scratch", "r:0.6", "job.2061", "notes.txt")), md[-600:])
    case("CTL RESPAWN pane owning only its runtime omp.<pid> is not held (r:0.1 respawned)",
         res["r:0.1"]["result"] == "VERIFIED" and "omp.2011" not in md, json.dumps(res["r:0.1"]))
    case("NEG pane busy past --busy-timeout-min -> QUEUED_BUSY with zero sends",
         res["w:0.6"]["result"] == "QUEUED_BUSY" and fleet.count("w:0.6") == 0, json.dumps(res["w:0.6"]))
    g = [t for n, t2, t in fleet.sends if n == "w:0.7" and t2 == "/restart"]
    case("CTL busy pane restarted at its turn boundary (sent only after it went idle)",
         res["w:0.7"]["result"] == "VERIFIED" and len(g) == 1 and g[0] >= 1_000_000.0 + 90, json.dumps(g))
    case("NEG protected pane and chief untouched (zero sends); report carries the chief's respawn command",
         res["uds--burn-down:0.0"]["result"] == "SKIP_PROTECTED" and res["omp-test:0.1"]["result"] == "SKIP_CHIEF"
         and fleet.count("uds--burn-down:0.0") == 0 and fleet.count("omp-test:0.1") == 0 and rep["chief_respawn"]["argv"]
         and "omp-test:0.1" in open(os.path.join(run_dir, "report.md")).read())
    case("CTL watchers paused during the run and resumed after it; dead-man gone",
         [c[2] for c in ld.mutations() if c[1] == "bootout"][:1] == ["gui/%d/com.omp-kit.fleet-watch" % uid] and "com.omp-kit.fleet-watch" in ld.loaded
         and rep["watchers"]["resume"]["result"] == "RESUMED" and not [x for x in ld.loaded if x.startswith(fw.DEADMAN_PREFIX)], json.dumps(ld.mutations()))
    events = [json.loads(ln)["event"] for ln in open(os.path.join(run_dir, fr_run.LEDGER))]
    events = events[len(events) - events[::-1].index("RUN_START") - 1:]  # the applied attempt; an earlier one was preflight-refused
    case("CTL ledger order: SAVE < WATCHERS_PAUSE < SENT < WATCHERS_RESUME < RUN_END, no SCRATCH_REAP; report.json + report.md written",
         events.index("SAVE") < events.index("WATCHERS_PAUSE") < events.index("SENT") < events.index("WATCHERS_RESUME") < events.index("RUN_END")
         and "SCRATCH_REAP" not in events
         and os.path.isfile(os.path.join(run_dir, "report.md")) and os.path.isfile(os.path.join(run_dir, "report.json")), json.dumps(events[:12]))
    case("NEG no global scratch/reaper effects after the sends: zero `scratch apply` calls",
         fleet.scratch_applies == 0, json.dumps(fleet.scratch_applies))
    case("CTL canary first: the first send is the RESPAWN pane r:0.1, verified (CANARY event) before any other send; non-strict ADVISOR_FAILED (w:0.5) trips no breaker",
         fleet.sends[0][:2] == ("r:0.1", "RESPAWN") and events.index("CANARY") < [i for i, e in enumerate(events) if e == "SENT"][1]
         and rep["breaker"] is None and res["w:0.5"].get("advisor") == "ADVISOR_FAILED", json.dumps([fleet.sends[:2], rep["breaker"]]))

    restarts = fleet.count(text="/restart") + fleet.count(text="RESPAWN")
    rep2, rc2 = fr_run.apply_run(run_dir, ctx, approve(run_dir))
    case("NEG second --apply on an applied run refused (RUN_ALREADY_APPLIED), no sends",
         rep2.get("refused", "").startswith("RUN_ALREADY_APPLIED") and fleet.count(text="/restart") + fleet.count(text="RESPAWN") == restarts, json.dumps(rep2))
    rep2, rc2 = fr_run.apply_run(run_dir, ctx, approve(run_dir), resume_run=True)
    res2 = {p["pane"]: p for p in rep2["panes"]}
    case("NEG --resume-run sends no second /restart or respawn to a VERIFIED pane",
         fleet.count("w:0.1", "/restart") == 1 and fleet.count("w:0.7", "/restart") == 1 and fleet.count("r:0.1", "RESPAWN") == 1 and res2["w:0.1"].get("from_ledger")
         and fleet.count(text="/restart") + fleet.count(text="RESPAWN") == restarts and fleet.count("w:0.1", "/advisor on") == 1, json.dumps(res2.get("w:0.1")))
    rep3, rc3 = fr_run.apply_run(run_dir, ctx, approve(run_dir, continue_after_breaker=True), resume_run=True, continue_after_breaker=True)
    case("NEG --continue-after-breaker on a run with no breaker -> NO_BREAKER_TO_CONTINUE, no sends",
         rep3.get("refused") == "NO_BREAKER_TO_CONTINUE" and fleet.count(text="/restart") + fleet.count(text="RESPAWN") == restarts, json.dumps(rep3))
    for label, only, want in [("two named panes", ["w:0.2", "%104"], ["w:0.2", "w:0.4"]), ("unknown pane", ["nope:9.9"], None)]:
        mo = fr_run.plan_run(os.path.join(root, "only-" + label.replace(" ", "-")), ctx, "%3", fr.DEFAULT_PROTECT, only=only)
        got = sorted(r["pane"] for r in mo["rows"])
        ok = got == want and not mo["refused"] if want else any(x.startswith("ONLY_NOT_IN_PLAN:nope:9.9") for x in mo["refused"])
        case("%s --only %s -> %s" % ("CTL" if want else "NEG", label, "manifest rows limited to them" if want else "plan refused ONLY_NOT_IN_PLAN"),
             ok, json.dumps([got, mo["refused"]]))

    gate_breaker(case, root, home, agents, good_env, uid, aligned)
    gate_revalidate(case, root, home, agents, good_env, uid, aligned)
    gate_model(case, root, home, agents, good_env, uid, aligned)
    gate_session_fork(case, root, home, agents, good_env, uid, aligned)

    cwd = os.path.join(root, "w")
    ld3 = FakeLaunchd(loaded={"com.omp-kit.fleet-watch"})
    fl3 = FakeFleet([Pane("uds--burn-down:0.0", "%31", 31, cwd)], ld3)
    ctx3 = ctx_for(fl3, home, agents, good_env, uid, aligned)
    rd = os.path.join(root, "r3")
    m3 = fr_run.plan_run(rd, ctx3, "%3", fr.DEFAULT_PROTECT, unprotect=["uds--burn-down:0.0"])
    rep, rc = fr_run.apply_run(rd, ctx3, approve(rd), unprotect=["uds--burn-down:0.0"])
    case("NEG --unprotect without the approval naming it -> UNPROTECT_NOT_APPROVED, zero sends",
         m3["rows"][0]["action"] == "RESTART" and rep.get("refused") == "UNPROTECT_NOT_APPROVED" and not fl3.sends, json.dumps(rep))
    rep, rc = fr_run.apply_run(rd, ctx3, approve(rd, unprotect=["uds--burn-down:0.0"]), unprotect=[])
    case("NEG approval names the pane but --unprotect missing at apply -> UNPROTECT_NOT_IN_MANIFEST", rep.get("refused") == "UNPROTECT_NOT_IN_MANIFEST", json.dumps(rep))
    rep, rc = fr_run.apply_run(rd, ctx3, approve(rd, unprotect=["uds--burn-down:0.0"]), unprotect=["uds--burn-down:0.0"])
    case("CTL DEFAULT_PROTECT pane restarted only with --unprotect + approval", rc == 0 and rep["panes"][0]["result"] == "VERIFIED" and fl3.count(text="/restart") == 1,
         json.dumps(rep["panes"]))
    m0 = fr_run.plan_run(os.path.join(root, "r3b"), ctx3, "", fr.DEFAULT_PROTECT)
    case("NEG run --plan without a chief pane -> refused CHIEF_UNKNOWN", "CHIEF_UNKNOWN" in m0["refused"], json.dumps(m0["refused"]))

    ld4 = FakeLaunchd(loaded={"com.omp-kit.fleet-watch"})
    fl4 = FakeFleet([Pane("w:0.1", "%101", 101, cwd)], ld4)
    fl4.boom = {"w:0.1"}
    ctx4 = ctx_for(fl4, home, agents, good_env, uid, aligned)
    rd = os.path.join(root, "r4")
    fr_run.plan_run(rd, ctx4, "%3", fr.DEFAULT_PROTECT)
    rep, rc = fr_run.apply_run(rd, ctx4, approve(rd))
    ev = [json.loads(ln)["event"] for ln in open(os.path.join(rd, fr_run.LEDGER))]
    case("NEG restart step raises -> watchers still resumed in finally, dead-man removed, exit non-zero",
         rc == fr_run.EXIT_FAILED and "simulated ntm crash" in (rep["error"] or "") and "com.omp-kit.fleet-watch" in ld4.loaded
         and not [x for x in ld4.loaded if x.startswith(fw.DEADMAN_PREFIX)] and ev.index("ERROR") < ev.index("WATCHERS_RESUME"), json.dumps(ev))

    for kind, drop, label, want, want_result in [
            ("target", True, "/restart sent but no re-exec observed -> HOLD_AMBIGUOUS_SEND, never retried", 1, "HOLD_AMBIGUOUS_SEND"),
            ("target", False, "/restart re-exec visible -> no resend, verified from the live process", 1, "VERIFIED"),
            ("tern", True, "respawn sent but pane still on the old omp pid -> HOLD_AMBIGUOUS_SEND, never re-respawned", 1, "HOLD_AMBIGUOUS_SEND"),
            ("tern", False, "respawn took effect (new pid) -> no second respawn, straight to VERIFY", 1, "VERIFIED")]:
        ld5 = FakeLaunchd(loaded={"com.omp-kit.fleet-watch"})
        p5 = Pane("w:0.1", "%101", 101, cwd, drop_restart=drop, kind=kind)
        fl5 = FakeFleet([p5], ld5)
        ctx5 = ctx_for(fl5, home, agents, good_env, uid, aligned)
        rd = os.path.join(root, "r5-%s-%s" % (kind, drop))
        fr_run.plan_run(rd, ctx5, "%3", fr.DEFAULT_PROTECT, wave=1)
        fl5.crash_sleep = True
        fr_run.apply_run(rd, ctx5, approve(rd))
        p5.drop_restart = False
        rep, rc = fr_run.apply_run(rd, ctx5, approve(rd), resume_run=True)
        ev = [json.loads(ln)["event"] for ln in open(os.path.join(rd, fr_run.LEDGER))]
        sends = fl5.count(text="/restart") + fl5.count(text="RESPAWN")
        case("CTL --resume-run after a crash: %s" % label,
             sends == want and rep["panes"][0]["result"] == want_result and "SEND_LOST" not in ev
             and (("SEND_AMBIGUOUS" in ev) == drop) and rc == 0,
             "sends=%d %s" % (sends, json.dumps(rep["panes"])))

    # NEG crash after actual native receipt but before the SENT ledger: the
    # fsynced SEND_INTENT plus the observed native effect reconcile to exactly
    # one send across the resume (re-verify, never re-send).
    ld5b = FakeLaunchd(loaded={"com.omp-kit.fleet-watch"})
    p5b = Pane("w:0.1", "%101", 101, cwd, kind="target")
    fl5b = FakeFleet([p5b], ld5b)
    ctx5b = ctx_for(fl5b, home, agents, good_env, uid, aligned)
    rd = os.path.join(root, "r5-intent-crash")
    fr_run.plan_run(rd, ctx5b, "%3", fr.DEFAULT_PROTECT, wave=1)
    restore = crash_on("SENT")
    try:
        rep0, rc0 = fr_run.apply_run(rd, ctx5b, approve(rd))
    finally:
        restore()
    ev = [json.loads(ln) for ln in open(os.path.join(rd, fr_run.LEDGER))]
    intents = [e for e in ev if e["event"] == "SEND_INTENT"]
    case("NEG crash between native receipt and SENT ledger leaves the durable intent with zero SENT rows",
         "simulated crash before SENT" in (rep0.get("error") or "") and len(intents) == 1 and not [e for e in ev if e["event"] == "SENT"]
         and fl5b.count(text="/restart") == 1 and intents[0].get("intent_id", "").endswith("|%101|RESTART"),
         json.dumps({"error": rep0.get("error"), "intents": intents, "sends": fl5b.count(text="/restart")}))
    rep, rc = fr_run.apply_run(rd, ctx5b, approve(rd), resume_run=True)
    n = fl5b.count(text="/restart")
    rep2, rc2 = fr_run.apply_run(rd, ctx5b, approve(rd), resume_run=True)
    case("NEG resume reconciles the dangling intent against the native effect: VERIFIED with one send across two resumes",
         rep["panes"][0]["result"] == "VERIFIED" and n == 1 and fl5b.count(text="/restart") == 1
         and rep2["panes"][0].get("from_ledger") and rc == 0 and rc2 == 0,
         json.dumps({"first": rep["panes"], "second": rep2["panes"], "sends": fl5b.count(text="/restart")}))

    # NEG delayed consume: SENT is on the ledger but the effect is not observable
    # at resume time. Absent effect is not proof of non-delivery, so the resume
    # holds explicitly instead of resending; the hold is terminal across resumes.
    ld5c = FakeLaunchd(loaded={"com.omp-kit.fleet-watch"})
    p5c = Pane("w:0.1", "%101", 101, cwd, drop_restart=True, kind="target")
    fl5c = FakeFleet([p5c], ld5c)
    ctx5c = ctx_for(fl5c, home, agents, good_env, uid, aligned)
    rd = os.path.join(root, "r5-delayed-consume")
    fr_run.plan_run(rd, ctx5c, "%3", fr.DEFAULT_PROTECT, wave=1)
    restore = crash_on("VERIFY")
    try:
        fr_run.apply_run(rd, ctx5c, approve(rd))
    finally:
        restore()
    p5c.drop_restart = False  # the consume lands late: still nothing observable at resume inventory
    rep, rc = fr_run.apply_run(rd, ctx5c, approve(rd), resume_run=True)
    ev = [json.loads(ln)["event"] for ln in open(os.path.join(rd, fr_run.LEDGER))]
    rep2, rc2 = fr_run.apply_run(rd, ctx5c, approve(rd), resume_run=True)
    case("NEG delayed consume (SENT, no VERIFY, no effect) -> HOLD_AMBIGUOUS_SEND with one send across two resumes, never SEND_LOST",
         rep["panes"][0]["result"] == "HOLD_AMBIGUOUS_SEND" and fl5c.count(text="/restart") == 1
         and "SEND_LOST" not in ev and "SEND_AMBIGUOUS" in ev
         and rep2["panes"][0]["result"] == "HOLD_AMBIGUOUS_SEND" and rep2["panes"][0].get("from_ledger")
         and fl5c.count(text="/restart") == 1,
         json.dumps({"first": rep["panes"], "second": rep2["panes"], "sends": fl5c.count(text="/restart")}))

    gate_verdict_resume(case, root, home, agents, good_env, uid, aligned)

    ld6 = FakeLaunchd(loaded={"com.omp-kit.fleet-watch", "com.example.sender"})
    fl6 = FakeFleet([Pane("w:0.1", "%101", 101, cwd)], ld6)
    agents6 = agents_fixture(os.path.join(root, "a6"), extra=True)
    ctx6 = ctx_for(fl6, home, agents6, good_env, uid, aligned)
    rd = os.path.join(root, "r6")
    m6 = fr_run.plan_run(rd, ctx6, "%3", fr.DEFAULT_PROTECT)
    rep, rc = fr_run.apply_run(rd, ctx6, approve(rd))
    case("NEG unclassified pane-actor watcher -> plan refused HOLD_UNCLASSIFIED and run --apply refuses, no side effect",
         "HOLD_UNCLASSIFIED" in m6["refused"] and str(rep.get("refused", "")).startswith("MANIFEST_REFUSED") and not fl6.sends and not ld6.mutations(),
         json.dumps(rep))

    mini = {"kind": "keys", "rows": [{"pane": "w:0.1", "pane_id": "%101", "session": "w", "flags": [], "kind": "keys", "text": "/advisor"}]}
    calls = []
    res = fr.send(mini, True, dict(APPROVE, manifest_sha256=fr.manifest_sha(mini)), good_env, uid, lambda pid: screen_of(),
                  lambda argv, env: (calls.append(argv), (0, ""))[1])
    try:
        fr_run.gated(ctx, fr_run.keys_row({"pane": "w:0.1", "pane_id": "%101", "session": "w", "flags": []}, "/advisor"), APPROVE)
        raised = False
    except ValueError:
        raised = True
    case("NEG manifest row carrying bare `/advisor` refused at send (REFUSED_KEYS_NOT_ALLOWED); run send path raises",
         res["rows"][0]["result"] == "REFUSED_KEYS_NOT_ALLOWED" and not calls and raised, json.dumps(res["rows"]))


# ---------- ompkit-rhy9.5: one approval bound to exact indirect inputs ----------

def gate_approval_binding(case, tmp, uid, good_env, aligned):
    root = os.path.join(tmp, "bindroot")
    home = fake_home(root)
    agents = agents_fixture(root)

    def cwd(name):
        d = os.path.join(root, "bind", name)
        os.makedirs(d, exist_ok=True)
        return d

    def ledger_events(rd):
        with open(os.path.join(rd, fr_run.LEDGER)) as fh:
            return [json.loads(ln) for ln in fh if ln.strip()]

    # CTL positive: one exact approval executes the admitted effects; the operator's
    # verbatim words stay on the RUN_START record with the save/preserve digests.
    fl, ctx, rd, man = small_run(root, "bind-pos", [Pane("b:0.1", "%601", 601, cwd("pos"))], home, agents, good_env, uid, aligned, wave=1)
    case("CTL plan binds target bytes, snapshot digest and per-pane action/mode/custody",
         man["target"].get("bytes_sha256") == TARGET_INFO["bytes_sha256"] and man.get("snapshot_sha256") == fr_run.dir_digest(man["snapshot_dir"])
         and man["rows"][0]["action"] == "RESTART" and man["rows"][0]["mode"] == "RESTART" and man["rows"][0].get("session_file"),
         json.dumps({k: man["target"].get(k) for k in ("path", "bytes_sha256")}))
    rep, rc = fr_run.apply_run(rd, ctx, approve(rd))
    res = {p["pane"]: p for p in rep["panes"]}
    ev = ledger_events(rd)
    start = next(e for e in ev if e["event"] == "RUN_START")
    case("CTL one exact approval executes admitted preflight/save/preserve/restart effects, operator words retained verbatim",
         rc == 0 and res["b:0.1"]["result"] == "VERIFIED" and fl.count("b:0.1", "/restart") == 1
         and start.get("quote") == "go" and start.get("approved_by") == "selftest"
         and any(e["event"] == "SAVE" and e.get("save_sha256") for e in ev)
         and any(e["event"] == "PRESERVE" and e.get("preserve_sha256") for e in ev)
         and res["b:0.1"].get("session") == "SESSION_KEPT" and res["b:0.1"].get("version") == "VERSION_OK",
         json.dumps([rc, res["b:0.1"].get("result"), start.get("quote")]))
    # CTL: an unrelated fresh run with its own exact approval is still permitted.
    fl0, ctx0, rd0, _ = small_run(root, "bind-pos2", [Pane("b:0.0", "%600", 600, cwd("pos2"))], home, agents, good_env, uid, aligned, wave=1)
    rep0, rc0 = fr_run.apply_run(rd0, ctx0, approve(rd0))
    case("CTL unrelated legitimate run with its own exact approval still permitted",
         rc0 == 0 and rep0["panes"][0]["result"] == "VERIFIED" and fl0.count("b:0.0", "/restart") == 1,
         json.dumps([rc0, rep0["panes"][0].get("result")]))

    # NEG: same path, different executable bytes -> refuse before any effect.
    fl2, ctx2, rd2, _ = small_run(root, "bind-bytes", [Pane("b:0.2", "%602", 602, cwd("bytes"))], home, agents, good_env, uid, aligned, wave=1)
    ap2 = approve(rd2)
    ctx2.target_fn = lambda: dict(TARGET_INFO, bytes_sha256="0" * 64)
    rep, rc = fr_run.apply_run(rd2, ctx2, ap2)
    case("NEG executable bytes changed at the same path -> APPROVAL_TARGET_DRIFT, zero sends, zero launchctl mutations",
         rc == fr_run.EXIT_REFUSED and str(rep.get("refused", "")).startswith("APPROVAL_TARGET_DRIFT")
         and not fl2.sends and not fl2.ld.mutations(), json.dumps(rep))
    # NEG: approval predating the bytes binding (no bytes in manifest) -> refuse, re-plan.
    path2 = os.path.join(rd2, fr_run.RUN_MANIFEST)
    with open(path2) as fh:
        nob = json.load(fh)
    nob["target"] = {k: v for k, v in nob["target"].items() if k != "bytes_sha256"}
    nob["manifest_sha256"] = fr.manifest_sha(nob)  # legacy plan output: valid sha over a body with no bytes binding
    fw.write_json(path2, nob)
    rep, rc = fr_run.apply_run(rd2, ctx_for(fl2, home, agents, good_env, uid, aligned), approve(rd2))
    case("NEG manifest without bound target bytes -> TARGET_BYTES_UNBOUND, zero sends, zero launchctl mutations",
         rc == fr_run.EXIT_REFUSED and str(rep.get("refused", "")).startswith("TARGET_BYTES_UNBOUND")
         and not fl2.sends and not fl2.ld.mutations(), json.dumps(rep))

    # NEG: stage-1 snapshot mutated after approval -> refuse before any effect.
    fl3, ctx3, rd3, _ = small_run(root, "bind-snap", [Pane("b:0.3", "%603", 603, cwd("snap"))], home, agents, good_env, uid, aligned, wave=1)
    with open(os.path.join(rd3, "snapshot", "evil.json"), "w") as fh:
        fh.write("{}")
    rep, rc = fr_run.apply_run(rd3, ctx3, approve(rd3))
    case("NEG stage-1 snapshot mutated after approval -> APPROVAL_SNAPSHOT_DRIFT, zero sends, zero launchctl mutations",
         rc == fr_run.EXIT_REFUSED and str(rep.get("refused", "")).startswith("APPROVAL_SNAPSHOT_DRIFT")
         and not fl3.sends and not fl3.ld.mutations(), json.dumps(rep))

    # NEG: save.json mutated between runs -> resume refuses before any new effect.
    fl4, ctx4, rd4, _ = small_run(root, "bind-save", [Pane("b:0.4", "%604", 604, cwd("save"))], home, agents, good_env, uid, aligned, wave=1)
    rep, rc = fr_run.apply_run(rd4, ctx4, approve(rd4))
    assert rc == 0, json.dumps(rep)
    n4 = len(fl4.sends)
    sp = os.path.join(rd4, "save.json")
    with open(sp) as fh:
        sj = json.load(fh)
    sj["rows"][0]["omp_pid"] = 12345
    fw.write_json(sp, sj)
    rep, rc = fr_run.apply_run(rd4, ctx4, approve(rd4), resume_run=True)
    case("NEG save.json mutated after its SAVE entry -> SAVE_DRIFT on resume, zero new sends",
         rc == fr_run.EXIT_REFUSED and str(rep.get("refused", "")).startswith("SAVE_DRIFT") and len(fl4.sends) == n4,
         json.dumps(rep))

    # NEG: preserve/manifest.json mutated between runs -> resume refuses before any new effect.
    fl5, ctx5, rd5, _ = small_run(root, "bind-pres", [Pane("b:0.5", "%605", 605, cwd("pres"))], home, agents, good_env, uid, aligned, wave=1)
    rep, rc = fr_run.apply_run(rd5, ctx5, approve(rd5))
    assert rc == 0, json.dumps(rep)
    n5 = len(fl5.sends)
    mp = os.path.join(rd5, "preserve", "manifest.json")
    with open(mp) as fh:
        pm = json.load(fh)
    pm["evil"] = True
    fw.write_json(mp, pm)
    rep, rc = fr_run.apply_run(rd5, ctx5, approve(rd5), resume_run=True)
    case("NEG preserve/manifest.json mutated after its PRESERVE entry -> PRESERVE_DRIFT on resume, zero new sends",
         rc == fr_run.EXIT_REFUSED and str(rep.get("refused", "")).startswith("PRESERVE_DRIFT") and len(fl5.sends) == n5,
         json.dumps(rep))

    # NEG: launch --model / --profile changed between save and send -> hold, zero sends.
    t_idle = 1_000_000.0 + 90

    def swap_model(p):
        p.flags += " --model GPT-9"

    def swap_profile(p):
        p.flags = p.flags.replace("--profile claude", "--profile dotp")
    panes = [Pane("b:0.6", "%606", 606, cwd("model"), kind="tern", busy_until=t_idle, on_idle=swap_model),
             Pane("b:0.7", "%607", 607, cwd("profile"), kind="tern", busy_until=t_idle, on_idle=swap_profile)]
    fl6, ctx6, rd6, _ = small_run(root, "bind-flags", panes, home, agents, good_env, uid, aligned, wave=4, busy_timeout_min=5)
    rep, rc = fr_run.apply_run(rd6, ctx6, approve(rd6))
    res = {p["pane"]: p for p in rep["panes"]}
    case("NEG launch --model changed between save and send -> HOLD_MODEL_CHANGED, zero sends",
         res["b:0.6"]["result"] == "HOLD_MODEL_CHANGED" and fl6.count("b:0.6") == 0, json.dumps(res["b:0.6"]))
    case("NEG launch --profile changed between save and send -> HOLD_PROFILE_CHANGED, zero sends",
         res["b:0.7"]["result"] == "HOLD_PROFILE_CHANGED" and fl6.count("b:0.7") == 0, json.dumps(res["b:0.7"]))


# ---------- canary + circuit breaker ----------

def small_run(root, name, panes, home, agents, good_env, uid, aligned, **plan_kw):
    fl = FakeFleet(panes, FakeLaunchd(loaded={"com.omp-kit.fleet-watch"}))
    ctx = ctx_for(fl, home, agents, good_env, uid, aligned)
    rd = os.path.join(root, name)
    man = fr_run.plan_run(rd, ctx, "%3", fr.DEFAULT_PROTECT, **plan_kw)
    return fl, ctx, rd, man


def watchers_back(fl):
    return "com.omp-kit.fleet-watch" in fl.ld.loaded and not [x for x in fl.ld.loaded if x.startswith(fw.DEADMAN_PREFIX)]


def gate_breaker(case, root, home, agents, good_env, uid, aligned):
    def cwd(name):
        d = os.path.join(root, name)
        os.makedirs(d, exist_ok=True)
        return d

    # canary fails (RESPAWN preferred even though listed second) -> nothing else is sent
    c = cwd("cf")
    fl, ctx, rd, _ = small_run(root, "b-canary", [Pane("w:0.1", "%101", 101, c), Pane("r:0.3", "%203", 203, c, kind="tern", stale=True),
                                                   Pane("w:0.2", "%102", 102, c)], home, agents, good_env, uid, aligned)
    rep, rc = fr_run.apply_run(rd, ctx, approve(rd))
    res = {p["pane"]: p for p in rep["panes"]}
    md = open(os.path.join(rd, "report.md")).read()
    case("NEG canary fails (r:0.3 VERSION_STALE) -> zero further sends, others HOLD_BREAKER, watchers resumed, report BREAKER line, exit 6",
         [s[:2] for s in fl.sends] == [("r:0.3", "RESPAWN")] and res["w:0.1"]["result"] == res["w:0.2"]["result"] == "HOLD_BREAKER"
         and watchers_back(fl) and "BREAKER: r:0.3 VERSION_STALE (canary)" in md and rc == fr_run.EXIT_FAILED, json.dumps([fl.sends, rep["breaker"]]))
    c = cwd("ca")
    fl, ctx, rd, _ = small_run(root, "b-canary-adv", [Pane("w:0.5", "%105", 105, c, advisor="runtime", badge_ok=False), Pane("w:0.2", "%102", 102, c)],
                               home, agents, good_env, uid, aligned)
    rep, rc = fr_run.apply_run(rd, ctx, approve(rd))
    case("NEG canary whose advisor does not come back -> breaker even without --strict-advisor; the next pane gets zero sends",
         rep["breaker"] == {"pane": "w:0.5", "verdict": "ADVISOR_FAILED", "canary": True} and fl.count("w:0.2") == 0 and rc == fr_run.EXIT_FAILED,
         json.dumps(rep["breaker"]))

    # canary passes; a mid-run failure trips the breaker; in-flight panes of that wave still verify
    c = cwd("mid")
    panes = [Pane("r:0.7", "%207", 207, c, kind="tern"), Pane("w:0.8", "%108", 108, c, lose_session=True),
             Pane("r:0.3", "%203", 203, c, kind="tern", stale=True), Pane("w:0.9", "%109", 109, c), Pane("w:0.10", "%110", 110, c)]
    fl, ctx, rd, _ = small_run(root, "b-mid", panes, home, agents, good_env, uid, aligned, wave=3)
    rep, rc = fr_run.apply_run(rd, ctx, approve(rd))
    res = {p["pane"]: p for p in rep["panes"]}
    md = open(os.path.join(rd, "report.md")).read()
    case("NEG different session file after /restart -> SESSION_LOST (failure)", res["w:0.8"]["result"] == "SESSION_LOST" and "w:0.8" in rep["failed"], json.dumps(res["w:0.8"]))
    case("NEG respawned pane still on the old build -> VERSION_STALE (failure, exit non-zero)",
         res["r:0.3"]["result"] == "VERSION_STALE" and "r:0.3" in rep["failed"] and rc == fr_run.EXIT_FAILED, json.dumps(res["r:0.3"]))
    case("CTL failed /restart panes get a respawn fallback command from save.json",
         any(f["pane"] == "w:0.8" and f["argv"] and "--resume" in f["argv"][-1] for f in rep["respawn_fallback"]), json.dumps(rep["respawn_fallback"]))
    case("NEG mid-run SESSION_LOST trips the breaker: canary r:0.7 VERIFIED first, in-flight r:0.3/w:0.9 still verified, next wave HOLD_BREAKER, zero sends, watchers back",
         res["r:0.7"]["result"] == "VERIFIED" and fl.sends[0][:2] == ("r:0.7", "RESPAWN") and res["w:0.9"]["result"] == "VERIFIED"
         and res["w:0.10"]["result"] == "HOLD_BREAKER" and fl.count("w:0.10") == 0 and "BREAKER: w:0.8 SESSION_LOST" in md and watchers_back(fl),
         json.dumps([rep["breaker"], {k: v["result"] for k, v in res.items()}]))
    case("NEG after a planted breaker trip there are zero global scratch/reaper effects: no SCRATCH_REAP ledger event, zero `scratch apply` calls",
         "SCRATCH_REAP" not in [json.loads(ln)["event"] for ln in open(os.path.join(rd, fr_run.LEDGER))] and fl.scratch_applies == 0,
         json.dumps(fl.scratch_applies))
    n = len(fl.sends)
    rep, rc = fr_run.apply_run(rd, ctx, approve(rd), resume_run=True)
    res = {p["pane"]: p for p in rep["panes"]}
    case("NEG --resume-run after a breaker stop, no --continue-after-breaker -> zero sends, HOLD_BREAKER kept, exit 6",
         len(fl.sends) == n and res["w:0.10"]["result"] == "HOLD_BREAKER" and rep["breaker"]["pane"] == "w:0.8" and rc == fr_run.EXIT_FAILED,
         json.dumps([rep["breaker"], res["w:0.10"]]))
    with open(os.path.join(rd, fr_run.LEDGER), "a") as fh:  # a crash right after a send: SENT, no VERIFY, no effect on the pane
        fh.write(json.dumps({"at": "x", "event": "SENT", "pane": "w:0.10", "mode": "RESTART"}) + "\n")
    rep, rc = fr_run.apply_run(rd, ctx, approve(rd), resume_run=True)
    case("NEG after a breaker stop a SENT-without-VERIFY pane is not retried (no SEND_LOST resend) -> HOLD_BREAKER, zero sends",
         len(fl.sends) == n and {p["pane"]: p for p in rep["panes"]}["w:0.10"]["result"] == "HOLD_BREAKER" and rc == fr_run.EXIT_FAILED,
         json.dumps([p for p in rep["panes"] if p["pane"] == "w:0.10"]))
    rep, rc = fr_run.apply_run(rd, ctx, approve(rd), resume_run=True, continue_after_breaker=True)
    case("NEG --continue-after-breaker without continue_after_breaker: true in the approval -> CONTINUE_NOT_APPROVED, no sends",
         str(rep.get("refused", "")).startswith("CONTINUE_NOT_APPROVED") and len(fl.sends) == n, json.dumps(rep))
    rep, rc = fr_run.apply_run(rd, ctx, approve(rd, continue_after_breaker=True), continue_after_breaker=True)
    case("NEG --continue-after-breaker without --resume-run -> refused", rep.get("refused") in ("CONTINUE_NEEDS_RESUME_RUN", "RUN_ALREADY_APPLIED: continue with --resume-run")
         and len(fl.sends) == n, json.dumps(rep))
    rep, rc = fr_run.apply_run(rd, ctx, approve(rd, continue_after_breaker=True), resume_run=True, continue_after_breaker=True)
    res = {p["pane"]: p for p in rep["panes"]}
    case("CTL approved --continue-after-breaker: the HOLD_BREAKER pane is sent and VERIFIED; failures stay failures and are not re-sent; exit 6",
         res["w:0.10"]["result"] == "VERIFIED" and fl.count("w:0.10") == 1 and fl.count("w:0.8") == 1 and fl.count("r:0.3") == 1
         and res["w:0.8"]["result"] == "SESSION_LOST" and rep["breaker"] is None and rc == fr_run.EXIT_FAILED, json.dumps([res["w:0.10"], rep["breaker"]]))

    # --strict-advisor: a mid-run ADVISOR_FAILED trips too; plan-bound, apply may not change it
    c = cwd("strict")
    panes = [Pane("r:0.7", "%207", 207, c, kind="tern"), Pane("w:0.5", "%105", 105, c, advisor="runtime", badge_ok=False),
             Pane("w:0.2", "%102", 102, c), Pane("w:0.9", "%109", 109, c)]
    fl, ctx, rd, man = small_run(root, "b-strict", panes, home, agents, good_env, uid, aligned, wave=2, strict_advisor=True)
    for label, kw, want in [("--strict-advisor dropped at apply", {"strict_advisor": False}, "STRICT_ADVISOR_NOT_IN_MANIFEST"),
                            ("--canary 2 at apply, 1 planned", {"canary": 2}, "CANARY_NOT_IN_MANIFEST")]:
        rep, rc = fr_run.apply_run(rd, ctx, approve(rd), **kw)
        case("NEG %s -> %s, no side effect" % (label, want), rep.get("refused") == want and not fl.sends and not fl.ld.mutations(), json.dumps(rep))
    rep, rc = fr_run.apply_run(rd, ctx, approve(rd), strict_advisor=True)
    res = {p["pane"]: p for p in rep["panes"]}
    case("NEG --strict-advisor: mid-run ADVISOR_FAILED trips the breaker; in-flight w:0.2 verified, next wave HOLD_BREAKER",
         rep["breaker"] == {"pane": "w:0.5", "verdict": "ADVISOR_FAILED", "canary": False} and res["w:0.2"]["result"] == "VERIFIED"
         and res["w:0.9"]["result"] == "HOLD_BREAKER" and fl.count("w:0.9") == 0 and rc == fr_run.EXIT_FAILED, json.dumps(rep["breaker"]))


def gate_revalidate(case, root, home, agents, good_env, uid, aligned):
    c = os.path.join(root, "rv")
    os.makedirs(c, exist_ok=True)
    t_idle = 1_000_000.0 + 90

    def make_scratch(p):
        d = os.path.join(p.cwd, "var", "agent-tmp", "job.%d" % p.omp)
        os.makedirs(d, exist_ok=True)
        for f, text in [(".owner", "pid=%d\n" % p.omp), ("draft.md", "unpushed")]:
            with open(os.path.join(d, f), "w") as fh:
                fh.write(text)

    def new_pid(p):
        p.omp = 99991

    def new_session(p):
        p.session = p.session.replace(".jsonl", "-forked.jsonl")
    panes = [Pane("v:0.1", "%301", 301, c, kind="tern", busy_until=t_idle, on_idle=make_scratch),
             Pane("v:0.2", "%302", 302, c, kind="tern", busy_until=t_idle, on_idle=new_pid),
             Pane("v:0.3", "%303", 303, c, kind="tern", busy_until=t_idle, on_idle=new_session),
             Pane("v:0.4", "%304", 304, c, kind="tern", busy_until=t_idle)]
    fl, ctx, rd, man = small_run(root, "rv-run", panes, home, agents, good_env, uid, aligned, wave=4, busy_timeout_min=5)
    rep, rc = fr_run.apply_run(rd, ctx, approve(rd))
    res = {p["pane"]: p for p in rep["panes"]}
    md = open(os.path.join(rd, "report.md")).read()
    case("NEG busy pane that created work scratch during the wait is held at send time -> HOLD_SCRATCH_OWNER, zero sends",
         res["v:0.1"]["result"] == "HOLD_SCRATCH_OWNER" and fl.count("v:0.1") == 0,
         json.dumps(res["v:0.1"]))
    case("NEG omp pid changed between save and send (run path) -> HELD_DRIFT, zero sends",
         res["v:0.2"]["result"] == "HELD_DRIFT" and fl.count("v:0.2") == 0, json.dumps(res["v:0.2"]))
    case("NEG session file changed between save and send (run path) -> HOLD_SESSION_CHANGED, zero sends",
         res["v:0.3"]["result"] == "HOLD_SESSION_CHANGED" and fl.count("v:0.3") == 0, json.dumps(res["v:0.3"]))
    case("CTL busy pane unchanged at its turn boundary passes revalidation -> respawned and VERIFIED",
         res["v:0.4"]["result"] == "VERIFIED" and fl.count("v:0.4", "RESPAWN") == 1 and rep["breaker"] is None, json.dumps(res["v:0.4"]))

    # manual `send` path: the same live checks; never respawn from a stale save.json row
    for label, mutate, want, sends in [("omp pid changed", new_pid, "HELD_DRIFT", 0), ("session file changed", new_session, "HOLD_SESSION_CHANGED", 0),
                                       ("work scratch created", make_scratch, "HOLD_SCRATCH_OWNER", 0), ("nothing changed", None, "SENT", 1)]:
        d = os.path.join(root, "rvm-" + label.replace(" ", "-"))
        os.makedirs(d, exist_ok=True)
        p = Pane("m:0.1", "%401", 401, d, kind="tern")
        fl2, ctx2, rd2, _ = small_run(root, "rvm-run-" + label.replace(" ", "-"), [p], home, agents, good_env, uid, aligned)
        man2 = fr.restart_manifest(json.load(open(os.path.join(rd2, "plan.json"))), mode="respawn", save=json.load(open(os.path.join(rd2, "save.json"))))
        if mutate:
            mutate(p)
        res2 = fr.send(man2, True, dict(APPROVE, manifest_sha256=fr.manifest_sha(man2)), good_env, uid, fl2.capture, fl2.run,
                       revalidate_fn=fr_save.respawn_revalidator(fl2.inventory, fl2.lsof))
        got = res2["rows"][0]["result"] if res2["rows"] else "NO_ROW"
        case("%s manual respawn send, %s since save.json -> %s%s" % ("NEG" if sends == 0 else "CTL", label, want, ", zero sends" if sends == 0 else ""),
             got == want and fl2.count("m:0.1") == sends, json.dumps(res2["rows"]))


def gate_model(case, root, home, agents, good_env, uid, aligned):
    c = os.path.join(root, "model")
    os.makedirs(c, exist_ok=True)
    panes = [Pane("m:0.1", "%501", 501, c, model="GPT-6-Luna", launch_model="Muse Spark 1.3"), Pane("m:0.2", "%502", 502, c)]
    fl, ctx, rd, _ = small_run(root, "model-run", panes, home, agents, good_env, uid, aligned)
    rep, rc = fr_run.apply_run(rd, ctx, approve(rd))
    res = {p["pane"]: p for p in rep["panes"]}
    md = open(os.path.join(rd, "report.md")).read()
    case("CTL runtime model switch reverted by restart -> MODEL_CHANGED warning in report.md and run output, never a failure (VERIFIED, exit 0)",
         rep["warnings"] == ["MODEL_CHANGED m:0.1: GPT-6-Luna -> Muse Spark 1.3"] and "MODEL_CHANGED m:0.1: GPT-6-Luna -> Muse Spark 1.3" in md
         and res["m:0.1"]["result"] == "VERIFIED" and not rep["failed"] and rep["breaker"] is None and rc == 0 and "model_changed" not in res["m:0.2"],
         json.dumps([rep["warnings"], res["m:0.1"].get("result"), rc]))


# ---------- m5gs: forked sessions fail verify; undrained sessions hold respawn ----------

def gate_session_fork(case, root, home, agents, good_env, uid, aligned):
    def cwd(name):
        d = os.path.join(root, name)
        os.makedirs(d, exist_ok=True)
        return d

    sess = "/h/.omp/agent/sessions/-w/2026-10-13T00-00-00-000Z_abc.jsonl"
    one = "p1\nftxt\nn/x/omp\nf38\nn%s\n" % sess
    two = one + "f40\nn/h/.omp/agent/sessions/-w/2026-10-13T00-00-00-000Z_abc-new.jsonl\n"
    case("CTL one open session file is exact", fr_save.session_exact(one, sess) is True, json.dumps(fr_save.session_candidates(one)))
    case("NEG saved file plus a second open session file is not exact", fr_save.session_exact(two, sess) is False, json.dumps(fr_save.session_candidates(two)))

    c = cwd("fork-unit")
    clean = os.path.join(c, "clean.jsonl")
    moved = os.path.join(c, "moved.jsonl")
    parented = os.path.join(c, "parented.jsonl")
    with open(clean, "w") as fh:
        fh.write('{"sessionId":"abc","cwd":"/w"}\n{"role":"user","text":"hi"}\n')
    with open(moved, "w") as fh:
        fh.write('{"sessionId":"abc","cwd":"/w"}\n{"role":"user","text":"hi"}\n{"type":"system","text":"Session moved to a new file (reason=open-elsewhere)"}\n')
    with open(parented, "w") as fh:
        fh.write('{"sessionId":"def","parentSession":"abc","cwd":"/w"}\n')
    case("CTL clean session file shows no fork", fr_save.fork_evidence(clean) is None)
    case("NEG 'Session moved to a new file' record names the fork",
         (fr_save.fork_evidence(moved) or "").startswith("SESSION_MOVED_TO_NEW_FILE"), fr_save.fork_evidence(moved))
    case("NEG parentSession header names the fork",
         (fr_save.fork_evidence(parented) or "").startswith("PARENT_SESSION"), fr_save.fork_evidence(parented))
    case("CTL missing session file is no fork evidence (never a false failure)", fr_save.fork_evidence(os.path.join(c, "gone.jsonl")) is None)
    case("CTL no session file is no fork evidence", fr_save.fork_evidence(None) is None)

    # run path: the saved session forked before verify -> SESSION_FORKED, a failure
    c = cwd("fork-run")
    panes = [Pane("w:0.1", "%101", 101, c), Pane("w:0.2", "%102", 102, c)]
    for p in panes:
        os.makedirs(os.path.dirname(p.session), exist_ok=True)
        with open(p.session, "w") as fh:
            fh.write('{"sessionId":"%s","cwd":%s}\n' % (os.path.basename(p.session)[:8], json.dumps(c)))
    with open(panes[0].session, "a") as fh:
        fh.write('{"type":"system","text":"Session moved to a new file (reason=open-elsewhere)"}\n')
    fl, ctx, rd, _ = small_run(root, "fork-run", panes, home, agents, good_env, uid, aligned, wave=2)
    rep, rc = fr_run.apply_run(rd, ctx, approve(rd))
    res = {p["pane"]: p for p in rep["panes"]}
    md = open(os.path.join(rd, "report.md")).read()
    case("NEG forked session (Session moved event) -> SESSION_FORKED failure, exit non-zero",
         res["w:0.1"]["result"] == "SESSION_FORKED" and res["w:0.1"]["session"] == "SESSION_FORKED" and "w:0.1" in rep["failed"]
         and rc == fr_run.EXIT_FAILED and "Session moved to a new file" in " ".join(res["w:0.1"]["why"]), json.dumps(res["w:0.1"]))
    case("NEG SESSION_FORKED trips the breaker: next wave HOLD_BREAKER, zero sends, watchers back",
         res["w:0.2"]["result"] == "HOLD_BREAKER" and fl.count("w:0.2") == 0 and "BREAKER: w:0.1 SESSION_FORKED" in md and watchers_back(fl),
         json.dumps(rep["breaker"]))

    # real `verify` command path with --save sessions: the fork fails ...
    # (w:0.2 never restarted: the fork tripped the breaker, so scope to SENT)
    plan = json.load(open(os.path.join(rd, "plan.json")))
    saved = {r["pane_id"]: r for r in json.load(open(os.path.join(rd, "save.json")))["rows"]}
    sessions = {k: r["session_file"] for k, r in saved.items() if r.get("session_file")}
    vres = fr.verify(plan, fl.inventory(), {}, sent={"w:0.1"}, sessions=sessions, lsof_fn=fl.lsof, fork_fn=fr_save.fork_evidence)
    by = {r["pane"]: r for r in vres["rows"]}
    case("NEG real verify path with --save: forked session FAILED (exit non-zero)",
         by["w:0.1"]["result"] == "FAILED" and any("SESSION_FORKED" in w for w in by["w:0.1"]["why"])
         and vres["verified"] != vres["total"], json.dumps(by["w:0.1"]))
    # ... and a clean run verifies through the same path
    c = cwd("fork-clean")
    panes = [Pane("w:0.1", "%101", 101, c), Pane("w:0.2", "%102", 102, c)]
    fl2, _, rd2, _ = small_run(root, "fork-clean", panes, home, agents, good_env, uid, aligned, wave=2)
    rep2, rc2 = fr_run.apply_run(rd2, ctx_for(fl2, home, agents, good_env, uid, aligned), approve(rd2))
    plan2 = json.load(open(os.path.join(rd2, "plan.json")))
    saved2 = {r["pane_id"]: r for r in json.load(open(os.path.join(rd2, "save.json")))["rows"]}
    sessions2 = {k: r["session_file"] for k, r in saved2.items() if r.get("session_file")}
    vres2 = fr.verify(plan2, fl2.inventory(), {}, sessions=sessions2, lsof_fn=fl2.lsof, fork_fn=fr_save.fork_evidence)
    by2 = {r["pane"]: r for r in vres2["rows"]}
    case("CTL real verify path with --save: unforked panes VERIFIED",
         rc2 == 0 and vres2["verified"] == vres2["total"]
         and all(r["result"] == "VERIFIED" for r in vres2["rows"]), json.dumps(by2))

    # run path: a second session file opens mid-run -> SESSION_LOST, never SESSION_KEPT
    c = cwd("fork-extra")
    fl, ctx, rd, _ = small_run(root, "fork-extra", [Pane("w:0.1", "%101", 101, c, extra_after_restart=True)],
                               home, agents, good_env, uid, aligned)
    rep, rc = fr_run.apply_run(rd, ctx, approve(rd))
    res = {p["pane"]: p for p in rep["panes"]}
    case("NEG extra session file open after /restart -> SESSION_LOST even though the saved file is still open",
         res["w:0.1"]["result"] == "SESSION_LOST" and "w:0.1" in rep["failed"] and rc == fr_run.EXIT_FAILED
         and "expected exactly" in " ".join(res["w:0.1"]["why"]), json.dumps(res["w:0.1"]))

    # run path: another live pane still holds the session -> HOLD_SESSION_HOLDER, zero sends.
    # The holder is a busy pane: never sent, but still in the inventory holding pa's
    # session file, so the session never drained and pa's respawn must refuse.
    c = cwd("fork-holder")
    pa = Pane("r:0.7", "%207", 207, c, kind="tern")
    pb = Pane("w:0.9", "%109", 109, c, busy_until=1e12, mirror_session=pa.session)
    pc = Pane("r:0.8", "%208", 208, c, kind="tern")
    fl, ctx, rd, _ = small_run(root, "fork-holder", [pc, pa, pb], home, agents, good_env, uid, aligned, wave=3)
    rep, rc = fr_run.apply_run(rd, ctx, approve(rd))
    res = {p["pane"]: p for p in rep["panes"]}
    case("NEG session still held by another live pane -> HOLD_SESSION_HOLDER, zero sends (drain refused)",
         res["r:0.7"]["result"] == "HOLD_SESSION_HOLDER" and fl.count("r:0.7") == 0, json.dumps(res["r:0.7"]))
    case("CTL unshared session respawns while the shared one holds",
         res["r:0.8"]["result"] == "VERIFIED" and fl.count("r:0.8", "RESPAWN") == 1, json.dumps(res["r:0.8"]))


# ---------- VERDICT: the only terminal ledger event on --resume-run ----------

def crash_on(event):
    """Make the first Ledger.add(event) raise (a crash at that ledger line); returns the restore function."""
    real, fired = fr_run.Ledger.add, []

    def add(self, ev, **kw):
        if ev == event and not fired:
            fired.append(ev)
            raise RuntimeError("simulated crash before %s" % event)
        return real(self, ev, **kw)
    fr_run.Ledger.add = add
    return lambda: setattr(fr_run.Ledger, "add", real)


def gate_verdict_resume(case, root, home, agents, good_env, uid, aligned):
    cwd = os.path.join(root, "w")

    def setup(name, pane):
        fl = FakeFleet([pane], FakeLaunchd(loaded={"com.omp-kit.fleet-watch"}))
        ctx = ctx_for(fl, home, agents, good_env, uid, aligned)
        rd = os.path.join(root, "v-" + name)
        fr_run.plan_run(rd, ctx, "%3", fr.DEFAULT_PROTECT, wave=1)
        return fl, ctx, rd

    def events(rd):
        return [json.loads(ln) for ln in open(os.path.join(rd, fr_run.LEDGER))]

    # (a) first run ends VERSION_STALE; the resume keeps it
    fl, ctx, rd = setup("stale", Pane("w:0.1", "%101", 101, cwd, kind="tern", stale=True))
    rep1, rc1 = fr_run.apply_run(rd, ctx, approve(rd))
    n = len(fl.sends)
    rep, rc = fr_run.apply_run(rd, ctx, approve(rd), resume_run=True)
    case("NEG --resume-run after a VERSION_STALE verdict -> still VERSION_STALE, zero sends, exit 6",
         rep1["panes"][0]["result"] == "VERSION_STALE" and rc1 == fr_run.EXIT_FAILED and rep["panes"][0]["result"] == "VERSION_STALE"
         and rep["panes"][0].get("from_ledger") and len(fl.sends) == n and rc == fr_run.EXIT_FAILED, json.dumps([rep1["panes"], rep["panes"], rc]))

    # (b) crash after VERIFY, before SESSION/VERDICT; the session file is different by the resume
    p = Pane("w:0.1", "%101", 101, cwd)
    fl, ctx, rd = setup("lost", p)
    restore = crash_on("SESSION")
    try:
        fr_run.apply_run(rd, ctx, approve(rd))
    finally:
        restore()
    ev = [e["event"] for e in events(rd) if e.get("pane") == "w:0.1"]
    p.lose_session = True
    n = len(fl.sends)
    rep, rc = fr_run.apply_run(rd, ctx, approve(rd), resume_run=True)
    verdicts = [e["result"] for e in events(rd) if e["event"] == "VERDICT"]
    case("NEG crash after VERIFY before SESSION/VERDICT, session file changed -> resume re-verifies: SESSION_LOST, zero sends, exit 6",
         "VERIFY" in ev and "VERDICT" not in ev and rep["panes"][0]["result"] == "SESSION_LOST" and len(fl.sends) == n
         and verdicts == ["SESSION_LOST"] and rc == fr_run.EXIT_FAILED, json.dumps([ev, rep["panes"], verdicts]))

    # (c) crash after VERIFY/SESSION/VERSION, before VERDICT; everything still good
    fl, ctx, rd = setup("good", Pane("w:0.1", "%101", 101, cwd, kind="tern"))
    restore = crash_on("VERDICT")
    try:
        fr_run.apply_run(rd, ctx, approve(rd))
    finally:
        restore()
    n = len(fl.sends)
    rep, rc = fr_run.apply_run(rd, ctx, approve(rd), resume_run=True)
    ev = [e["event"] for e in events(rd) if e.get("pane") == "w:0.1"]
    case("CTL crash after VERIFY before VERDICT, all checks good -> resume re-verifies without re-sending: VERIFIED, exit 0",
         rep["panes"][0]["result"] == "VERIFIED" and rep["panes"][0]["version"] == "VERSION_OK" and rep["panes"][0]["session"] == "SESSION_KEPT"
         and len(fl.sends) == n == 1 and ev.count("VERDICT") == 1 and "REVERIFY" in ev and rc == 0, json.dumps([ev, rep["panes"], rc]))


def home_hits(text):
    """Per-user home-root literals, mirroring scripts/publishability-check.sh
    (the /Users/Shared documentation exemption). Built by concatenation so
    this probe never trips the scan itself (ompkit-oq1h.9)."""
    pat = re.compile("/Users" + "/[^ /:]+" + "|/home" + "/[^ /:]+")
    return [ln for ln in text.splitlines()
            if pat.search(ln) and "/Users" + "/Shared" not in ln]


def gate_portability(case, tmp):
    both = fr.health_text("/r/repo", "s:0.1", which=lambda name: "/bin/%s" % name)
    case("CTL health clause names bare tools on PATH",
         "flywheel doctor --repo /r/repo --json" in both and "ntm health s:0.1 --json" in both
         and "INIT includes HEALTH" in both, both)
    only_ntm = fr.health_text("/r/repo", "s:0.1", which=lambda name: "/bin/ntm" if name == "ntm" else None)
    case("NEG missing flywheel is omitted from the health clause, never reported as run",
         "flywheel" not in only_ntm and "ntm health s:0.1 --json" in only_ntm, only_ntm)
    neither = fr.health_text("/r/repo", "s:0.1", which=lambda name: None)
    case("NEG no health tool on PATH -> record-by-hand line, no bare-tool claim",
         neither.startswith("No HEALTH tool") and "flywheel" in neither and "ntm" in neither, neither)
    real_platform = sys.platform
    try:
        sys.platform = "linux"
        plat = fw.platform_status()
        case("NEG watcher stage off macOS -> UNSUPPORTED skip with reason",
             (plat or {}).get("result") == "UNSUPPORTED" and "launchd" in (plat or {}).get("reason", ""), json.dumps(plat))
    finally:
        sys.platform = real_platform
    case("CTL watcher stage on this host is not refused", fw.platform_status() is None, json.dumps(fw.platform_status()))
    planted = "x " + "/Users" + "/planted/bin " + "y"
    case("NEG probe flags a planted per-user home literal", len(home_hits(planted)) == 1, planted)
    case("CTL probe passes the shared-docs exemption and bare tildes",
         home_hits("x /Users/Shared/y\nz ~/w\n") == [], "exempt/tilde")
    roots = [os.path.dirname(HERE), os.path.join(os.path.dirname(os.path.dirname(HERE)), "fleet-round")]
    found = []
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d != ".ruff_cache"]
            for fn in filenames:
                if not fn.endswith((".py", ".md", ".json", ".plist", ".ts", ".sh")):
                    continue
                with open(os.path.join(dirpath, fn), encoding="utf-8", errors="replace") as fh:
                    for ln in home_hits(fh.read()):
                        found.append(os.path.join(dirpath, fn) + ": " + ln.strip()[:80])
    case("NEG shipped skill sources carry no per-user home literal", not found, json.dumps(found[:5]))


# ---------- uxr3 ----------

def gate_uxr3(case, tmp, plan, inventory, aligned):
    with open(os.path.join(os.path.dirname(HERE), "SKILL.md")) as fh:
        skill = fh.read()
    cmds = [ln.strip() for ln in skill.splitlines()]
    case("NEG SKILL.md has no bare-variable launcher line and no `env` subcommand (uxr3: printed secrets)",
         not [c for c in cmds if c.startswith(("FR=", "$FR"))] and 'fleet_restart.py" env' not in skill
         and 'python3 "$SKILL/scripts/fleet_restart.py" check-env' in skill)
    rd = os.path.join(tmp, "uxr3")
    os.makedirs(rd)
    fw.write_json(os.path.join(rd, fr_run.RUN_MANIFEST), {"kind": "run", "snapshot_dir": os.path.join(rd, "snapshot")})
    ns = argparse.Namespace(run=rd, plan=None, snapshot=None)
    case("CTL handoff/messages default to the run manifest's stage-1 snapshot", fr.stage1(ns) == (os.path.join(rd, "plan.json"), os.path.join(rd, "snapshot")))
    ns.snapshot = os.path.join(rd, "snapshot-after")
    try:
        fr.stage1(ns)
        msg = "NO_ERROR"
    except SystemExit as exc:
        msg = str(exc)
    case("NEG post-restart snapshot passed to handoff/messages -> SNAPSHOT_NOT_STAGE1", msg.startswith("SNAPSHOT_NOT_STAGE1"), msg)
    p2 = fr.build_plan(inventory(), "omp-test:0.1", fr.DEFAULT_PROTECT, aligned, unprotect=["uds--burn-down:0.0"])
    row = {r["pane"]: r for r in p2["rows"]}["uds--burn-down:0.0"]
    case("CTL DEFAULT_PROTECT overridable via unprotect (row marked unprotected)", row["action"] == "RESTART" and row.get("unprotected"), json.dumps(row.get("action")))


# ---------- native watchers exercise (ompkit-rhy9.3) ----------

NATIVE_ENV = "FLEET_RESTART_NATIVE_WATCHERS"
NATIVE_PREFIX = "com.omp-kit.selftest."


def _launchctl(argv, timeout=30):
    try:
        res = pysafe.run_bounded(["launchctl"] + argv, timeout=timeout)
    except OSError as exc:
        return 127, "%s: %s" % (type(exc).__name__, exc)
    return res.returncode if res.returncode is not None else 124, (res.text() + res.text("stderr"))[-500:]


def _native_loaded(label):
    return _launchctl(["print", "gui/%d/%s" % (os.getuid(), label)])[0] == 0


def gates_native(case, tmp, uid):
    """Isolated native LaunchAgent exercise through the real `watchers`
    commands: owned selftest-prefixed labels only, plist files in the owned
    tmp dir (never the live agents dir), inert payloads that never execute
    (no RunAtLoad/triggers: loaded-but-inactive registry state only), swept
    in a finally. Production watcher loaded state is snapshotted before and
    compared after: any change fails the gate. Opt-in: needs macOS launchd
    plus FLEET_RESTART_NATIVE_WATCHERS=1, otherwise an honest SKIP."""
    if os.environ.get(NATIVE_ENV) != "1" or fw.platform_status() is not None:
        case("SKIP native watcher exercise (needs macOS + FLEET_RESTART_NATIVE_WATCHERS=1)", True)
        return
    root = os.path.join(tmp, "watchers-native")
    os.makedirs(root, exist_ok=True)
    tag = "p%d" % os.getpid()
    actor = NATIVE_PREFIX + tag + ".actor"
    reader = NATIVE_PREFIX + tag + ".reader"
    parked = NATIVE_PREFIX + tag + ".parked"
    labels = [actor, reader, parked]
    for lab in labels:
        if not lab.startswith(NATIVE_PREFIX):
            case("NEG native labels stay inside the owned selftest prefix", False, lab)
            return
    script = os.path.join(HERE, "fleet_restart.py")
    ag = os.path.join(root, "LaunchAgents")
    os.makedirs(ag, exist_ok=True)
    reg_path = os.path.join(root, "registry.json")
    with open(reg_path, "w") as fh:
        json.dump({"jobs": {actor: {"class": "pane-actor", "pause": True, "why": "selftest owned actor"},
                             reader: {"class": "reader", "pause": False, "why": "selftest owned reader"},
                             parked: {"class": "pane-actor", "pause": True, "why": "selftest owned parked"}}}, fh)
    for lab in labels:
        write_plist(ag, lab, ["/bin/true"])
    prod = ["com.omp-kit.fleet-watch", "com.omp-kit.fleet-flush", "com.omp-kit.kit-update",
            "com.omp-kit.scratch-reaper", "com.omp-kit.omp-watch"]
    before = {lab: _native_loaded(lab) for lab in prod}
    rundirs = []

    def cli(*args):
        res = pysafe.run_bounded([sys.executable, script] + list(args), timeout=120)
        try:
            return res.returncode, json.loads(res.text() or "{}")
        except ValueError:
            return res.returncode, {"raw": (res.text() or "")[-500:], "stderr": (res.text("stderr") or "")[-500:]}

    def sweep():
        for lab in labels:
            if _native_loaded(lab):
                _launchctl(["bootout", "gui/%d/%s" % (os.getuid(), lab)])
        for rd in rundirs:
            dm = fw.deadman_label(os.path.abspath(rd))
            if _native_loaded(dm):
                _launchctl(["bootout", "gui/%d/%s" % dm])

    def pause_apply(rd, ttl=None):
        rc, _ = cli("watchers", "pause", "--run", rd, "--agents-dir", ag, "--registry", reg_path)
        if rc != 0:
            return (rc, {}), {}
        with open(os.path.join(rd, "watchers-pause-plan.json")) as fh:
            plan_man = json.load(fh)
        appr = os.path.join(rd, "approval.json")
        with open(appr, "w") as fh:
            json.dump({"manifest_sha256": plan_man["manifest_sha256"], "approved_by": "selftest-native", "quote": "go"}, fh)
        args = ["watchers", "pause", "--run", rd, "--agents-dir", ag, "--registry", reg_path, "--apply", "--approval", appr]
        if ttl is not None:
            args += ["--ttl-min", str(ttl)]
        return cli(*args), plan_man

    try:
        sweep()  # strays from a killed earlier run are ours by prefix: reclaim first
        for lab in (actor, reader):  # parked starts (and stays) unloaded
            rc, out = _launchctl(["bootstrap", "gui/%d" % os.getuid(), os.path.join(ag, lab + ".plist")])
            if rc != 0 or not _native_loaded(lab):
                case("NEG native bootstrap loads the owned fixture %s" % lab, False, "rc=%d %s" % (rc, out))
                return
        case("CTL native fixtures load: actor + reader bootstrapped, parked stays unloaded",
             _native_loaded(actor) and _native_loaded(reader) and not _native_loaded(parked))

        rd = os.path.join(root, "n-ok")
        rundirs.append(rd)
        (rc, rec), plan_man = pause_apply(rd)
        with open(os.path.join(ag, actor + ".plist"), "rb") as fh:
            expect_sha = hashlib.sha256(fh.read()).hexdigest()
        rows = {(r["label"], r["plist"], r["plist_sha256"]) for r in plan_man.get("rows", [])}
        case("CTL native approval names the precise observed set/plist identities",
             rows == {(actor, os.path.join(ag, actor + ".plist"), expect_sha)}, json.dumps(plan_man.get("rows")))
        by = {r["label"]: r["action"] for r in rec.get("rows", [])}
        case("CTL native pause: registered loaded pause:true job stops; reader and unloaded jobs untouched",
             rc == 0 and by.get(actor) == "BOOTED_OUT" and by.get(parked) == "SKIP_NOT_LOADED"
             and not _native_loaded(actor) and _native_loaded(reader) and not _native_loaded(parked),
             json.dumps(by))
        rc, res = cli("watchers", "resume", "--run", rd, "--agents-dir", ag, "--registry", reg_path, "--apply")
        case("CTL native resume recovers the exact actually-paused set and verifies loaded state",
             rc == 0 and res.get("result") == "RESUMED" and [r["label"] for r in res.get("rows", [])] == [actor]
             and _native_loaded(actor) and _native_loaded(reader) and not _native_loaded(parked)
             and not _native_loaded(fw.deadman_label(os.path.abspath(rd))), json.dumps(res.get("rows")))

        rd = os.path.join(root, "n-raised")
        rundirs.append(rd)
        (rc, _), _ = pause_apply(rd)
        crashed_window = rc == 0 and not _native_loaded(actor) and _native_loaded(reader)
        rc, res = cli("watchers", "resume", "--run", rd, "--agents-dir", ag, "--registry", reg_path, "--apply")
        case("CTL native raised step: the finally path still recovers the exact set, verified loaded",
             crashed_window and rc == 0 and res.get("result") == "RESUMED"
             and [r["label"] for r in res.get("rows", [])] == [actor] and _native_loaded(actor)
             and not _native_loaded(parked), json.dumps(res.get("rows")))

        rd = os.path.join(root, "n-ttl")
        rundirs.append(rd)
        (rc, _), _ = pause_apply(rd, ttl=0)
        died = rc == 0 and not _native_loaded(actor)
        # the run dies here: no finally. A fresh process runs the dead-man's
        # exact command after expiry and must recover the exact set.
        rc, res = cli("watchers", "resume", "--run", rd, "--agents-dir", ag, "--registry", reg_path,
                      "--if-expired", "--apply")
        case("CTL native killed run past TTL: the dead-man command recovers the exact set, verified loaded",
             died and rc == 0 and res.get("result") == "RESUMED"
             and [r["label"] for r in res.get("rows", [])] == [actor] and _native_loaded(actor)
             and _native_loaded(reader) and not _native_loaded(parked)
             and not _native_loaded(fw.deadman_label(os.path.abspath(rd))), json.dumps(res.get("rows")))

        rd = os.path.join(root, "n-drift")
        rundirs.append(rd)
        rc, _ = cli("watchers", "pause", "--run", rd, "--agents-dir", ag, "--registry", reg_path)
        with open(os.path.join(rd, "watchers-pause-plan.json")) as fh:
            plan_man = json.load(fh)
        appr = os.path.join(rd, "approval.json")
        with open(appr, "w") as fh:
            json.dump({"manifest_sha256": plan_man["manifest_sha256"], "approved_by": "selftest-native", "quote": "go"}, fh)
        write_plist(ag, actor, ["/bin/true", "drifted"])  # same label, changed bytes after approval
        rc2, out2 = cli("watchers", "pause", "--run", rd, "--agents-dir", ag, "--registry", reg_path,
                        "--apply", "--approval", appr)
        case("NEG native stale approval after plist bytes change -> APPROVAL_MISMATCH, actor still loaded, zero bootouts",
             rc == 0 and rc2 == 4 and "APPROVAL_MISMATCH" in json.dumps(out2) and _native_loaded(actor)
             and _native_loaded(reader) and not _native_loaded(parked), "rc=%d rc2=%d %s" % (rc, rc2, json.dumps(out2)[:300]))

        after = {lab: _native_loaded(lab) for lab in prod}
        case("CTL production watcher loaded state unchanged by the native exercise",
             after == before, json.dumps({lab: (before[lab], after[lab]) for lab in prod if before[lab] != after[lab]}))
    finally:
        sweep()
        left = [lab for lab in labels if _native_loaded(lab)]
        case("CTL native sweep leaves no owned fixture loaded", not left, json.dumps(left))
