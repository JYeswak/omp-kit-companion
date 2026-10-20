#!/usr/bin/env python3
"""Selftest for fleet_restart.py: every gate must fire on a planted negative
and pass its paired control. Run from this directory: python3 selftest.py
(requires an owned repo var/agent-tmp TMPDIR). Planted negatives include busy panes, dropped flags,
missing TMUX env, stale plugin links, unsafe sends and advisor loss."""
import json
import os
import subprocess
import sys
import tempfile
import time

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
OMP = "bun ~/.bun/bin/omp"
CLI = "/opt/homebrew/Cellar/bun/1.3.8/bin/bun ~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"
WORKER = CLI + " __omp_worker_daemon_broker"


def inventory():
    panes = [
        # Sonnet worker launched bare: no --profile, model only in args/screen.
        {"pane": "modeltest:0.1", "pane_id": "%55", "pane_pid": 100, "cwd": "~/Developer/modeltest", "screen": SONNET_IDLE},
        # director busy mid-turn.
        {"pane": "control-plane:0.1", "pane_id": "%17", "pane_pid": 200, "cwd": "~/Developer/uds", "screen": BUSY},
        # re-exec'd omp (cli.js shape) with --thinking/--auto-approve flags.
        {"pane": "uds--burn-down:0.1", "pane_id": "%36", "pane_pid": 300, "cwd": "~/Developer/uds", "screen": IDLE},
        # protected pane.
        {"pane": "uds--burn-down:0.0", "pane_id": "%31", "pane_pid": 400, "cwd": "~/Developer/uds", "screen": IDLE},
        # chief pane.
        {"pane": "omp-test:0.1", "pane_id": "%3", "pane_pid": 500, "cwd": "~/Developer/omp-test", "screen": IDLE},
        # plain shell with only a stray worker-daemon descendant.
        {"pane": "jev:0.0", "pane_id": "%19", "pane_pid": 600, "cwd": "~/Developer/jev", "screen": ["%"]},
        # agent whose cwd is forbidden.
        {"pane": "modeltest:0.2", "pane_id": "%4", "pane_pid": 700, "cwd": "/private/tmp", "screen": IDLE},
        # idle agent with a long-running git child (rz5.101.1).
        {"pane": "cfs:0.2", "pane_id": "%8", "pane_pid": 800, "cwd": "~/Developer/cfs", "screen": IDLE},
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
        {"pid": 800, "ppid": 1, "args": "-zsh"},
        {"pid": 801, "ppid": 800, "args": OMP + " --profile claude"},
        {"pid": 802, "ppid": 801, "args": "git status"},
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
    # Scratch is explicit and must already be owned by this run; never fall
    # back to Python's system temp directory or create an unmanaged root.
    base = os.path.abspath(os.environ.get("TMPDIR", ""))
    marker = os.sep + "var" + os.sep + "agent-tmp" + os.sep
    if (not base or os.path.realpath(base) != base or marker not in base + os.sep
            or not os.path.isdir(base) or not os.path.isfile(os.path.join(base, ".owner"))):
        print("TMPDIR must be an owned repo var/agent-tmp directory", file=sys.stderr)
        return 2
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(base)))
    tmp = tempfile.mkdtemp(prefix="fleet-restart-selftest.%d." % os.getpid(), dir=base)
    with open(os.path.join(tmp, ".owner"), "w") as owner:
        owner.write("pid=%s\nlabel=fleet-restart-selftest\nrepo=%s\ncreated=%s\n" %
                    (os.getpid(), repo_root, time.strftime("%Y-%m-%dT%H:%M:%S%z")))
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
    case("NEG pane with running git child -> SKIP_GIT with reason", rows["cfs:0.2"]["action"] == "SKIP_GIT" and "802" in rows["cfs:0.2"].get("reason", ""), rows["cfs:0.2"].get("action") + " " + rows["cfs:0.2"].get("reason", ""))
    case("CTL same pane shape without git child still restarts", rows["modeltest:0.1"]["action"] == "RESTART", rows["modeltest:0.1"]["action"])
    # --- busy pane never restarted
    case("NEG busy pane -> QUEUE_BUSY", rows["control-plane:0.1"]["action"] == "QUEUE_BUSY", rows["control-plane:0.1"]["action"])
    case("NEG protected pane -> SKIP_PROTECTED", rows["uds--burn-down:0.0"]["action"] == "SKIP_PROTECTED", rows["uds--burn-down:0.0"]["action"])
    case("NEG chief pane -> SKIP_CHIEF", rows["omp-test:0.1"]["action"] == "SKIP_CHIEF", rows["omp-test:0.1"]["action"])
    case("NEG /private/tmp cwd -> HOLD_CWD", rows["modeltest:0.2"]["action"] == "HOLD_CWD", rows["modeltest:0.2"]["action"])
    # --- Tern compiled omp (measured ps shapes 2026-10-11): an agent by its own first token or versioned path
    tern = "/Users/Shared/Library/Application Support/Tern/omp/versions/18.9.2"
    for args, want in [("omp --profile codex --model gpt-6-luna", ["--profile", "codex", "--model", "gpt-6-luna"]),
                       ("/opt/homebrew/bin/omp -p --profile claude", ["-p", "--profile", "claude"]),
                       (tern + " --profile muse --thinking high", ["--profile", "muse", "--thinking", "high"]),
                       ("omp", [])]:
        got = fr.omp_match(args)
        case("CTL Tern compiled omp detected, flags kept: %s" % args[:40], got == want, json.dumps(got))
    for args in ["zsh -lc cd ~/Developer/jev && omp --profile glm; exec zsh -l",
                 "omp-kit status --json", "/opt/homebrew/bin/omp-kit test", "omp __omp_worker_daemon_broker",
                 tern + "-rc.1 --profile x", "grep omp", tern.replace("/Tern/", "/Other/") + " --profile x"]:
        case("NEG not an omp agent: %s" % args[:48], fr.omp_match(args) is None, json.dumps(fr.omp_match(args)))
    t0 = time.perf_counter()
    fr.omp_match("x " + "bun " * 20000 + "/x/.bun/bin/ompz")
    case("NEG long near-miss process line stays fast", time.perf_counter() - t0 < 0.05, "%.4fs" % (time.perf_counter() - t0))
    case("NEG unknown screen state -> HOLD_UNKNOWN_STATE", fr.parse_screen(["garbage"])["state"] == "UNKNOWN")
    case("NEG old omp status in shell scrollback is not read as IDLE", fr.parse_screen(SHELL_WITH_OLD_STATUS)["state"] == "UNKNOWN",
         str(fr.parse_screen(SHELL_WITH_OLD_STATUS)))
    case("CTL boxed ' > ' status bar parsed (state, model)", fr.parse_screen(SONNET_IDLE) == {"state": "IDLE", "model": "Sonnet 5.5"},
         str(fr.parse_screen(SONNET_IDLE)))

    # --- screen-rebuilt command refused (respawn fallback copies live args only)
    row = dict(rows["uds--burn-down:0.1"])
    good_cmd = fr.respawn_cmd(row)
    case("CTL respawn cmd from live args passes flag check", fr.check_cmd_flags(good_cmd, row["flags"])[0], good_cmd)
    screen_cmd = "cd ~/Developer/uds && omp --model muse-code/muse-spark-1.3-contributor"
    ok, code = fr.check_cmd_flags(screen_cmd, row["flags"])
    case("NEG screen-rebuilt respawn cmd -> FLAGS_NOT_FROM_LIVE_ARGS", not ok and code == "FLAGS_NOT_FROM_LIVE_ARGS", code)
    save_fixture = {"rows": [{"pane_id": r["pane_id"], "session_file": "/s/sessions/-x/%s.jsonl" % r["pane_id"][1:], "holds": [],
                              "advisor": {"on": False, "source": "runtime"}} for r in plan["rows"] if r["action"] == "RESTART"]}
    tampered = fr.restart_manifest(plan, mode="respawn", save=save_fixture)
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
    case("CTL staged director text follows tick order, VALIDATE before INTEGRATE",
         [director_text.index(p) for p in ("INIT", "RESEARCH", "PLAN", "BEADS", "DISPATCH", "VALIDATE", "INTEGRATE", "LEARN")]
         == sorted(director_text.index(p) for p in ("INIT", "RESEARCH", "PLAN", "BEADS", "DISPATCH", "VALIDATE", "INTEGRATE", "LEARN"))
         and "DONE|BLOCKED <bead> <sha> <evidence>; NEXT <item>" in director_text)
    case("NEG staged director text leads with INTEGRATE before VALIDATE",
         "VALIDATE" in director_text and director_text.index("VALIDATE") < director_text.index("INTEGRATE")
         and director_text.index("DISPATCH") < director_text.index("VALIDATE"),
         director_text.replace("\n", " | "))
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
    target = "/Tern/omp/versions/18.10.4"
    shell = fr.derive_pane_state("ntm", "jev:0.1", "%1", None, "/bin/zsh", target, "", [])
    case("NEG pane shell txt is not an agent state", shell["state"] == "NO_OMP" and shell["action"] == "SKIP_SHELL" and shell["exe"] == "/bin/zsh")
    worker = fr.herdr_agent({"foreground_processes": [{"pid": 1, "argv": ["/Tern/omp/versions/18.9.2", "__omp_worker_mnemopi_embed"]}]})
    case("NEG __omp_worker is not the herdr agent", worker is None)
    omp = fr.herdr_agent({"foreground_processes": [
        {"pid": 1, "argv": ["/Tern/omp/versions/18.9.2", "__omp_worker_mnemopi_embed"]},
        {"pid": 2, "argv": ["omp", "--profile", "muse"]}]})
    case("CTL herdr omp child is the agent, worker ignored", omp["pid"] == 2 and "--profile" in omp["flags"] and "muse" in omp["flags"])
    stale = fr.derive_pane_state("herdr", "w2:p1", "w2:p1", 2, "/Tern/omp/versions/18.9.2", target, "w4:p1", ["--profile", "muse"], "idle")
    case("NEG different executable is RESPAWN, not RESTART", stale["surface"] == "herdr" and stale["state"] == "STALE" and stale["action"] == "RESPAWN")
    current = fr.derive_pane_state("ntm", "jev:0.1", "%1", 9, target, target, "w4:p1", ["--profile", "codex"])
    case("CTL same executable on ntm is CURRENT", current["state"] == "CURRENT" and current["action"] == "CURRENT" and current["surface"] == "ntm")
    chief = fr.derive_pane_state("herdr", "w4:p1", "w4:p1", 9, target, target, ["w4:p1"], ["--profile", "grok"])
    case("CTL chief stays SKIP_CHIEF when already on the target", chief["action"] == "SKIP_CHIEF" and chief["state"] == "CURRENT")
    both = fr.herdr_states_from(
        [{"pane_id": "w2:p1", "agent_status": "idle", "agent_session": {"value": "/s.jsonl"}}],
        {"w2:p1": {"foreground_processes": [{"pid": 2, "argv": ["omp", "--resume=/s.jsonl"]}]}},
        lambda pid: "/Tern/omp/versions/18.9.2", target, "w4:p1")
    case("CTL herdr derivation keeps the session file and marks a stale build RESPAWN",
         both[0]["session_file"] == "/s.jsonl" and both[0]["action"] == "RESPAWN" and both[0]["surface"] == "herdr")
    argv_resume = fr.herdr_states_from(
        [{"pane_id": "w2:p1", "agent_status": "idle"}],
        {"w2:p1": {"foreground_processes": [{"pid": 2, "argv": ["omp", "--profile", "muse", "--resume", "/s.jsonl"]}]}},
        lambda pid: target, target, "w4:p1")
    case("CTL herdr session file comes from argv when agent_session is empty",
         argv_resume[0]["session_file"] == "/s.jsonl" and argv_resume[0]["action"] == "CURRENT")

    # --- 2026-10-11 flag-loss replay (ompkit-fp72.19 AC [b]): handoff
    # docs/handoffs/fleet-restart-20261011.md ("What was restarted", step-1
    # defect) in omp-kit. Seven commands rebuilt from the on-screen model
    # dropped live flags; six carried an omp argv, the seventh
    # (uds--burn-down:0.1) a worker-daemon argv that is never an agent.
    replay_rows = [("uds--burn-down:0.%d" % i, ["--profile", "codex", "--model", "openai-codex/gpt-6-luna", "--thinking", "high"])
                    for i in range(2, 7)]
    replay_rows.append(("zestroku:0.1", ["--profile", "claude", "--model", "anthropic/claude-sonnet-5-5"]))
    for pane, live in replay_rows:
        model = live[live.index("--model") + 1]
        ok, code = fr.check_cmd_flags("cd /_UNUSED_ && omp --model " + model, live)
        case("REPLAY 1011 %s screen-built cmd refused" % pane, not ok and code == "FLAGS_NOT_FROM_LIVE_ARGS", code)
        ok, code = fr.check_cmd_flags("cd /_UNUSED_ && omp " + " ".join(live), live)
        case("CTL 1011 %s live flags accepted" % pane, ok, code)
    case("REPLAY 1011 uds--burn-down:0.1 worker argv is not an agent", fr.omp_match(WORKER) is None)
    case("REPLAY 1011 uds--burn-down:0.1 find_agent finds no agent",
         fr.find_agent([{"pid": 900, "ppid": 111, "args": WORKER},
                        {"pid": 901, "ppid": 900, "args": "node mcp-server.js rea-agents"}], 111) is None)
    import selftest_run  # noqa: E402  (watchers, save, advisor, respawn, autonomous run gates)
    selftest_run.gates(case, tmp, uid, good_env, plan, aligned, inventory, IDLE)
    selftest_run.gates_native(case, tmp, uid)  # opt-in isolated native LaunchAgent exercise (ompkit-rhy9.3)

    print("selftest: %s (%d failing)" % ("PASS" if not FAILS else "FAIL", len(FAILS)))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
