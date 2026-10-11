#!/usr/bin/env python3
"""Selftest for fleet_restart.py: every gate must fire on a planted negative
and pass its paired control. Run: python3 scripts/selftest.py (exit 0 = all
gates bite). Planted negatives come from the 2026-10-11 fleet restart:
busy pane, flags rebuilt from the screen, missing TMUX env, Sonnet pane
missed by a model-name regex, plugin links left on the old release (RELINK1,
ompkit-fp72.18), send without operator approval, /private/tmp cwd."""
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fleet_restart as fr  # noqa: E402

FAILS = []


def case(name, cond, detail=""):
    print("%s %s%s" % ("PASS" if cond else "FAIL", name, (" -- " + detail) if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


IDLE = [
    "──── 📥 INTAKE: Complete minimal intake runtime closure ─",
    "❯",
    "────────────────────────────────────",
    " π · ◒ Muse Spark 1.3 (C) · 📁 ~/Developer/clutterfreespaces.ios · ⑂ main · ◫ 16.3%/1M ⟲ · S0.05",
]
BUSY = [
    "  ⎋ Recording measured recovery and host incident",
    "──── 🔕 HOLD: Coordinate UDS/CFS Beads task execution ─",
    "❯",
    "────────────────────────────────────",
    " ⠼ 1h · ◕ GPT-6.1-Sol · 📁 ~/Developer/uds · ⑂ main *7 ?6 · ◫ 78.9%/272K ⟲ · S60.24 (+0.48)",
]
SONNET_IDLE = [  # live 2026-10-11 shape: boxed status bar with ' > ' separators
    "╭── π > ⟳ Sonnet 5.5 > 📁 ~/Developer/modeltest > (sub) ▶──9%───────────────╎┃──1M───╮",
    "│                                                                                    │",
    "╰─                                                                                  ─╯",
]
SHELL_WITH_OLD_STATUS = [" π · ◕ CI glm-5.3-flash · 📁 ~/Developer/modeltest · S0.1"] + ["output line %d" % i for i in range(10)] + [
    "josh@Joshs-Mac-Studio modeltest % rea setup --client omp", "zsh: command not found: rea", "josh@Joshs-Mac-Studio modeltest % "]
OMP = "bun /Users/josh/.bun/bin/omp"
CLI = "/opt/homebrew/Cellar/bun/1.3.8/bin/bun /Users/josh/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"
WORKER = CLI + " __omp_worker_daemon_broker"


def inventory():
    panes = [
        # Sonnet worker launched bare: no --profile, model only in args/screen.
        {"pane": "modeltest:0.1", "pane_id": "%55", "pane_pid": 100, "cwd": "/Users/josh/Developer/modeltest", "screen": SONNET_IDLE},
        # director busy mid-turn.
        {"pane": "control-plane:0.1", "pane_id": "%17", "pane_pid": 200, "cwd": "/Users/josh/Developer/uds", "screen": BUSY},
        # re-exec'd omp (cli.js shape) with --thinking/--auto-approve flags.
        {"pane": "uds--burn-down:0.1", "pane_id": "%36", "pane_pid": 300, "cwd": "/Users/josh/Developer/uds", "screen": IDLE},
        # protected pane.
        {"pane": "uds--burn-down:0.0", "pane_id": "%31", "pane_pid": 400, "cwd": "/Users/josh/Developer/uds", "screen": IDLE},
        # chief pane.
        {"pane": "omp-test:0.1", "pane_id": "%3", "pane_pid": 500, "cwd": "/Users/josh/Developer/omp-test", "screen": IDLE},
        # plain shell with only a stray worker-daemon descendant.
        {"pane": "jev:0.0", "pane_id": "%19", "pane_pid": 600, "cwd": "/Users/josh/Developer/jev", "screen": ["%"]},
        # agent whose cwd is forbidden.
        {"pane": "modeltest:0.2", "pane_id": "%4", "pane_pid": 700, "cwd": "/private/tmp", "screen": IDLE},
    ]
    procs = [
        {"pid": 100, "ppid": 1, "args": "-zsh"},
        {"pid": 101, "ppid": 100, "args": OMP + " --model anthropic/claude-sonnet-5-5"},
        {"pid": 102, "ppid": 101, "args": "npm exec rea-agents@6.3.0 mcp"},
        {"pid": 103, "ppid": 101, "args": WORKER},
        {"pid": 200, "ppid": 1, "args": "-zsh"},
        {"pid": 201, "ppid": 200, "args": OMP + " --profile claude --model gpt-6.1-sol"},
        {"pid": 300, "ppid": 1, "args": "-zsh"},
        {"pid": 301, "ppid": 300, "args": CLI + " --profile muse --model muse-code/muse-spark-1.3-contributor --thinking high --auto-approve --resume abc"},
        {"pid": 302, "ppid": 301, "args": "npm exec rea-agents@6.3.0 mcp"},
        {"pid": 400, "ppid": 1, "args": "-zsh"},
        {"pid": 401, "ppid": 400, "args": OMP + " --profile claude"},
        {"pid": 500, "ppid": 1, "args": "-zsh"},
        {"pid": 501, "ppid": 500, "args": OMP + " --profile claude --model claude-opus-5-5"},
        {"pid": 600, "ppid": 1, "args": "-zsh"},
        {"pid": 601, "ppid": 600, "args": WORKER},
        {"pid": 700, "ppid": 1, "args": "-zsh"},
        {"pid": 701, "ppid": 700, "args": OMP + " --profile codex"},
    ]
    return {"captured_at": "2026-10-11T15:32:42Z", "panes": panes, "procs": procs}


def fake_home(root, link_version, release_version):
    home = os.path.join(root, "home")
    rel = os.path.join(root, "releases")
    for v in {link_version, release_version}:
        os.makedirs(os.path.join(rel, v), exist_ok=True)
    links = [os.path.join(home, ".omp", "plugins", "node_modules", "omp-kit-companion")]
    for prof in ("claude", "muse"):
        links.append(os.path.join(home, ".omp", "profiles", prof, "plugins", "node_modules", "omp-kit-companion"))
    for link in links:
        os.makedirs(os.path.dirname(link), exist_ok=True)
        os.symlink(os.path.join(rel, link_version), link)
    return home, rel


def main():
    tmp = tempfile.mkdtemp(prefix="fleet-restart-selftest.")
    uid = os.getuid()

    # --- missing TMUX env (ntm send then fails "no tmux sessions running")
    ok, code, _ = fr.env_check({}, uid)
    case("NEG tmux env missing -> TMUX_ENV_MISSING", not ok and code == "TMUX_ENV_MISSING", code)
    ok, code, _ = fr.env_check({"TMUX_TMPDIR": os.path.join(tmp, "nosock")}, uid)
    case("NEG tmux socket absent -> TMUX_SOCKET_MISSING", not ok and code == "TMUX_SOCKET_MISSING", code)
    sockdir = os.path.join(tmp, "sock", "tmux-%d" % uid)
    os.makedirs(sockdir)
    open(os.path.join(sockdir, "default"), "w").close()
    good_env = {"TMUX_TMPDIR": os.path.join(tmp, "sock")}
    ok, code, _ = fr.env_check(good_env, uid)
    case("CTL tmux env with socket -> OK", ok and code == "OK", code)

    # --- plugin links stale (RELINK1): plan must refuse
    stale_root = os.path.join(tmp, "stale")
    home, rel = fake_home(stale_root, "0.2.19", "0.2.20")
    report = fr.align_check(home, rel, "0.2.20")
    case("NEG plugin links on old release -> align not ok", not report["ok"] and len(report["stale"]) == 3, json.dumps(report)[:200])
    plan = fr.build_plan(inventory(), chief="omp-test:0.1", protect=fr.DEFAULT_PROTECT, align_report=report)
    case("NEG plan refuses while links stale -> ALIGN_STALE", plan.get("refused") == "ALIGN_STALE" and not plan["rows"], str(plan.get("refused")))
    undo = os.path.join(stale_root, "relink-undo.json")
    case("CTL relink dry-run changes nothing", fr.relink(report, undo, apply=False)["applied"] is False and not fr.align_check(home, rel, "0.2.20")["ok"])
    fr.relink(report, undo, apply=True)
    after = fr.align_check(home, rel, "0.2.20")
    with open(undo) as fh:
        undo_rows = json.load(fh)["links"]
    case("CTL relink apply -> aligned with undo record of old targets", after["ok"] and all(r["old_target"].endswith("0.2.19") for r in undo_rows) and len(undo_rows) == 3)
    with open(undo) as fh:
        undo_cmd = json.load(fh)["undo"]
    rc = subprocess.run(undo_cmd, shell=True).returncode
    restored = fr.align_check(home, rel, "0.2.20")
    case("CTL undo record command restores the old targets", rc == 0 and len(restored["stale"]) == 3
         and all(r["target"].endswith("0.2.19") for r in restored["links"]), "rc=%s" % rc)

    good_root = os.path.join(tmp, "good")
    home, rel = fake_home(good_root, "0.2.20", "0.2.20")
    aligned = fr.align_check(home, rel, "0.2.20")
    case("CTL links on active release -> align ok", aligned["ok"])

    plan = fr.build_plan(inventory(), chief="omp-test:0.1", protect=fr.DEFAULT_PROTECT, align_report=aligned)
    rows = {r["pane"]: r for r in plan["rows"]}

    # --- Sonnet pane detected by process, not model-name regex
    case("NEG-catch Sonnet bare-launch pane detected as agent -> RESTART", rows["modeltest:0.1"]["action"] == "RESTART", rows["modeltest:0.1"]["action"])
    case("CTL cli.js re-exec shape detected, flags copied from live args",
         rows["uds--burn-down:0.1"]["action"] == "RESTART"
         and rows["uds--burn-down:0.1"]["flags"] == ["--profile", "muse", "--model", "muse-code/muse-spark-1.3-contributor", "--thinking", "high", "--auto-approve"],
         json.dumps(rows["uds--burn-down:0.1"].get("flags")))
    case("NEG worker-daemon-only shell pane -> SKIP_SHELL", rows["jev:0.0"]["action"] == "SKIP_SHELL", rows["jev:0.0"]["action"])
    # --- busy pane never restarted
    case("NEG busy pane -> QUEUE_BUSY", rows["control-plane:0.1"]["action"] == "QUEUE_BUSY", rows["control-plane:0.1"]["action"])
    case("NEG protected pane -> SKIP_PROTECTED", rows["uds--burn-down:0.0"]["action"] == "SKIP_PROTECTED", rows["uds--burn-down:0.0"]["action"])
    case("NEG chief pane -> SKIP_CHIEF", rows["omp-test:0.1"]["action"] == "SKIP_CHIEF", rows["omp-test:0.1"]["action"])
    case("NEG /private/tmp cwd -> HOLD_CWD", rows["modeltest:0.2"]["action"] == "HOLD_CWD", rows["modeltest:0.2"]["action"])
    case("NEG unknown screen state -> HOLD_UNKNOWN_STATE", fr.parse_screen(["garbage"])["state"] == "UNKNOWN")
    case("NEG old omp status in shell scrollback is not read as IDLE", fr.parse_screen(SHELL_WITH_OLD_STATUS)["state"] == "UNKNOWN",
         str(fr.parse_screen(SHELL_WITH_OLD_STATUS)))
    case("CTL boxed ' > ' status bar parsed (state, model)", fr.parse_screen(SONNET_IDLE) == {"state": "IDLE", "model": "Sonnet 5.5"},
         str(fr.parse_screen(SONNET_IDLE)))

    # --- screen-rebuilt command refused (respawn fallback copies live args only)
    row = dict(rows["uds--burn-down:0.1"])
    good_cmd = fr.respawn_cmd(row)
    case("CTL respawn cmd from live args passes flag check", fr.check_cmd_flags(good_cmd, row["flags"])[0], good_cmd)
    screen_cmd = "cd /Users/josh/Developer/uds && omp --model muse-code/muse-spark-1.3-contributor"
    ok, code = fr.check_cmd_flags(screen_cmd, row["flags"])
    case("NEG screen-rebuilt respawn cmd -> FLAGS_NOT_FROM_LIVE_ARGS", not ok and code == "FLAGS_NOT_FROM_LIVE_ARGS", code)
    tampered = fr.restart_manifest(plan, mode="respawn")
    for r in tampered["rows"]:
        if r["pane"] == "uds--burn-down:0.1":
            r["cmd"] = screen_cmd
    res = fr.send(tampered, apply=True, approval={"manifest_sha256": fr.manifest_sha(tampered), "approved_by": "selftest", "quote": "go"},
                  env=good_env, uid=uid, capture_fn=lambda pid: IDLE, run_fn=lambda argv, env: (0, "{}"))
    refused = {r["pane"]: r["result"] for r in res["rows"]}
    case("NEG tampered respawn row refused at send time", refused.get("uds--burn-down:0.1") == "REFUSED_FLAGS_NOT_FROM_LIVE_ARGS", json.dumps(refused))

    # --- send gates: dry-run default, approval bound to manifest, busy re-check, env
    live = ["--auto-approve", "--model", "openai-codex/gpt-6-luna", "--thinking", "high"]
    case("CTL reordered live flags are not a false refusal",
         fr.check_cmd_flags("cd /u && omp --model openai-codex/gpt-6-luna --thinking high --auto-approve", live)[0])
    case("NEG dropped --thinking value refused (2026-10-11 uds--burn-down:0.5)",
         not fr.check_cmd_flags("cd /u && omp --model openai-codex/gpt-6-luna --auto-approve", live)[0])
    manifest = fr.restart_manifest(plan, mode="restart")
    case("CTL restart manifest holds only RESTART rows", sorted(r["pane"] for r in manifest["rows"]) == ["modeltest:0.1", "uds--burn-down:0.1"],
         json.dumps([r["pane"] for r in manifest["rows"]]))
    calls = []

    def run(argv, env):
        calls.append((argv, env))
        return 0, '{"success":true}'

    res = fr.send(manifest, apply=False, approval=None, env=good_env, uid=uid, capture_fn=lambda pid: IDLE, run_fn=run)
    case("CTL send default is dry-run (no ntm call)", not calls and res["mode"] == "DRY_RUN")
    res = fr.send(manifest, apply=True, approval=None, env=good_env, uid=uid, capture_fn=lambda pid: IDLE, run_fn=run)
    case("NEG apply without operator approval -> APPROVAL_MISSING", not calls and res.get("refused") == "APPROVAL_MISSING", str(res.get("refused")))
    res = fr.send(manifest, apply=True, approval={"manifest_sha256": "0" * 64, "approved_by": "josh", "quote": "go"}, env=good_env, uid=uid,
                  capture_fn=lambda pid: IDLE, run_fn=run)
    case("NEG approval for a different manifest -> APPROVAL_MISMATCH", not calls and res.get("refused") == "APPROVAL_MISMATCH", str(res.get("refused")))
    approval = {"manifest_sha256": fr.manifest_sha(manifest), "approved_by": "josh", "quote": "restart the fleet"}
    res = fr.send(manifest, apply=True, approval=approval, env={}, uid=uid, capture_fn=lambda pid: IDLE, run_fn=run)
    case("NEG apply with missing TMUX env refused before any send", not calls and res.get("refused") == "TMUX_ENV_MISSING", str(res.get("refused")))
    res = fr.send(manifest, apply=True, approval=approval, env=good_env, uid=uid,
                  capture_fn=lambda pid: BUSY if pid == "%55" else IDLE, run_fn=run)
    by = {r["pane"]: r["result"] for r in res["rows"]}
    sent_panes = [a[a.index("--panes") + 1] if "--panes" in a else next(x for x in a if x.startswith("--panes=")) for a, _ in calls]
    case("NEG pane busy at send time -> QUEUED_BUSY, not sent", by.get("modeltest:0.1") == "QUEUED_BUSY" and "--panes=%55" not in sent_panes, json.dumps(by))
    case("CTL idle approved pane sent with TMUX env and exact ntm flags",
         by.get("uds--burn-down:0.1") == "SENT" and calls and calls[-1][1].get("TMUX_TMPDIR") == good_env["TMUX_TMPDIR"]
         and calls[-1][0][:3] == ["ntm", "send", "uds--burn-down"] and "--no-cass-check" in calls[-1][0] and "--force-non-interactive" in calls[-1][0]
         and calls[-1][0][-1] == "/restart", json.dumps(calls[-1][0]) if calls else "no call")

    # --- verify after /restart
    def restarted(inv, mcp_version="6.4.0"):
        """/restart re-execs omp in place (same pid) and respawns its MCP children (new pids)."""
        for p in inv["procs"]:
            if p["pid"] in (102, 302):
                p["pid"] += 1000
                p["args"] = "npm exec rea-agents@%s mcp" % mcp_version
            if p["pid"] == 301:
                p["args"] = CLI + " --profile muse --model muse-code/muse-spark-1.3-contributor --thinking high --auto-approve --resume NEWID"
        return inv

    v = {r["pane"]: r for r in fr.verify(plan, restarted(inventory()), expect_mcp={"rea-agents": "6.4.0"}, mode="restart")["rows"]}
    case("CTL verify: same pid, new MCP child, flags equal ignoring --resume, MCP 6.4.0, idle -> VERIFIED",
         v["uds--burn-down:0.1"]["result"] == "VERIFIED" and v["modeltest:0.1"]["result"] == "VERIFIED", json.dumps(v)[:300])
    untouched = inventory()
    for p in untouched["procs"]:
        if p["pid"] in (102, 302):
            p["args"] = "npm exec rea-agents@6.4.0 mcp"
    v = {r["pane"]: r for r in fr.verify(plan, untouched, expect_mcp={"rea-agents": "6.4.0"}, mode="restart")["rows"]}
    case("NEG verify: MCP child pid unchanged -> FAILED (no restart observed)",
         v["modeltest:0.1"]["result"] == "FAILED" and any("no restart observed" in w for w in v["modeltest:0.1"]["why"]), json.dumps(v["modeltest:0.1"]))
    v = {r["pane"]: r for r in fr.verify(plan, restarted(inventory(), "6.3.0"), expect_mcp={"rea-agents": "6.4.0"}, mode="restart")["rows"]}
    case("NEG verify: MCP child still 6.3.0 -> FAILED mcp", v["modeltest:0.1"]["result"] == "FAILED" and any(w.startswith("mcp ") for w in v["modeltest:0.1"]["why"]), json.dumps(v["modeltest:0.1"]))
    lost = restarted(inventory())
    for p in lost["procs"]:
        if p["pid"] == 301:
            p["args"] = OMP + " --model muse-code/muse-spark-1.3-contributor"
    v = {r["pane"]: r for r in fr.verify(plan, lost, expect_mcp={"rea-agents": "6.4.0"}, mode="restart")["rows"]}
    case("NEG verify: flags lost after restart -> FAILED flags", v["uds--burn-down:0.1"]["result"] == "FAILED" and any(w.startswith("flags ") for w in v["uds--burn-down:0.1"]["why"]), json.dumps(v["uds--burn-down:0.1"]))
    v = fr.verify(plan, restarted(inventory()), expect_mcp={"rea-agents": "6.4.0"}, mode="restart", sent={"uds--burn-down:0.1"})
    case("CTL verify --sent-log scope: only SENT panes counted", [r["pane"] for r in v["rows"]] == ["uds--burn-down:0.1"], json.dumps([r["pane"] for r in v["rows"]]))

    # --- re-dispatch messages are staged, directors first, never sent by staging
    staged_dir = os.path.join(tmp, "staged")
    msgs = fr.messages_manifest(plan, handoff="/h.md", snapshot_dir="/snap", kit_version="0.2.20", out_dir=staged_dir, directors=["modeltest:0.1"])
    roles = [r["role"] for r in msgs["rows"]]
    case("CTL messages staged as files, directors before workers",
         roles == ["director", "worker"] and all(os.path.isfile(r["file"]) for r in msgs["rows"]),
         json.dumps(roles))
    director_text = next(open(r["file"]).read() for r in msgs["rows"] if r["role"] == "director")
    case("CTL director message orders HEALTH > INTEGRATE > DISPATCH with one callback grammar",
         director_text.index("HEALTH") < director_text.index("INTEGRATE") < director_text.index("DISPATCH") and "DONE|BLOCKED <bead> <sha> <evidence>; NEXT <item>" in director_text)
    try:
        fr.messages_manifest(plan, handoff="/h.md", snapshot_dir="/snap", kit_version="0.2.20", out_dir=os.path.join(tmp, "nodirs"), directors=None)
        code = "NO_ERROR"
    except ValueError as exc:
        code = str(exc).split(":", 1)[0]
    case("NEG messages without operator-named directors -> DIRECTORS_REQUIRED", code == "DIRECTORS_REQUIRED", code)
    with open(msgs["rows"][0]["file"], "a") as fh:
        fh.write("also restart everything\n")
    approval = {"manifest_sha256": fr.manifest_sha(msgs), "approved_by": "josh", "quote": "send them"}
    calls.clear()
    res = fr.send(msgs, apply=True, approval=approval, env=good_env, uid=uid, capture_fn=lambda pid: IDLE, run_fn=run)
    by = {r["pane"]: r["result"] for r in res["rows"]}
    case("NEG staged message edited after approval -> refused, not sent",
         by.get("modeltest:0.1") == "REFUSED_FILE_CHANGED_AFTER_APPROVAL" and all("--panes=%55" not in a for a, _ in calls), json.dumps(by))
    case("CTL unchanged staged worker message sent via --file", by.get("uds--burn-down:0.1") == "SENT" and calls and "--file" in calls[-1][0], json.dumps(by))

    print("selftest: %s (%d failing)" % ("PASS" if not FAILS else "FAIL", len(FAILS)))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
