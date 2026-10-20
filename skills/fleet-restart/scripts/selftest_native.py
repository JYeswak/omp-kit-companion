#!/usr/bin/env python3
"""Opt-in native OMP/Tmux proof for fleet-restart advisor recovery.

All OMP panes, HOME/profile files, Git worktree, and the Tmux socket live under
an owned test root. LaunchAgent and global scratch-reaper calls are intercepted;
no installed service or fleet pane is touched.
"""
import argparse
import json
import os
import shlex
import shutil
import signal
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "scripts"))
import pysafe  # noqa: E402  (bounded child runs: process-group kill on timeout)
import fleet_restart as core  # noqa: E402
import fr_run  # noqa: E402
import fr_save  # noqa: E402
import fr_watchers as fw  # noqa: E402


class IsolatedLaunchd:
    """In-memory launchd domain; the test must never call the host launchd."""

    def __init__(self):
        self.loaded = set()
        self.calls = []

    def run(self, argv):
        self.calls.append(list(argv))
        verb = argv[1] if len(argv) > 1 else ""
        if verb == "print":
            label = argv[-1].split("/")[-1]
            if label in self.loaded:
                return 0, "isolated service loaded"
            return 113, "isolated service not loaded"
        if verb == "bootout":
            self.loaded.discard(argv[-1].split("/")[-1])
            return 0, "isolated bootout"
        if verb == "bootstrap":
            label = argv[-1]
            try:
                import plistlib
                with open(label, "rb") as handle:
                    label = plistlib.load(handle)["Label"]
            except (OSError, ValueError, KeyError):
                return 1, "invalid isolated plist"
            self.loaded.add(label)
            return 0, "isolated bootstrap"
        if verb == "disable":
            return 0, "isolated disable"
        return 1, "unexpected isolated launchctl command"


def _run(argv, env, timeout=60):
    """Bounded run: merged output, stdin /dev/null, whole process group killed
    on timeout (124, never an exception; _checked turns it into an error)."""
    res = pysafe.run_bounded(argv, timeout, env=env, merge_stderr=True)
    return (res.returncode if res.returncode is not None else 124), res.text()


def _checked(argv, env, timeout=60):
    rc, output = _run(argv, env, timeout=timeout)
    if rc != 0:
        raise RuntimeError("%s exited %d: %s" % (shlex.join(argv), rc, output[-1000:]))
    return output.strip()


def _append_jsonl(path, row):
    with open(path, "a") as handle:
        handle.write(json.dumps(row, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def _write_json(path, value):
    with open(path, "w") as handle:
        json.dump(value, handle, indent=1, ensure_ascii=False)
        handle.write("\n")


def _context(config, *, mask_badge_reads=0):
    tmux_env = config["tmux_env"]
    process_env = config["process_env"]
    launchd = IsolatedLaunchd()
    effects_path = config["effects_path"]
    receipt_marker = config["receipt_marker"]
    runtime_pane = config.get("runtime_pane")
    real_capture = core.capture_live(tmux_env)
    mask = {"remaining": mask_badge_reads}

    def capture(pane_id):
        lines = real_capture(pane_id)
        if pane_id == runtime_pane and os.path.isfile(receipt_marker) and mask["remaining"] > 0:
            mask["remaining"] -= 1
            return [line.replace(" 👁", "") for line in lines]
        return lines

    def run(argv, env=None):
        if argv and argv[0] == "launchctl":
            return launchd.run(argv)
        if argv[:3] == ["omp-kit", "scratch", "apply"]:
            _append_jsonl(effects_path, {"kind": "isolated-scratch-reaper-noop", "argv": argv})
            return 0, '{"isolated_test_noop":true}'
        run_env = env or process_env
        res = pysafe.run_bounded(argv, 60, env=run_env, merge_stderr=True)
        rc, output = (res.returncode if res.returncode is not None else 124), res.text()
        if argv and argv[0] == "ntm":
            _append_jsonl(effects_path, {"kind": "ntm", "argv": argv, "rc": rc, "output": output[-1000:]})
            if rc == 0 and argv[-1] == "/advisor on":
                with open(receipt_marker, "w") as handle:
                    handle.write("ntm /advisor on returned exit 0\n")
                    handle.flush()
                    os.fsync(handle.fileno())
        return rc, output

    ctx = fr_run.Ctx(
        env=tmux_env,
        uid=os.getuid(),
        home=config["home"],
        agents_dir=config["agents_dir"],
        registry=fw.load_registry(config["registry_path"]),
        run_fn=run,
        capture_fn=capture,
        inventory_fn=lambda only=None: core.live_inventory(tmux_env, only=only),
        snapshot_fn=lambda out_dir: _snapshot(out_dir, tmux_env),
        lsof_fn=fr_save.lsof_live(core.run),
        align_fn=lambda: {"ok": True, "version": config["kit_version"], "expected": config["kit_version"], "stale": []},
        preflight_fn=lambda: (True, "selftest: PASS (isolated native advisor test)"),
        target_fn=lambda: {"ok": True, "path": config["omp_real"], "version": config["omp_version"], "which": config["omp_path"]},
        sleep_fn=time.sleep,
        clock_fn=time.time,
        verify_timeout=45,
        verify_poll=1,
        verify_settle=1,
        advisor_grace=4,
        advisor_timeout=30,
        advisor_poll=1,
        busy_poll=1,
        parallel=False,
        releases=config["home"],
        version=config["kit_version"],
    )
    ctx.herdr_fn = lambda target, chief: {"ok": True, "rows": []}
    # ompkit-rhy9.6: the run approval binds exact executable bytes (rhy9.5), so
    # the native harness reports them too; additive wrapper, no landed line touched.
    _native_target_fn = ctx.target_fn
    ctx.target_fn = lambda: dict(_native_target_fn(), bytes_sha256=fr_save.sha256_file(_native_target_fn()["path"]))
    return ctx, launchd


def _snapshot(out_dir, tmux_env):
    os.makedirs(os.path.join(out_dir, "panes"), exist_ok=True)
    inventory = core.live_inventory(tmux_env, lines=core.CAPTURE_LINES, out_dir=out_dir)
    _write_json(os.path.join(out_dir, "inventory.json"), inventory)
    return inventory


def _child_crash(config_path):
    with open(config_path) as handle:
        config = json.load(handle)
    ctx, _ = _context(config)
    approval = config["approval"]
    original_add = fr_run.Ledger.add

    def crash_after_native_advisor_receipt(ledger, event, durable=False, **kw):
        if event == "ADVISOR_SENT":
            os._exit(86)
        return original_add(ledger, event, durable=durable, **kw)

    fr_run.Ledger.add = crash_after_native_advisor_receipt
    fr_run.apply_run(config["run_dir"], ctx, approval, resume_run=False)
    return 0


WIZARD_MARKERS = ("Type to search", "\u2191/\u2193 select")


def _wait_for_ready(tmux, socket, pane_id, condition, description, timeout=240):
    """Readiness wait for a fresh OMP pane: newer builds walk a multi-page
    setup wizard (provider, model, theme) even with setupWizard: false and an
    imported credential. Each page offers a skip key, so dismiss wizard pages
    with Escape until the pane reaches the waited condition. Escape is only
    ever sent while a wizard page is visible, never to a live agent."""
    env = dict(os.environ)
    deadline = time.monotonic() + timeout
    last, skips = "", 0
    while time.monotonic() < deadline:
        rc, last = _run([tmux, "-f", "/dev/null", "-S", socket, "capture-pane", "-p", "-J", "-t", pane_id, "-S", "-30"], env)
        lines = last.splitlines() if rc == 0 else []
        if rc == 0 and condition(lines):
            return lines
        if rc == 0 and any(marker in last for marker in WIZARD_MARKERS):
            _run([tmux, "-f", "/dev/null", "-S", socket, "send-keys", "-t", pane_id, "Escape"], env)
            skips += 1
            time.sleep(5)
            continue
        time.sleep(1)
    raise RuntimeError("timed out waiting for %s (wizard pages skipped: %d); last pane output: %s" % (description, skips, last[-1000:]))


def _wait_for(tmux, socket, pane_id, condition, description, timeout=60):
    env = dict(os.environ)
    deadline = time.monotonic() + timeout
    last = ""
    while time.monotonic() < deadline:
        rc, last = _run([tmux, "-f", "/dev/null", "-S", socket, "capture-pane", "-p", "-J", "-t", pane_id, "-S", "-30"], env)
        if rc == 0 and condition(last.splitlines()):
            return last.splitlines()
        time.sleep(0.1)
    raise RuntimeError("timed out waiting for %s; last pane output: %s" % (description, last[-1000:]))


def _server_pid(socket):
    rc, output = _run(["/usr/sbin/lsof", "-nP", "-t", socket], dict(os.environ), timeout=10)
    if rc != 0:
        return None
    for line in output.splitlines():
        try:
            pid = int(line.strip())
        except ValueError:
            continue
        command_rc, command = _run(["ps", "-p", str(pid), "-o", "command="], dict(os.environ), timeout=10)
        if command_rc == 0 and "tmux" in command:
            return pid
    return None


def _stop_owned_pane(tmux, socket, pane_id):
    _run([tmux, "-f", "/dev/null", "-S", socket, "send-keys", "-t", pane_id, "C-c"], dict(os.environ), timeout=10)


def run_native(case, owned_root):
    """Run real OMP panes and a real ntm send in a private Tmux server."""
    owned_path = os.path.abspath(owned_root or "")
    root = os.path.realpath(owned_path)
    marker = os.sep + "var" + os.sep + "agent-tmp" + os.sep
    if root != owned_path or marker not in root + os.sep or not os.path.isfile(os.path.join(root, ".owner")):
        case("NATIVE advisor test requires an owned repo var/agent-tmp root", False, str(owned_root))
        return
    omp_path = shutil.which("omp")
    tmux = shutil.which("tmux")
    ntm = shutil.which("ntm")
    git = shutil.which("git")
    if not all((omp_path, tmux, ntm, git)):
        case("NATIVE advisor prerequisites are installed", False, json.dumps({"omp": omp_path, "tmux": tmux, "ntm": ntm, "git": git}))
        return
    omp_path, tmux, ntm, git = str(omp_path), str(tmux), str(ntm), str(git)
    native = os.path.join(root, "native-advisor-%d" % os.getpid())
    home = os.path.join(native, "home")
    work = os.path.join(native, "project")
    tmp = os.path.join(native, "tmp")
    tmux_dir = root
    agents_dir = os.path.join(home, "Library", "LaunchAgents")
    os.makedirs(agents_dir, exist_ok=True)
    os.makedirs(work, exist_ok=True)
    os.makedirs(tmp, exist_ok=True)
    os.makedirs(os.path.join(tmux_dir, "tmux-%d" % os.getuid()), exist_ok=True)
    omp_home = os.path.join(home, ".omp")
    os.makedirs(os.path.join(omp_home, "agent"), exist_ok=True)
    with open(os.path.join(omp_home, "agent", "config.yml"), "w") as handle:
        handle.write('disabledProviders:\n- ollama\n- "llama.cpp"\n- lm-studio\nstartup:\n  setupWizard: false\n  checkUpdate: false\nmarketplace:\n  autoUpdate: "off"\n')
    for profile, config_text in (
        ("flag", "disabledProviders:\n- ollama\n- \"llama.cpp\"\n- lm-studio\nstartup:\n  setupWizard: false\n  checkUpdate: false\nmarketplace:\n  autoUpdate: \"off\"\n"),
        ("config", "advisor:\n  enabled: true\ndisabledProviders:\n- ollama\n- \"llama.cpp\"\n- lm-studio\nstartup:\n  setupWizard: false\n  checkUpdate: false\nmarketplace:\n  autoUpdate: \"off\"\n"),
        ("runtime", "disabledProviders:\n- ollama\n- \"llama.cpp\"\n- lm-studio\nstartup:\n  setupWizard: false\n  checkUpdate: false\nmarketplace:\n  autoUpdate: \"off\"\n"),
    ):
        agent_dir = os.path.join(omp_home, "profiles", profile, "agent")
        os.makedirs(agent_dir, exist_ok=True)
        with open(os.path.join(agent_dir, "config.yml"), "w") as handle:
            handle.write(config_text)
        with open(os.path.join(agent_dir, "WATCHDOG.yml"), "w") as handle:
            handle.write("advisors: []\nprofile: %s\n" % profile)
    with open(os.path.join(work, "WATCHDOG.yml"), "w") as handle:
        handle.write("advisors: []\nproject: native-test\n")
    fixture_env = {"HOME": home, "PATH": os.environ.get("PATH", "/opt/homebrew/bin:/usr/bin:/bin"),
                   "TMPDIR": tmp, "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0"}
    _checked([git, "-C", work, "init", "-q"], fixture_env)
    _checked([git, "-C", work, "config", "user.name", "Fleet Restart Selftest"], fixture_env)
    _checked([git, "-C", work, "config", "user.email", "fleet-restart-selftest@example.invalid"], fixture_env)
    _checked([git, "-C", work, "add", "WATCHDOG.yml"], fixture_env)
    _checked([git, "-C", work, "commit", "-q", "-m", "native advisor fixture"], fixture_env)

    probe_env = {"HOME": home, "PATH": os.environ.get("PATH", "/opt/homebrew/bin:/usr/bin:/bin"), "TMPDIR": tmp}
    credential_file = os.path.join(native, "credentials.json")
    _write_json(credential_file, {"version": 1, "credentials": [
        {"provider": "openai", "credential": {"type": "api_key", "key": "native-selftest-no-network"}}
    ]})
    for profile in ("flag", "config", "runtime"):
        _checked([omp_path, "--profile", profile, "auth", "import", credential_file], probe_env)
    version = _checked([omp_path, "--version"], probe_env)
    version = version.split("/")[-1].strip()
    omp_real = os.path.realpath(omp_path)
    session = "fr-advisor-%d" % os.getpid()
    socket = os.path.join(tmux_dir, "tmux-%d" % os.getuid(), "default")
    base_env = {
        "HOME": home,
        "XDG_CONFIG_HOME": os.path.join(home, ".config"),
        "XDG_CACHE_HOME": os.path.join(home, ".cache"),
        "XDG_DATA_HOME": os.path.join(home, ".local", "share"),
        "XDG_STATE_HOME": os.path.join(home, ".local", "state"),
        "TMPDIR": tmp,
        "TMP": tmp,
        "TMUX_TMPDIR": tmux_dir,
        "PATH": os.environ.get("PATH", "/opt/homebrew/bin:/usr/bin:/bin"),
        "LANG": "C.UTF-8",
        "TERM": "xterm-256color",
    }
    for key in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OLLAMA_HOST", "TMUX", "TMUX_PANE"):
        base_env.pop(key, None)
    server_pid = None
    server_started = False
    tmux_env = {}
    pane_ids = {}
    omp_pids = set()
    old_env = dict(os.environ)
    os.environ.clear()
    os.environ.update(base_env)
    try:
        server_started = True
        _checked([tmux, "-f", "/dev/null", "-S", socket, "new-session", "-d", "-s", session, "-n", "control", "-c", work, "sleep 3600"], base_env)
        server_pid = _server_pid(socket)
        if server_pid is None:
            raise RuntimeError("could not record private tmux server pid from its socket")
        for profile, extra in (("flag", ["--advisor"]), ("config", []), ("runtime", [])):
            args = ["env"] + ["%s=%s" % (key, value) for key, value in base_env.items()] + [
                omp_real, "--profile", profile, "--model", "openai/gpt-5.2"] + extra
            command = shlex.join(args) + "; exec zsh -l"
            _checked([tmux, "-f", "/dev/null", "-S", socket, "new-window", "-t", session, "-n", profile, "-c", work, command], base_env)
            pane_ids[profile] = _checked([tmux, "-f", "/dev/null", "-S", socket, "display-message", "-p", "-t", "%s:%s.0" % (session, profile), "#{pane_id}"], base_env)
        control_pane = _checked([tmux, "-f", "/dev/null", "-S", socket, "display-message", "-p", "-t", "%s:control.0" % session, "#{pane_id}"], base_env)
        # Record the exact private connection tuple; Tmux clients and ntm must not attach to the live fleet.
        tmux_value = "%s,%s,%s" % (socket, server_pid, control_pane)
        tmux_env = dict(base_env, TMUX=tmux_value)
        for profile in ("flag", "config", "runtime"):
            want_badge = profile != "runtime"
            _wait_for_ready(tmux, socket, pane_ids[profile],
                      lambda lines, want=want_badge: core.parse_screen(lines)["state"] == "IDLE" and core.advisor_badge(lines) is want,
                      "%s profile ready with badge=%s" % (profile, want_badge))
        # This is our own private test pane; no fleet or other owner's pane is targeted.
        _checked([tmux, "-f", "/dev/null", "-S", socket, "send-keys", "-t", pane_ids["runtime"], "/advisor on", "Enter"], base_env)
        _wait_for(tmux, socket, pane_ids["runtime"], lambda lines: core.parse_screen(lines)["state"] == "IDLE" and core.advisor_badge(lines), "runtime advisor activation")

        env = dict(tmux_env)
        effects_path = os.path.join(native, "ntm-effects.jsonl")
        receipt_marker = os.path.join(native, "advisor-on-receipt")
        context_config = {"home": home, "agents_dir": agents_dir, "registry_path": fw.REGISTRY_PATH,
                          "omp_path": omp_path, "omp_real": omp_real, "omp_version": version,
                          "kit_version": "native-test", "tmux_env": env, "process_env": dict(base_env),
                          "effects_path": effects_path, "receipt_marker": receipt_marker}
        ctx, launchd = _context(context_config)
        inventory = core.live_inventory(env)
        saved = fr_save.save(inventory, home, ctx.lsof_fn, ctx.run_fn)
        omp_pids.update(int(row["omp_pid"]) for row in saved["rows"] if row.get("omp_pid"))
        saved_by_pane = {row["pane_id"]: row for row in saved["rows"]}
        expected = {"flag": "flag", "config": "config", "runtime": "runtime"}
        state_rows = {}
        for profile, pane_id in pane_ids.items():
            row = saved_by_pane.get(pane_id)
            if not row:
                pane = next((item for item in inventory["panes"] if item["pane_id"] == pane_id), None)
                descendants = core.descendants(inventory["procs"], pane["pane_pid"]) if pane else []
                observed = [{"depth": depth, "pid": proc["pid"], "ppid": proc["ppid"], "args": proc["args"]}
                            for depth, proc in descendants]
                raise RuntimeError(
                    "native save omitted OMP pane %s (%s): %s" %
                    (profile, pane_id, json.dumps({"pane": pane, "descendants": observed}))
                )
            advisor = row["advisor"]
            watchdogs = advisor.get("watchdog_files") or []
            state_rows[profile] = {"pane": row["pane"], "pane_id": pane_id, "advisor": advisor}
            if not advisor.get("on") or advisor.get("source") != expected[profile] or not watchdogs:
                raise RuntimeError("native snapshot mismatch for %s: %s" % (profile, json.dumps(advisor)))
        case("NATIVE isolated flag/config/runtime panes save badge, source and WATCHDOG digests",
             all(state_rows[name]["advisor"]["on"] and state_rows[name]["advisor"]["source"] == expected[name]
                 and state_rows[name]["advisor"].get("watchdog_files") for name in expected), json.dumps(state_rows))

        # Apply a normal restart to flag/config panes; their advisors should remain loaded without a send.
        kept_dir = os.path.join(native, "flag-config-run")
        flag_config_ids = [pane_ids["flag"], pane_ids["config"]]
        manifest = fr_run.plan_run(kept_dir, ctx, control_pane, core.DEFAULT_PROTECT, wave=2, busy_timeout_min=1,
                                   only=flag_config_ids)
        approval = {"manifest_sha256": core.manifest_sha(manifest), "approved_by": "selftest-native",
                    "quote": "isolated private OMP panes only"}
        report, rc = fr_run.apply_run(kept_dir, ctx, approval)
        kept = {row["pane"]: row for row in report["panes"]}
        kept_evidence = {row["pane_id"]: row for row in report.get("advisor_evidence", [])}
        effect_rows = [json.loads(line) for line in open(effects_path) if line.strip()]
        advisor_sends = [row for row in effect_rows
                         if row.get("kind") == "ntm" and row.get("argv", [])[-1:] == ["/advisor on"]]
        evidence_ok = all(
            kept_evidence.get(pane_ids[name], {}).get("badge_before") is True
            and kept_evidence[pane_ids[name]].get("source") == expected[name]
            and kept_evidence[pane_ids[name]].get("watchdog_files") == state_rows[name]["advisor"]["watchdog_files"]
            and kept_evidence[pane_ids[name]].get("result") == "ADVISOR_KEPT"
            for name in ("flag", "config")
        )
        case("NATIVE flag/config advisors survive /restart with source, WATCHDOG hashes and no /advisor on",
             rc == 0 and len(kept) == 2 and all(row.get("advisor") == "ADVISOR_KEPT" for row in kept.values())
             and evidence_ok and not advisor_sends,
             json.dumps({"rc": rc, "panes": kept, "evidence": kept_evidence, "advisor_sends": advisor_sends,
                         "launchd_calls": launchd.calls}))
        case("NATIVE isolated run boundary: zero global scratch/reaper effects after the sends",
             not [row for row in effect_rows if row.get("kind") == "isolated-scratch-reaper-noop"],
             json.dumps([row.get("kind") for row in effect_rows]))

        # Crash a child after real ntm returned /advisor on, before ADVISOR_SENT is appended.
        crash_dir = os.path.join(native, "runtime-crash-run")
        manifest = fr_run.plan_run(crash_dir, ctx, control_pane, core.DEFAULT_PROTECT, wave=1, busy_timeout_min=1,
                                   only=[pane_ids["runtime"]])
        crash_approval = {"manifest_sha256": core.manifest_sha(manifest), "approved_by": "selftest-native",
                          "quote": "isolated private OMP pane only"}
        crash_config = dict(context_config, run_dir=crash_dir, approval=crash_approval, runtime_pane=pane_ids["runtime"])
        crash_config_path = os.path.join(native, "crash-run.json")
        _write_json(crash_config_path, crash_config)
        child_env = dict(base_env, PYTHONDONTWRITEBYTECODE="1", PYTHONPATH=HERE)
        child = pysafe.run_bounded([sys.executable, __file__, "--crash-run", crash_config_path], 120, env=child_env)
        ledger_path = os.path.join(crash_dir, fr_run.LEDGER)
        events = fr_run.Ledger(ledger_path, time.time).events()
        intents = [row for row in events if row["event"] == "ADVISOR_INTENT"]
        receipts = [row for row in events if row["event"] == "ADVISOR_SENT"]
        effect_rows = [json.loads(line) for line in open(effects_path) if line.strip()]
        advisor_effects = [row for row in effect_rows if row.get("kind") == "ntm" and row.get("argv", [])[-1:] == ["/advisor on"]]
        case("NATIVE crash boundary: real ntm /advisor on receipt follows fsynced intent and precedes result ledger",
             child.returncode == 86 and len(intents) == 1 and not receipts and len(advisor_effects) == 1
             and advisor_effects[0]["rc"] == 0 and intents[0].get("source") == "runtime"
             and intents[0].get("watchdog_files") == state_rows["runtime"]["advisor"].get("watchdog_files"),
             json.dumps({"child_rc": child.returncode, "intent": intents, "receipts": receipts, "ntm": advisor_effects}))
        if child.returncode != 86:
            raise RuntimeError("native crash hook did not exit at the advisor receipt boundary: rc=%r %s" % (child.returncode, child.text("stderr")[-1000:]))

        resume_config = dict(context_config, runtime_pane=pane_ids["runtime"])
        ctx_resume, launchd_resume = _context(resume_config, mask_badge_reads=3)
        report, rc = fr_run.apply_run(crash_dir, ctx_resume, crash_approval, resume_run=True)
        exported = _read_json(os.path.join(crash_dir, "report.json"))
        evidence = next((row for row in exported.get("advisor_evidence", []) if row["pane_id"] == pane_ids["runtime"]), {})
        events = fr_run.Ledger(ledger_path, time.time).events()
        effect_rows = [json.loads(line) for line in open(effects_path) if line.strip()]
        advisor_effects = [row for row in effect_rows if row.get("kind") == "ntm" and row.get("argv", [])[-1:] == ["/advisor on"]]
        live_screen = _wait_for(tmux, socket, pane_ids["runtime"], lambda lines: core.advisor_badge(lines), "runtime badge after resume")
        case("NATIVE --resume-run reconciles delayed badge without a second advisor send",
             rc == 0 and report.get("failed") == [] and len(advisor_effects) == 1
             and evidence.get("badge_before") is True and evidence.get("source") == "runtime"
             and evidence.get("watchdog_files") == state_rows["runtime"]["advisor"].get("watchdog_files")
             and evidence.get("result") == "ADVISOR_RESTORED"
             and sum(1 for row in events if row["event"] == "ADVISOR_INTENT") == 1,
             json.dumps({"rc": rc, "evidence": evidence, "advisor_sends": len(advisor_effects),
                         "badge_observed": core.advisor_badge(live_screen), "launchd_calls": len(launchd_resume.calls)}))
    except Exception as exc:
        case("NATIVE isolated advisor restart completes", False, "%s: %s" % (type(exc).__name__, exc))
    finally:
        if server_started:
            for pane_id in pane_ids.values():
                _stop_owned_pane(tmux, socket, pane_id)
            for pid in sorted(omp_pids):
                try:
                    os.kill(pid, signal.SIGTERM)
                except OSError:
                    pass
            if server_pid is not None:
                try:
                    os.kill(server_pid, signal.SIGTERM)
                except OSError:
                    pass
            else:
                _run([tmux, "-f", "/dev/null", "-S", socket, "kill-server"], base_env, timeout=10)
        os.environ.clear()
        os.environ.update(old_env)


def _read_json(path):
    with open(path) as handle:
        return json.load(handle)


def _crash_run(config_path):
    config = _read_json(config_path)
    ctx, _ = _context(config)
    original_add = fr_run.Ledger.add

    def crash_after_native_receipt(ledger, event, durable=False, **kw):
        if event == "ADVISOR_SENT":
            os._exit(86)
        return original_add(ledger, event, durable=durable, **kw)

    fr_run.Ledger.add = crash_after_native_receipt
    fr_run.apply_run(config["run_dir"], ctx, config["approval"], resume_run=False)
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--crash-run", metavar="CONFIG")
    parser.add_argument("--root")
    args = parser.parse_args(argv)
    if args.crash_run:
        return _crash_run(args.crash_run)
    if not args.root:
        parser.error("--root is required")
    failures = []

    def report(name, passed, detail=""):
        print("%s %s" % ("PASS" if passed else "FAIL", name))
        if detail:
            print(detail)
        if not passed:
            failures.append(name)

    run_native(report, args.root)
    print("native selftest: %s (%d failing)" % ("FAIL" if failures else "PASS", len(failures)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
