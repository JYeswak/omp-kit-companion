#!/usr/bin/env python3
"""fleet-restart helper: snapshot, align check, restart plan, gated send, verify,
handoff and staged re-dispatch messages for an OMP agent fleet in tmux, plus the
autonomous run (watchers pause, session/advisor save, restart, advisor re-apply,
watchers resume) in fr_watchers.py, fr_save.py and fr_run.py.

Every command is read-only or plan/dry-run by default. The writers are `send
--apply` and `run --apply` (operator approval bound to the manifest sha256),
`watchers pause|resume --apply` and `align --relink --apply` (atomic symlink
replace with an undo record). Stdlib only (PyYAML, when importable, reads profile
config.yml). Always call it by full path: python3 "$SKILL/scripts/fleet_restart.py" <cmd>.
"""
import argparse
import datetime
import glob
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys

DEFAULT_PROTECT = ["uds--burn-down:0.0"]
FORBIDDEN_CWDS = ["/private/tmp", "/tmp"]
OMP_RE = re.compile(r"(?:^|\s)\S*bun\s+(\S*/\.bun/bin/omp|\S*/pi-coding-agent/dist/cli\.js)(?=\s|$)")
# Tern (by OMP's authors) installs omp as one compiled binary; ps shows the name it was invoked by
# ("omp --profile x", "/opt/homebrew/bin/omp -p", measured 2026-10-11) or its versioned path, which
# contains a space ("…/Application Support/Tern/omp/versions/18.9.2 …").
TERN_MARK = "/Tern/omp/versions/"
TERN_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
MCP_RE = re.compile(r"(?:^|\s)(@?[\w./-]+)@(\d+\.\d+\.\d+)\s+mcp(?:\s|$)")
STATUS_MARK = "📁"  # omp status line: "<π|spinner> · <glyph> <model> · 📁 <cwd> ..." ('·' or ' > ' separators, maybe boxed)
STATUS_DEPTH = 6  # the status bar is within the last few non-blank lines; older ones are scrollback
BOX = "╭╮╰╯─│├┤┌┐└┘ "
CALLBACK = "DONE|BLOCKED <bead> <sha> <evidence>; NEXT <item>"
# Advisor badge right after the model name (pi-tui status-line modelAdvisorBadge): 👁 while
# advisors review, 🙈 once all have yielded the turn; shown only while an advisor roster is
# live. The "+ 👁 <cost>" spend segment after 📁 is restored from the transcript on resume
# even with the advisor off, so it never counts.
ADVISOR_MARKS = ("👁", "🙈")
CAPTURE_LINES = 2000
TAIL_LINES = 40


# ---------- environment ----------

def env_check(env, uid):
    """ntm/tmux need the fleet socket; without it ntm says 'no tmux sessions running'."""
    if env.get("TMUX"):
        sock = env["TMUX"].split(",", 1)[0]
    elif env.get("TMUX_TMPDIR"):
        sock = os.path.join(env["TMUX_TMPDIR"], "tmux-%d" % uid, "default")
    else:
        return False, "TMUX_ENV_MISSING", "export TMUX_TMPDIR=<fleet socket dir> (e.g. $HOME/.tmux-sockets)"
    if not os.path.exists(sock):
        return False, "TMUX_SOCKET_MISSING", "no tmux server socket at %s" % sock
    return True, "OK", sock


def tmux_env(env):
    keep = {k: env[k] for k in ("TMUX", "TMUX_TMPDIR") if env.get(k)}
    out = dict(os.environ)
    out.update(keep)
    return out


# ---------- process + screen parsing ----------

RESUME_FLAGS = ("--resume", "-r", "--restore")  # session selectors: a restart/respawn picks the session itself


def normalize_flags(tokens):
    """Split --k=v, drop each --resume/-r/--restore and its value."""
    flat = []
    for t in tokens:
        if t.startswith("--") and "=" in t:
            k, v = t.split("=", 1)
            flat += [k, v]
        else:
            flat.append(t)
    out, skip = [], False
    for t in flat:
        if skip:
            skip = False
            continue
        if t in RESUME_FLAGS:
            skip = True
            continue
        out.append(t)
    return out


def same_flags(a, b):
    """Equal option sets, order-insensitive: each --flag keeps its value (if any)."""
    def pairs(tokens):
        toks, out, i = normalize_flags(tokens), [], 0
        while i < len(toks):
            if toks[i].startswith("--") and i + 1 < len(toks) and not toks[i + 1].startswith("--"):
                out.append((toks[i], toks[i + 1]))
                i += 2
            else:
                out.append((toks[i], None))
                i += 1
        return sorted(out, key=lambda p: (p[0], p[1] or ""))
    return pairs(a) == pairs(b)


def omp_match(args):
    """Flags of an omp agent process, or None. Bun-run omp anywhere in the line (the launcher may be
    wrapped); a compiled omp only as the process's own first token, so a `zsh -lc '… && omp …'`
    wrapper or `omp-kit` never counts."""
    if "__omp_worker" in args:
        return None
    m = OMP_RE.search(args)
    if m:
        return shlex.split(args[m.end():])
    first, _, rest = args.partition(" ")
    if os.path.basename(first) == "omp":
        return shlex.split(rest)
    at = args.find(TERN_MARK)
    if args.startswith("/") and at != -1:
        version, _, rest = args[at + len(TERN_MARK):].partition(" ")
        if TERN_VERSION_RE.match(version):
            return shlex.split(rest)
    return None


def descendants(procs, root):
    kids = {}
    for p in procs:
        kids.setdefault(p["ppid"], []).append(p)
    out, frontier, depth = [], [root], 0
    while frontier:
        nxt = []
        for pid in frontier:
            for c in kids.get(pid, []):
                out.append((depth, c))
                nxt.append(c["pid"])
        frontier, depth = nxt, depth + 1
    return out


def find_agent(procs, pane_pid):
    """Detect the agent by its omp process, never by model name on screen."""
    for _, p in descendants(procs, pane_pid):
        rest = omp_match(p["args"])
        if rest is not None:
            mcp, mcp_pids = {}, []
            for _, c in descendants(procs, p["pid"]):
                for name, ver in MCP_RE.findall(c["args"]):
                    mcp[name] = ver
                    mcp_pids.append(c["pid"])
            return {"pid": p["pid"], "args": p["args"], "flags": normalize_flags(rest), "mcp": mcp, "mcp_pids": sorted(mcp_pids)}
    return None

def git_child(procs, pane_pid):
    """First live git descendant of the pane, if any. Respawning (SIGHUP) a
    pane mid-git leaves a holder-less .git/index.lock behind (rz5.101), so a
    pane with a running git child is deferred, never restarted."""
    for _, p in descendants(procs, pane_pid):
        first = (p["args"] or "").split(None, 1)[0] if p["args"] else ""
        if os.path.basename(first) == "git":
            return p
    return None


def status_index(nonblank):
    """Index (in the non-blank lines) of the omp status bar: the lowest of the last
    STATUS_DEPTH lines carrying 📁 after at least one '·' (or ' > ') field; None when
    absent. Older status lines higher up are scrollback and never count."""
    start = max(0, len(nonblank) - STATUS_DEPTH)
    for i in range(len(nonblank) - 1, start - 1, -1):
        line = nonblank[i]
        if STATUS_MARK not in line:
            continue
        head = line[:line.index(STATUS_MARK)].lstrip(BOX).replace(" > ", " · ")
        if len(head.split("·")) >= 2:
            return i
    return None


def status_line(lines):
    nonblank = [ln for ln in lines if ln.strip()]
    i = status_index(nonblank)
    return None if i is None else nonblank[i]


def advisor_badge(lines):
    """True when the live status bar's model segments (before 📁) carry 👁 or 🙈."""
    line = status_line(lines)
    if not line:
        return False
    fields = line[:line.index(STATUS_MARK)].lstrip(BOX).replace(" > ", " · ").split("·")[1:]
    return any(m in f for f in fields for m in ADVISOR_MARKS)


def composer_text(lines):
    """Text typed (or queued) in the composer; '' when empty; None when the layout is
    not one of the two measured shapes (fail closed: callers hold the pane).
    Plain: rows between the separator line just above the status bar and the
    separator above them ('❯' prompt row). Boxed: rows between the status bar (the
    box's top border) and the '╰' bottom border. Sending /restart into a non-empty
    composer would submit the operator's text with it; respawn would discard it."""
    nonblank = [ln for ln in lines if ln.strip()]
    i = status_index(nonblank)
    if i is None:
        return None
    after = nonblank[i + 1:]
    if after:
        if not after[-1].lstrip().startswith("╰"):
            return None
        rows = after[:-1]
    else:
        def sep(ln):
            return ln.lstrip().startswith("──")
        if i < 2 or not sep(nonblank[i - 1]):
            return None
        j, rows = i - 2, []
        while j >= 0 and not sep(nonblank[j]):
            rows.append(nonblank[j])
            j -= 1
        if j < 0:
            return None
    text = " ".join(r.strip().strip(BOX).replace("❯", "", 1).strip() for r in rows)
    return text.strip()


def parse_screen(lines):
    """IDLE when the bottom status bar starts with the prompt glyph π, optionally
    suffixed with the profile (`π-flag`, v18.12); BUSY on a braille spinner;
    UNKNOWN otherwise (fail closed). Plain splits, no regex: screen lines are
    untrusted text."""
    line = status_line(lines)
    if line is None:
        return {"state": "UNKNOWN", "model": ""}
    parts = line[:line.index(STATUS_MARK)].lstrip(BOX).replace(" > ", " · ").split("·")
    first = parts[0].split()
    tok = first[0] if first else ""
    words = parts[1].split(None, 1)
    model = words[1] if len(parts) >= 3 and len(words) == 2 else ""
    for mark in ADVISOR_MARKS:
        model = model.replace(mark, "")
    model = model.strip()
    if tok == "π" or tok.startswith("π-"):
        return {"state": "IDLE", "model": model}
    if tok and "\u2800" <= tok[0] <= "\u28ff":
        return {"state": "BUSY", "model": model}
    return {"state": "UNKNOWN", "model": model}


# ---------- align (kit + plugin links) ----------

def plugin_links(home):
    links = [os.path.join(home, ".omp", "plugins", "node_modules", "omp-kit-companion")]
    links += sorted(glob.glob(os.path.join(home, ".omp", "profiles", "*", "plugins", "node_modules", "omp-kit-companion")))
    return [p for p in links if os.path.islink(p)]


def align_check(home, releases_root, version):
    expected = os.path.realpath(os.path.join(releases_root, version))
    rows = []
    for link in plugin_links(home):
        target = os.readlink(link)
        ok = os.path.realpath(link) == expected
        rows.append({"link": link, "target": target, "ok": ok})
    stale = [r for r in rows if not r["ok"]]
    return {"ok": bool(rows) and not stale and os.path.isdir(expected), "version": version, "expected": expected,
            "links": rows, "stale": stale, "why": "" if rows else "no plugin links found"}


def relink(report, undo_path, apply=False):
    """Interim RELINK1 (ompkit-fp72.18) repair: atomic symlink replace + undo record."""
    plan = [{"link": r["link"], "old_target": r["target"], "new_target": report["expected"]} for r in report["stale"]]
    if not apply:
        return {"applied": False, "links": plan}
    with open(undo_path, "w") as fh:
        json.dump({"created": now(), "links": plan,
                   "undo": "python3 -c \"import json,os,sys; [(os.symlink(r['old_target'], r['link'] + '.undo'), os.replace(r['link'] + '.undo', r['link'])) "
                           "for r in json.load(open(sys.argv[1]))['links']]\" %s" % undo_path}, fh, indent=1)
    for row in plan:
        tmp = row["link"] + ".fleet-restart.tmp"
        if os.path.lexists(tmp):
            os.unlink(tmp)
        os.symlink(row["new_target"], tmp)
        os.replace(tmp, row["link"])
    return {"applied": True, "links": plan, "undo": undo_path}


def kit_version():
    out = subprocess.run(["omp-kit", "--version"], capture_output=True, text=True, check=True).stdout
    m = re.search(r"(\d+\.\d+\.\d+)", out)
    if not m:
        raise SystemExit("cannot parse omp-kit --version: %r" % out)
    return m.group(1)


# ---------- plan ----------

def classify(pane, procs, chief, protect, unprotect=()):
    """`unprotect`: panes the operator released from DEFAULT_PROTECT/--protect for
    this run; `run --apply` honours it only when the approval names them too."""
    row = {"pane": pane["pane"], "pane_id": pane["pane_id"], "session": pane["pane"].split(":", 1)[0], "cwd": pane["cwd"]}
    agent = find_agent(procs, pane["pane_pid"])
    screen = parse_screen(pane.get("screen", []))
    row["state"], row["screen_model"] = screen["state"], screen["model"]
    if agent:
        row.update({"omp_pid": agent["pid"], "args": agent["args"], "flags": agent["flags"], "mcp": agent["mcp"], "mcp_pids": agent["mcp_pids"]})
    protected = pane["pane"] in protect or pane["pane_id"] in protect
    if protected and (pane["pane"] in unprotect or pane["pane_id"] in unprotect):
        protected, row["unprotected"] = False, True
    if protected:
        row["action"] = "SKIP_PROTECTED"
    elif pane["pane"] == chief or pane["pane_id"] == chief:
        row["action"] = "SKIP_CHIEF"
    elif (git := git_child(procs, pane["pane_pid"])) is not None:
        row["action"] = "SKIP_GIT"
        row["reason"] = "git child pid %s (%s); deferred to the next pass" % (git["pid"], git["args"][:80])
    elif not agent:
        row["action"] = "SKIP_SHELL"
    elif any(pane["cwd"] == c or pane["cwd"].startswith(c + "/") for c in FORBIDDEN_CWDS):
        row["action"] = "HOLD_CWD"
    elif screen["state"] == "BUSY":
        row["action"] = "QUEUE_BUSY"
    elif screen["state"] != "IDLE":
        row["action"] = "HOLD_UNKNOWN_STATE"
    elif composer_text(pane.get("screen", [])) != "":
        row["action"] = "HOLD_COMPOSER"  # never discard or append to typed/queued text
    else:
        row["action"] = "RESTART"
    return row

def txt_exe(lsof_text):
    """Running executable from `lsof -Fn`: the name after the first `ftxt` field."""
    fd = None
    for line in (lsof_text or "").splitlines():
        if line.startswith("f"):
            fd = line[1:]
        elif line.startswith("n") and fd == "txt":
            return line[1:]
    return None


def herdr_agent(process_info):
    """The omp agent in a herdr process-info payload. The shell and `__omp_worker` do not count."""
    for proc in (process_info or {}).get("foreground_processes") or []:
        argv = proc.get("argv") or []
        args = " ".join(argv)
        flags = omp_match(args)
        if flags is not None:
            return {"pid": proc.get("pid"), "args": args, "flags": flags}
    return None


def resume_from_flags(flags):
    """Session file from live argv when herdr has not filled agent_session yet."""
    flags = flags or []
    for i, tok in enumerate(flags):
        if tok in ("--resume", "-r", "--restore") and i + 1 < len(flags):
            return flags[i + 1]
        if tok.startswith("--resume=") or tok.startswith("--restore="):
            return tok.split("=", 1)[1]
    return None


def _chief_hit(pane, pane_id, chief):
    if not chief:
        return False
    chiefs = chief if isinstance(chief, (list, tuple, set)) else (chief,)
    return pane in chiefs or pane_id in chiefs


def derive_pane_state(surface, pane, pane_id, omp_pid, exe, target, chief, flags, agent_status=None, session_file=None):
    """One ntm or herdr seat. The pane shell's txt is zsh and is not a state.
    `/restart` re-execs the running binary, so a different executable is RESPAWN."""
    same = bool(exe and target and os.path.realpath(exe) == os.path.realpath(target))
    if not omp_pid:
        state, action = "NO_OMP", "SKIP_SHELL"
    elif not exe:
        state, action = "UNKNOWN_EXE", "HOLD_UNKNOWN_EXE"
    elif not same:
        state, action = "STALE", "RESPAWN"
    else:
        state, action = "CURRENT", "CURRENT"
    if _chief_hit(pane, pane_id, chief) and omp_pid:
        action = "SKIP_CHIEF"
    return {"surface": surface, "pane": pane, "pane_id": pane_id, "omp_pid": omp_pid, "exe": exe,
            "version": os.path.basename(exe) if exe and TERN_VERSION_RE.match(os.path.basename(exe)) else None,
            "target": os.path.basename(target) if target and TERN_VERSION_RE.match(os.path.basename(target)) else None,
            "state": state, "action": action, "flags": list(flags or []),
            "agent_status": agent_status, "session_file": session_file}


def ntm_states(panes, procs, exe_of, target, chief):
    rows = []
    for pane in panes:
        agent = find_agent(procs, pane["pane_pid"])
        exe = exe_of(agent["pid"]) if agent else None
        rows.append(derive_pane_state("ntm", pane["pane"], pane["pane_id"], agent["pid"] if agent else None,
                                      exe, target, chief, agent["flags"] if agent else []))
    return rows


def herdr_states_from(agents, infos, exe_of, target, chief):
    rows = []
    for agent in agents:
        pane = agent.get("pane_id")
        omp = herdr_agent(infos.get(pane) or {})
        flags = omp["flags"] if omp else []
        sess = (agent.get("agent_session") or {}).get("value") or resume_from_flags(flags)
        rows.append(derive_pane_state("herdr", pane, pane, omp["pid"] if omp else None,
                                      exe_of(omp["pid"]) if omp else None, target, chief,
                                      flags, agent.get("agent_status"), sess))
    return rows


def live_herdr_states(run_fn, target, chief):
    rc, text = run_fn(["herdr", "agent", "list"])
    if rc != 0:
        return {"ok": False, "why": text.strip()[:300], "rows": []}
    try:
        agents = json.loads(text)["result"]["agents"]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        return {"ok": False, "why": "herdr agent list: %s" % exc, "rows": []}
    infos = {}
    for agent in agents:
        pane = agent.get("pane_id")
        rc, body = run_fn(["herdr", "pane", "process-info", "--pane", pane])
        if rc != 0:
            infos[pane] = {}
            continue
        try:
            infos[pane] = json.loads(body)["result"]["process_info"]
        except (json.JSONDecodeError, KeyError, TypeError):
            infos[pane] = {}

    def exe_of(pid):
        return txt_exe(run_fn(["lsof", "-nP", "-p", str(pid), "-a", "-d", "txt", "-Fn"])[1])

    return {"ok": True, "rows": herdr_states_from(agents, infos, exe_of, target, chief)}


def process_inventory(env):
    """Pane pids and the process table, no screen capture. State uses the omp child, not the shell."""
    fmt = "#{session_name}:#{window_index}.#{pane_index}\t#{pane_id}\t#{pane_pid}\t#{pane_current_path}"
    rc, text = run(["tmux", "list-panes", "-a", "-F", fmt], tmux_env(env))
    if rc != 0:
        raise SystemExit("tmux list-panes failed (%d): %s" % (rc, text.strip()))
    rc, ps = run(["ps", "-A", "-o", "pid=,ppid=,args="])
    procs = []
    for line in ps.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
            procs.append({"pid": int(parts[0]), "ppid": int(parts[1]), "args": parts[2] if len(parts) > 2 else ""})
    panes = []
    for line in text.splitlines():
        pane, pid, ppid, cwd = line.split("\t")
        panes.append({"pane": pane, "pane_id": pid, "pane_pid": int(ppid), "cwd": cwd})
    return panes, procs



def build_plan(inv, chief, protect, align_report, unprotect=()):
    plan = {"created": now(), "snapshot_at": inv.get("captured_at"), "chief": chief, "protect": list(protect), "unprotect": list(unprotect),
            "align": {k: align_report[k] for k in ("ok", "version", "expected", "stale")}, "rows": []}
    if not align_report["ok"]:
        plan["refused"] = "ALIGN_STALE"
        return plan
    plan["rows"] = [classify(p, inv["procs"], chief, protect, unprotect) for p in inv["panes"]]
    return plan


def respawn_cmd(row, argv=None):
    flags = row["flags"] if argv is None else argv
    return "cd %s && omp %s" % (shlex.quote(row["cwd"]), " ".join(shlex.quote(f) for f in flags))


def check_cmd_flags(cmd, live_flags, added=(), resume=None):
    """A launch command must carry exactly the live process flags (minus --resume),
    plus only the `added` flags its row declares (the respawn fallback's --advisor),
    and, when `resume` is given, `--resume <that saved session file>`."""
    tail = cmd.split("&&", 1)[-1]
    toks = shlex.split(tail)
    if not toks or os.path.basename(toks[0]) != "omp":
        return False, "NOT_AN_OMP_COMMAND"
    rest = list(toks[1:])
    for flag in added:
        if flag not in rest:
            return False, "DECLARED_FLAG_MISSING"
        rest.remove(flag)
    if not same_flags(rest, live_flags):
        return False, "FLAGS_NOT_FROM_LIVE_ARGS"
    if resume is not None and not any(rest[i] == "--resume" and rest[i + 1] == resume for i in range(len(rest) - 1)):
        return False, "RESUME_NOT_SAVED_SESSION"
    return True, "OK"


RESPAWN_HOLDS = ("HOLD_NO_SESSION", "HOLD_SESSION_AMBIGUOUS", "HOLD_SCRATCH_OWNER")


def respawn_row(r, saved):
    """Respawn fallback for one plan row from its save.json row: live flags +
    --resume <session file> + --advisor when the advisor was on and the profile
    config does not already enable it. None when a hold refuses respawn (no or
    ambiguous session file, or an owned work-scratch hold: a respawn kills that
    pid and scratch-reaper then deletes the dir)."""
    if not saved or any(h in RESPAWN_HOLDS for h in saved.get("holds", [])):
        return None
    argv, added = list(r["flags"]) + ["--resume", saved["session_file"]], []
    adv = saved.get("advisor") or {}
    if adv.get("on") and adv.get("source") != "config" and "--advisor" not in r["flags"]:
        argv.append("--advisor")
        added.append("--advisor")
    return {"pane": r["pane"], "pane_id": r["pane_id"], "session": r["session"], "flags": r["flags"], "kind": "respawn", "cwd": r["cwd"],
            "cmd": respawn_cmd(r, argv), "added": added, "session_file": saved["session_file"], "omp_pid": r.get("omp_pid")}


def restart_manifest(plan, mode="restart", save=None):
    """`save`: save.json; required for respawn (the fallback must resume the saved session)."""
    if mode == "respawn" and save is None:
        raise ValueError("SAVE_REQUIRED: respawn needs save.json (session file + advisor state per pane)")
    saved = {r["pane_id"]: r for r in (save or {}).get("rows", [])}
    rows, held = [], []
    for r in plan["rows"]:
        if r["action"] != "RESTART":
            continue
        if mode == "restart":
            rows.append({"pane": r["pane"], "pane_id": r["pane_id"], "session": r["session"], "flags": r["flags"], "kind": "keys", "text": "/restart"})
            continue
        row = respawn_row(r, saved.get(r["pane_id"]))
        if row is None:
            held.append({"pane": r["pane"], "holds": (saved.get(r["pane_id"]) or {}).get("holds", ["NOT_SAVED"])})
        else:
            rows.append(row)
    man = {"kind": "restart-" + mode, "created": now(), "rows": rows}
    if mode == "respawn":
        man["held"] = held
    return man


def health_text(repo, sessions, which=None):
    """INIT health clause for a staged director message. Tools are named bare
    (resolved on the operator's PATH, never a per-user absolute path); a tool
    missing from PATH is omitted from the clause, never reported as run.
    `sessions`: every session in the run, the director's own first: a director
    whose workers live in another session (2026-10-11 control-plane:0.1 ->
    uds--burn-down) must read that session's health too, not just its own
    (ompkit-uxr3). Accepts one session string or a list."""
    find = which or shutil.which
    parts = []
    if find("flywheel"):
        parts.append("flywheel doctor --repo %s --json" % repo)
    if isinstance(sessions, str):
        sessions = [sessions]
    if find("ntm"):
        parts += ["ntm health %s --json" % s for s in dict.fromkeys(sessions)]
    if not parts:
        return "No HEALTH tool (flywheel/ntm) is on PATH: record versions by hand. "
    return "INIT includes HEALTH: %s. " % " and ".join(parts)


def messages_manifest(plan, handoff, snapshot_dir, kit_version, out_dir, directors, which=None):
    """Directors are named by the operator (pane position is not a role: on
    2026-10-11 uds--burn-down:0.1 was a worker and control-plane:0.1 ran UDS).
    Every staged text names its pane (the row is not inferable from the
    snapshot file name), the callback channel (the pane's own output, where
    the chief's sitrep sweep reads tails), and, for directors, every run
    session's health. Workers hold for the director's dispatch: directors
    DISPATCH in their first turn, so a self-assigning worker message
    double-assigns (ompkit-uxr3). Holds (HOLD_CWD and the rest) never reach a
    manifest: only RESTART rows are staged."""
    if not directors:
        raise ValueError("DIRECTORS_REQUIRED: pass the operator-confirmed director panes")
    unknown = set(directors) - {r["pane"] for r in plan["rows"]}
    if unknown:
        raise ValueError("DIRECTORS_NOT_IN_PLAN: %s" % ", ".join(sorted(unknown)))
    os.makedirs(out_dir, exist_ok=True)
    dirs = set(directors)
    sessions = sorted({r["session"] for r in plan["rows"] if r["action"] == "RESTART"})
    rows = []
    for r in plan["rows"]:
        if r["action"] != "RESTART":
            continue
        snap = os.path.join(snapshot_dir, "panes", r["pane"].replace(":", ".") + ".md")
        role = "director" if r["pane"] in dirs else "worker"
        own_first = [r["session"]] + [s for s in sessions if s != r["session"]]
        if role == "director":
            text = (
                "You are %s (session %s). Fresh session on omp-kit %s. Read %s, your row and your workers' rows, then your pane snapshot %s.\n"
                "Follow the kit tick order: INIT → RESEARCH → PLAN → BEADS → DISPATCH → VALIDATE → INTEGRATE → LEARN. "
                "VALIDATE is before INTEGRATE. A callback with no validation receipt is not INTEGRATE-ready.\n"
                % (r["pane"], r["session"], kit_version, handoff, snap)
                + health_text(r["cwd"], own_first, which) +
                "A stale user/shell pane is a warning, not a block; exit 30 repo_not_initialized means phase INIT.\n"
                "Callback, one line printed in your own pane output (the chief's sitrep sweep reads pane tails): %s\n" % CALLBACK)
        else:
            text = (
                "You are %s (session %s). Fresh session on omp-kit %s. Read your row in %s and your pane snapshot %s.\n"
                "Hold for your director's dispatch message before taking work; do not self-assign from br ready first.\n"
                "Callback, one line printed in your own pane output (the chief's sitrep sweep reads pane tails): %s\n"
                % (r["pane"], r["session"], kit_version, handoff, snap, CALLBACK))
        path = os.path.join(out_dir, "%s.%s.txt" % (role, r["pane"].replace(":", ".")))
        with open(path, "w") as fh:
            fh.write(text)
        rows.append({"pane": r["pane"], "pane_id": r["pane_id"], "session": r["session"], "role": role, "kind": "file", "file": path,
                     "sha256": hashlib.sha256(text.encode()).hexdigest()})
    rows.sort(key=lambda x: 0 if x["role"] == "director" else 1)
    return {"kind": "messages", "created": now(), "rows": rows}


# ---------- gated send ----------

# The only keystrokes any manifest may carry into an agent pane. Bare `/advisor`
# TOGGLES the advisor (OMP slash-commands/builtin-collaboration.ts), so it is never allowed.
KEYS_ALLOWED = ("/restart", "/advisor on")


def manifest_sha(manifest):
    """Run manifests bind every field (stages, watchers, holds, snapshot); the
    others bind kind + rows, as before."""
    if manifest.get("kind") == "run":
        body = {k: v for k, v in manifest.items() if k != "manifest_sha256"}
        return hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
    body = [{k: r[k] for k in sorted(r) if k not in ("result",)} for r in manifest["rows"]]
    return hashlib.sha256(json.dumps({"kind": manifest["kind"], "rows": body}, sort_keys=True).encode()).hexdigest()


def ntm_argv(row):
    base = ["ntm", "send", row["session"], "--panes=%s" % row["pane_id"], "--no-cass-check", "--force-non-interactive", "--json"]
    if row["kind"] == "keys":
        return base + [row["text"]]
    if row["kind"] == "file":
        return base + ["--file", row["file"]]
    raise ValueError(row["kind"])


def tmux_respawn_argv(row):
    """`omp` is the login shell's plain command (the target install), never a versioned
    path or bun; `exec zsh -l` keeps the pane alive after omp exits."""
    return ["tmux", "respawn-pane", "-k", "-t", row["pane_id"], "-c", row["cwd"], "zsh -lc %s" % shlex.quote(row["cmd"] + "; exec zsh -l")]


def send(manifest, apply, approval, env, uid, capture_fn, run_fn, role=None, revalidate_fn=None):
    """`revalidate_fn(row) -> (hold, detail)`: live re-check of a respawn row's saved
    facts (omp pid, session file, git child, owned scratch) right before its send. A
    respawn row is refused without one: never respawn from a stale save.json row."""
    sha = manifest_sha(manifest)
    res = {"mode": "APPLY" if apply else "DRY_RUN", "manifest_sha256": sha, "rows": []}
    rows = [r for r in manifest["rows"] if role in (None, "all") or r.get("role") == role]
    if not apply:
        for r in rows:
            argv = tmux_respawn_argv(r) if r["kind"] == "respawn" else ntm_argv(r)
            res["rows"].append({"pane": r["pane"], "result": "WOULD_SEND", "argv": argv})
        return res
    if not approval:
        res["refused"] = "APPROVAL_MISSING"
        return res
    if approval.get("manifest_sha256") != sha or not approval.get("approved_by") or not approval.get("quote"):
        res["refused"] = "APPROVAL_MISMATCH"
        return res
    ok, code, detail = env_check(env, uid)
    if not ok:
        res["refused"], res["why"] = code, detail
        return res
    res["approval"] = approval
    for r in rows:
        out = {"pane": r["pane"], "pane_id": r["pane_id"], "at": now()}
        if r["kind"] == "keys" and r["text"] not in KEYS_ALLOWED:
            out["result"] = "REFUSED_KEYS_NOT_ALLOWED"
            res["rows"].append(out)
            continue
        if r["kind"] == "respawn":
            good, code = check_cmd_flags(r["cmd"], r["flags"], r.get("added", ()), r.get("session_file"))
            if not good:
                out["result"] = "REFUSED_" + code
                res["rows"].append(out)
                continue
            if revalidate_fn is None:
                out["result"] = "REFUSED_NO_REVALIDATION"
                res["rows"].append(out)
                continue
        if r["kind"] == "file":
            with open(r["file"], "rb") as fh:
                if hashlib.sha256(fh.read()).hexdigest() != r["sha256"]:
                    out["result"] = "REFUSED_FILE_CHANGED_AFTER_APPROVAL"
                    res["rows"].append(out)
                    continue
        screen = capture_fn(r["pane_id"])
        state = parse_screen(screen)["state"]
        if state != "IDLE":
            out["result"] = "QUEUED_BUSY" if state == "BUSY" else "HELD_UNKNOWN_STATE"
            res["rows"].append(out)
            continue
        if composer_text(screen) != "":
            out["result"] = "HELD_COMPOSER"
            res["rows"].append(out)
            continue
        if r["kind"] == "respawn":
            hold, why = revalidate_fn(r)
            if hold:
                out.update({"result": hold, "why": why})
                res["rows"].append(out)
                continue
        argv = tmux_respawn_argv(r) if r["kind"] == "respawn" else ntm_argv(r)
        rc, text = run_fn(argv, tmux_env(env))
        out.update({"argv": argv, "rc": rc, "out": text[-500:], "result": "SENT" if rc == 0 else "SEND_FAILED"})
        res["rows"].append(out)
    return res


# ---------- verify ----------

def verify(plan, inv_after, expect_mcp, mode="restart", sent=None, sessions=None, lsof_fn=None, fork_fn=None):
    """`sent`: pane names the send log marks SENT; verify only what was restarted.
    `sessions`: pane_id -> expected session file with `lsof_fn(pid) -> lsof -Fn`
    text and `fork_fn(path) -> reason|None`. When given, a pane also fails on a
    forked session (SESSION_FORKED: a "Session moved to a new file" event or a
    parentSession header) and on any open session other than the expected one
    (SESSION_LOST): the zestroku:0.3 fork verified clean because only pid, flags
    and screen were checked (ompkit-m5gs). Without sessions the check is off."""
    panes = {p["pane_id"]: p for p in inv_after["panes"]}
    rows = []
    for r in plan["rows"]:
        if r["action"] != "RESTART" or (sent is not None and r["pane"] not in sent):
            continue
        p = panes.get(r["pane_id"])
        why = []
        if not p:
            rows.append({"pane": r["pane"], "result": "FAILED", "why": ["pane gone"]})
            continue
        agent = find_agent(inv_after["procs"], p["pane_pid"])
        if not agent:
            why.append("no omp process")
        else:
            if mode == "restart" and agent["pid"] != r["omp_pid"]:
                why.append("pid %s != %s (/restart re-execs in place)" % (agent["pid"], r["omp_pid"]))
            if mode == "respawn" and agent["pid"] == r["omp_pid"]:
                why.append("pid %s unchanged: no respawn observed" % agent["pid"])
            if set(agent["mcp_pids"]) & set(r.get("mcp_pids", [])):
                why.append("mcp child pids %s unchanged: no restart observed" % sorted(set(agent["mcp_pids"]) & set(r["mcp_pids"])))
            if not same_flags(agent["flags"], r["flags"]):
                why.append("flags %s != live-before %s" % (agent["flags"], r["flags"]))
            for name, ver in (expect_mcp or {}).items():
                if agent["mcp"].get(name) != ver:
                    why.append("mcp %s=%s != %s" % (name, agent["mcp"].get(name), ver))
            expected = (sessions or {}).get(r["pane_id"])
            if expected and lsof_fn is not None:
                import fr_save
                text = lsof_fn(agent["pid"])
                if fork_fn is not None:
                    fork = fork_fn(expected)
                    if fork:
                        why.append("SESSION_FORKED: %s" % fork)
                if expected not in fr_save.session_candidates(text):
                    why.append("SESSION_LOST: %s not open (open: %s)" % (expected, fr_save.session_candidates(text)))
                elif not fr_save.session_exact(text, expected):
                    why.append("SESSION_LOST: expected exactly [%s], open: %s" % (expected, fr_save.session_candidates(text)))
        state = parse_screen(p.get("screen", []))["state"]
        if state != "IDLE":
            why.append("screen %s, not idle prompt" % state)
        rows.append({"pane": r["pane"], "result": "FAILED" if why else "VERIFIED", "why": why,
                     "mcp_before": r.get("mcp"), "mcp_after": agent["mcp"] if agent else None})
    return {"verified_at": now(), "rows": rows, "verified": sum(1 for x in rows if x["result"] == "VERIFIED"), "total": len(rows)}


# ---------- live capture ----------

def run(argv, env=None):
    p = subprocess.run(argv, capture_output=True, text=True, env=env)
    return p.returncode, (p.stdout + p.stderr)


def live_inventory(env, lines=TAIL_LINES, out_dir=None, only=None):
    """`only`: pane ids to capture (polling one pane); the other panes keep an empty screen."""
    fmt = "#{session_name}:#{window_index}.#{pane_index}\t#{pane_id}\t#{pane_pid}\t#{pane_current_path}"
    rc, text = run(["tmux", "list-panes", "-a", "-F", fmt], tmux_env(env))
    if rc != 0:
        raise SystemExit("tmux list-panes failed (%d): %s" % (rc, text.strip()))
    rc, ps = run(["ps", "-A", "-o", "pid=,ppid=,args="])
    procs = []
    for line in ps.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
            procs.append({"pid": int(parts[0]), "ppid": int(parts[1]), "args": parts[2] if len(parts) > 2 else ""})
    panes = []
    for line in text.splitlines():
        pane, pid, ppid, cwd = line.split("\t")
        if only is not None and pid not in only:
            panes.append({"pane": pane, "pane_id": pid, "pane_pid": int(ppid), "cwd": cwd, "screen": []})
            continue
        rc, cap = run(["tmux", "capture-pane", "-p", "-J", "-t", pid, "-S", "-%d" % lines], tmux_env(env))
        screen = [ln for ln in cap.splitlines()]
        while screen and not screen[-1].strip():
            screen.pop()
        if out_dir:
            with open(os.path.join(out_dir, "panes", pane.replace(":", ".") + ".md"), "w") as fh:
                fh.write("\n".join(screen) + "\n")
        panes.append({"pane": pane, "pane_id": pid, "pane_pid": int(ppid), "cwd": cwd, "screen": screen[-TAIL_LINES:]})
    return {"captured_at": now(), "panes": panes, "procs": procs}


def capture_live(env):
    def cap(pane_id):
        rc, text = run(["tmux", "capture-pane", "-p", "-J", "-t", pane_id, "-S", "-%d" % TAIL_LINES], tmux_env(env))
        lines = text.splitlines()
        while lines and not lines[-1].strip():
            lines.pop()
        return lines
    return cap


# ---------- handoff ----------

def render_handoff(plan, snapshot_dir, version, chief):
    chief = next(("%s (%s)" % (r["pane"], r["pane_id"]) for r in plan["rows"] if chief in (r["pane"], r["pane_id"])), chief)
    out = ["# Fleet restart handoff, %s" % plan["created"][:10], "",
           "Snapshot: %s (%s). Kit: omp-kit %s; plugin links aligned: %s." % (snapshot_dir, plan.get("snapshot_at"), version, plan["align"]["ok"]),
           "Chief: %s (operator restarts it after reading this file). Protected: %s." % (chief, ", ".join(plan["protect"])), "",
           "## Per-pane record", "",
           "| Pane | Id | Action | Live flags (copied from process args) | Screen model | MCP before |", "|---|---|---|---|---|---|"]
    for r in plan["rows"]:
        out.append("| %s | %s | %s | `%s` | %s | %s |" % (r["pane"], r["pane_id"], r["action"], " ".join(r.get("flags", [])) or "-",
                                                       r.get("screen_model") or "-", ",".join("%s@%s" % kv for kv in sorted(r.get("mcp", {}).items())) or "-"))
    queued = [r["pane"] for r in plan["rows"] if r["action"] in ("QUEUE_BUSY", "HOLD_UNKNOWN_STATE", "HOLD_CWD")]
    cwd_held = [r["pane"] for r in plan["rows"] if r["action"] == "HOLD_CWD"]
    out += ["", "## Open for the next chief", "",
            "- Not restarted yet (restart at turn boundary or after operator decision): %s" % (", ".join(queued) or "none"),
            "- HOLD_CWD panes need the operator to move them to a repo cwd first, then re-plan: a respawn reuses the row's cwd and the script never moves a pane. Held for cwd: %s" % (", ".join(cwd_held) or "none"),
            "- First messages are STAGED, not sent. Send directors first only after operator approval of the staged manifest; workers after directors report HEALTH.",
            "- Callback grammar (one line, printed in the pane's own output): `%s`" % CALLBACK,
            "- Fill in below: HEALTH results, INTEGRATE items, open beads, PRs, defects found this restart.", "",
            "## Rollback", "", "Prior sessions stay on disk; `omp <same flags> --resume <session.jsonl>` restores a pane's old conversation.", ""]
    return "\n".join(out)


# ---------- CLI ----------

def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load(path):
    with open(path) as fh:
        return json.load(fh)


def dump(obj, path=None):
    text = json.dumps(obj, indent=1, ensure_ascii=False)
    if path:
        with open(path, "w") as fh:
            fh.write(text + "\n")
    print(text)


def stage1(args):
    """Plan and snapshot for handoff/messages. With --run they default to the run
    manifest's plan.json and stage-1 snapshot; a different --snapshot is refused
    (ompkit-uxr3: stage 7 once read the post-restart snapshot)."""
    if not args.run:
        if not (args.plan and args.snapshot):
            raise SystemExit("give --run DIR, or both --plan and --snapshot")
        return args.plan, args.snapshot
    man = load(os.path.join(args.run, "run-manifest.json"))
    if args.snapshot and os.path.abspath(args.snapshot) != man["snapshot_dir"]:
        raise SystemExit("SNAPSHOT_NOT_STAGE1: %s is not the run's stage-1 snapshot %s" % (args.snapshot, man["snapshot_dir"]))
    return args.plan or os.path.join(args.run, "plan.json"), man["snapshot_dir"]


def read_approval(path):
    approval = load(path) if path else None
    if approval and ("<" in str(approval.get("approved_by", "<")) or "<" in str(approval.get("quote", "<"))):
        return None  # unfilled template
    return approval


def main(argv):
    ap = argparse.ArgumentParser(prog="fleet_restart.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check-env", help="tmux fleet socket reachable (exit 2 if not)")
    s = sub.add_parser("snapshot")
    s.add_argument("--out", required=True)
    s.add_argument("--lines", type=int, default=CAPTURE_LINES)
    a = sub.add_parser("align")
    a.add_argument("--home", default=os.path.expanduser("~"))
    a.add_argument("--releases", default=os.path.expanduser("~/.local/opt/omp-kit/releases"))
    a.add_argument("--version")
    a.add_argument("--relink", action="store_true")
    a.add_argument("--apply", action="store_true")
    a.add_argument("--undo", help="undo record path (keep it in the run's scratch dir)")
    a.add_argument("--approved-by", help="operator who approved this relink (required with --apply)")
    p = sub.add_parser("plan")
    p.add_argument("--inventory", help="inventory.json from snapshot; default: live")
    p.add_argument("--chief", default=os.environ.get("TMUX_PANE", ""))
    p.add_argument("--protect", action="append", default=[])
    p.add_argument("--home", default=os.path.expanduser("~"))
    p.add_argument("--releases", default=os.path.expanduser("~/.local/opt/omp-kit/releases"))
    p.add_argument("--version")
    p.add_argument("--out")
    st = sub.add_parser("states", help="classify every ntm and herdr omp seat against the login-shell target")
    st.add_argument("--target", help="realpath of the omp build; default: zsh -lc 'command -v omp'")
    st.add_argument("--chief", action="append", default=[], help="pane name or id to mark SKIP_CHIEF; repeatable")
    st.add_argument("--out")
    m = sub.add_parser("manifest")
    m.add_argument("kind", choices=["restart", "respawn", "messages"])
    m.add_argument("--run", help="run dir: defaults --plan and the stage-1 --snapshot from its run manifest")
    m.add_argument("--plan")
    m.add_argument("--save", help="save.json; required for respawn (--resume <session file>, --advisor)")
    m.add_argument("--handoff")
    m.add_argument("--snapshot")
    m.add_argument("--directors", action="append")
    m.add_argument("--staged-dir")
    m.add_argument("--only", action="append", help="limit to these panes (name or %%id), e.g. a QUEUE_BUSY pane at its turn boundary")
    m.add_argument("--out", required=True)
    se = sub.add_parser("send")
    se.add_argument("--manifest", required=True)
    se.add_argument("--apply", action="store_true")
    se.add_argument("--approval", help="approval.json {manifest_sha256, approved_by, quote}")
    se.add_argument("--role", choices=["director", "worker", "all"])
    se.add_argument("--log")
    ap_ = sub.add_parser("approval-template")
    ap_.add_argument("--manifest", required=True)
    v = sub.add_parser("verify")
    v.add_argument("--plan", required=True)
    v.add_argument("--inventory", help="after-inventory; default: live")
    v.add_argument("--expect-mcp", action="append", default=[], help="name=version, e.g. rea-agents=6.4.0")
    v.add_argument("--mode", choices=["restart", "respawn"], default="restart")
    v.add_argument("--sent-log", help="send --log output; verify only panes it marks SENT")
    v.add_argument("--save", help="save.json; checks each pane holds exactly its saved session file and the file shows no fork")
    h = sub.add_parser("handoff")
    h.add_argument("--run", help="run dir: plan.json and the stage-1 snapshot from its run manifest")
    h.add_argument("--plan")
    h.add_argument("--snapshot")
    h.add_argument("--out", required=True)
    w = sub.add_parser("watchers")
    w.add_argument("action", choices=["snapshot", "pause", "resume"])
    w.add_argument("--run", help="run dir (pause/resume)")
    w.add_argument("--ttl-min", type=int, default=90, help="pause: the dead-man resumes after this many minutes")
    w.add_argument("--if-expired", action="store_true", help="resume: no-op before the pause record's expires_at")
    w.add_argument("--apply", action="store_true")
    w.add_argument("--approval", help="pause --apply: approval bound to DIR/watchers-pause-plan.json")
    w.add_argument("--agents-dir", default=os.path.expanduser("~/Library/LaunchAgents"))
    w.add_argument("--registry")
    sv = sub.add_parser("save")
    sv.add_argument("--run", required=True)
    sv.add_argument("--inventory", help="inventory.json; default: live")
    sv.add_argument("--home", default=os.path.expanduser("~"))
    r = sub.add_parser("run")
    r.add_argument("--run", required=True)
    rmode = r.add_mutually_exclusive_group(required=True)
    rmode.add_argument("--plan", action="store_true")
    rmode.add_argument("--apply", action="store_true")
    r.add_argument("--approval", help="--apply: approval bound to DIR/run-manifest.json")
    r.add_argument("--busy-timeout-min", type=float, default=30)
    r.add_argument("--wave", type=int, default=3)
    r.add_argument("--resume-run", action="store_true")
    r.add_argument("--canary", type=int, help="plan: panes restarted and verified first, RESPAWN preferred (default 1); apply may only repeat it")
    r.add_argument("--strict-advisor", action="store_const", const=True, help="ADVISOR_FAILED also trips the breaker (canary panes always)")
    r.add_argument("--continue-after-breaker", action="store_true", help="with --resume-run, after a breaker stop; the approval must carry continue_after_breaker: true")
    r.add_argument("--only", action="append", default=[], help="plan: limit the manifest to these panes (name or %%id)")
    r.add_argument("--unprotect", action="append", default=[], help="release a protected pane; the approval's unprotect list must name it too")
    r.add_argument("--chief", default=os.environ.get("TMUX_PANE", ""), help="chief pane (default $TMUX_PANE); never touched by the run")
    r.add_argument("--protect", action="append", default=[])
    r.add_argument("--home", default=os.path.expanduser("~"))
    r.add_argument("--releases", default=os.path.expanduser("~/.local/opt/omp-kit/releases"))
    r.add_argument("--version")
    r.add_argument("--agents-dir", default=os.path.expanduser("~/Library/LaunchAgents"))
    args = ap.parse_args(argv)
    env, uid = dict(os.environ), os.getuid()

    if args.cmd == "check-env":
        ok, code, detail = env_check(env, uid)
        dump({"ok": ok, "code": code, "detail": detail})
        return 0 if ok else 2
    if args.cmd == "snapshot":
        ok, code, detail = env_check(env, uid)
        if not ok:
            dump({"ok": False, "code": code, "detail": detail})
            return 2
        os.makedirs(os.path.join(args.out, "panes"), exist_ok=True)
        inv = live_inventory(env, lines=args.lines, out_dir=args.out)
        with open(os.path.join(args.out, "inventory.json"), "w") as fh:
            json.dump(inv, fh, indent=1, ensure_ascii=False)
        summary = [{"pane": p["pane"], "pane_id": p["pane_id"], "cwd": p["cwd"], **parse_screen(p["screen"]),
                    "agent": bool(find_agent(inv["procs"], p["pane_pid"]))} for p in inv["panes"]]
        dump({"ok": True, "out": args.out, "panes": len(inv["panes"]), "summary": summary}, os.path.join(args.out, "pane-status.json"))
        return 0
    if args.cmd == "align":
        version = args.version or kit_version()
        report = align_check(args.home, args.releases, version)
        if args.relink:
            if args.apply and not args.approved_by:
                ap.error("align --relink --apply needs --approved-by <operator> (profile links are operator state)")
            report["relink"] = relink(report, args.undo or "relink-undo.json", apply=args.apply)
            report["relink"]["approved_by"] = args.approved_by
            if args.apply:
                report["after"] = align_check(args.home, args.releases, version)
        dump(report)
        return 0 if report["ok"] or (args.relink and args.apply and report["after"]["ok"]) else 3
    if args.cmd == "plan":
        version = args.version or kit_version()
        inv = load(args.inventory) if args.inventory else live_inventory(env)
        chief = args.chief
        plan = build_plan(inv, chief, DEFAULT_PROTECT + args.protect, align_check(args.home, args.releases, version))
        dump(plan, args.out)
        return 3 if plan.get("refused") else 0
    if args.cmd == "states":
        ok, code, detail = env_check(env, uid)
        if not ok:
            dump({"ok": False, "code": code, "detail": detail})
            return 2
        target = args.target
        if not target:
            rc, out = run(["zsh", "-lc", "command -v omp"])
            which = out.strip().splitlines()[-1] if rc == 0 and out.strip() else ""
            target = os.path.realpath(which) if which else ""
        chiefs = args.chief or [x for x in (env.get("TMUX_PANE"), env.get("HERDR_PANE_ID")) if x]
        panes, procs = process_inventory(env)

        def exe_of(pid):
            return txt_exe(run(["lsof", "-nP", "-p", str(pid), "-a", "-d", "txt", "-Fn"])[1])

        ntm = ntm_states(panes, procs, exe_of, target, chiefs)
        herdr = live_herdr_states(run, target, chiefs)
        rows = ntm + herdr.get("rows", [])
        dump({"ok": True, "target": target, "chief": chiefs, "herdr_ok": herdr.get("ok"),
              "herdr_why": herdr.get("why"), "stale": [r["pane"] for r in rows if r["state"] == "STALE"],
              "rows": rows}, args.out)
        return 0
    if args.cmd == "manifest":
        plan_path = args.plan
        if args.kind == "messages":
            plan_path, snapshot = stage1(args)
        elif args.run and not plan_path:
            plan_path = os.path.join(args.run, "plan.json")
        if not plan_path:
            ap.error("manifest needs --plan or --run")
        plan = load(plan_path)
        if plan.get("refused"):
            print("plan refused: %s" % plan["refused"], file=sys.stderr)
            return 3
        if args.kind == "messages":
            if not (args.handoff and args.staged_dir and args.directors):
                ap.error("messages needs --handoff --staged-dir, --run (or --plan + --snapshot) and one --directors per operator-confirmed director pane")
            try:
                man = messages_manifest(plan, args.handoff, snapshot, plan["align"]["version"], args.staged_dir, args.directors)
            except ValueError as exc:
                print(str(exc), file=sys.stderr)
                return 3
        else:
            save_path = args.save or (os.path.join(args.run, "save.json") if args.run else None)
            try:
                man = restart_manifest(plan, mode=args.kind, save=load(save_path) if args.kind == "respawn" and save_path else None)
            except ValueError as exc:
                print(str(exc), file=sys.stderr)
                return 3
        if args.only:
            man["rows"] = [r for r in man["rows"] if r["pane"] in args.only or r["pane_id"] in args.only]
        man["manifest_sha256"] = manifest_sha(man)
        dump(man, args.out)
        return 0
    if args.cmd == "approval-template":
        man = load(args.manifest)
        tpl = {"manifest_sha256": manifest_sha(man), "approved_by": "<operator name>", "quote": "<operator's approval message, verbatim>",
               "rows": [r["pane"] for r in man["rows"]]}
        if man.get("kind") == "run":
            tpl["rows"] = [r["pane"] for r in man["rows"] if r["action"] in ("RESTART", "QUEUE_BUSY")]
            tpl["watchers_pause"] = man["watchers"]["pause"]
            tpl["watchers_pause_detail"] = (man["watchers"].get("binding") or {}).get("pause", [])
            tpl["watchers_registry_sha256"] = (man["watchers"].get("binding") or {}).get("registry_sha256")
            tpl["unprotect"] = man.get("unprotect", [])
            tpl["target"] = man.get("target")
            tpl["canary"], tpl["strict_advisor"] = man.get("canary", 1), man.get("strict_advisor", False)
            tpl["continue_after_breaker"] = False
        dump(tpl)
        return 0
    if args.cmd == "send":
        man = load(args.manifest)
        import fr_save
        revalidate = fr_save.respawn_revalidator(lambda only=None: live_inventory(env, only=only), fr_save.lsof_live(run), run, args.home)
        res = send(man, args.apply, read_approval(args.approval), env, uid, capture_live(env), run, role=args.role, revalidate_fn=revalidate)
        dump(res, args.log)
        return 0 if not res.get("refused") and all(r["result"] in ("SENT", "WOULD_SEND") for r in res["rows"]) else 4
    if args.cmd == "verify":
        plan = load(args.plan)
        inv = load(args.inventory) if args.inventory else live_inventory(env)
        expect = dict(x.split("=", 1) for x in args.expect_mcp)
        sent = {r["pane"] for r in load(args.sent_log)["rows"] if r.get("result") == "SENT"} if args.sent_log else None
        sessions, lsof_fn, fork_fn = None, None, None
        if args.save:
            import fr_save
            saved = {r["pane_id"]: r for r in load(args.save).get("rows", [])}
            sessions = {k: r["session_file"] for k, r in saved.items() if r.get("session_file")}
            lsof_fn, fork_fn = fr_save.lsof_live(run), fr_save.fork_evidence
        res = verify(plan, inv, expect, mode=args.mode, sent=sent, sessions=sessions, lsof_fn=lsof_fn, fork_fn=fork_fn)
        dump(res)
        return 0 if res["verified"] == res["total"] else 5
    if args.cmd == "handoff":
        plan_path, snapshot = stage1(args)
        plan = load(plan_path)
        text = render_handoff(plan, snapshot, plan["align"]["version"], plan["chief"])
        with open(args.out, "w") as fh:
            fh.write(text)
        print(args.out)
        return 0
    if args.cmd == "watchers":
        return watchers_cmd(args, env, uid)
    if args.cmd == "save":
        import fr_save
        os.makedirs(args.run, exist_ok=True)
        inv = load(args.inventory) if args.inventory else live_inventory(env)
        doc = fr_save.save(inv, args.home, fr_save.lsof_live(run), run)
        doc["stage"] = "manual"
        with open(os.path.join(args.run, "save.json"), "w") as fh:
            json.dump(doc, fh, indent=1, ensure_ascii=False)
        dump({"out": os.path.join(args.run, "save.json"), "counts": doc["counts"], "holds": doc["holds"]})
        return 0
    if args.cmd == "run":
        return run_cmd(args, env, uid)
    return 2


def watchers_cmd(args, env, uid):
    import fr_watchers as fw
    plat = fw.platform_status()
    if plat:
        dump(dict(plat, action=args.action))
        return 0
    reg = fw.load_registry(args.registry or fw.REGISTRY_PATH)
    if args.action == "snapshot":
        disc = fw.discover(args.agents_dir, reg, run, uid)
        dump(dict(disc, counts={"jobs": len(disc["jobs"]), "loaded": sum(1 for j in disc["jobs"] if j["loaded"]),
                                "pause_plan": len(disc["pause_plan"]), "unclassified": len(disc["unclassified"]), "unreadable": len(disc["unreadable"])}))
        return 0
    if not args.run:
        raise SystemExit("watchers %s needs --run DIR" % args.action)
    os.makedirs(args.run, exist_ok=True)
    if args.action == "resume":
        res = fw.resume(os.path.abspath(args.run), run, uid, int(datetime.datetime.now().timestamp()), if_expired=args.if_expired, apply=args.apply)
        dump(res)
        return 0 if res.get("result") != "RESUME_FAILED" else 8
    disc = fw.discover(args.agents_dir, reg, run, uid)
    plan_man = fw.pause_plan_manifest(disc)
    plan_man["manifest_sha256"] = manifest_sha(plan_man)
    if not args.apply:
        with open(os.path.join(args.run, "watchers-pause-plan.json"), "w") as fh:
            json.dump(plan_man, fh, indent=1)
        dump(fw.pause(os.path.abspath(args.run), disc, run, uid, int(datetime.datetime.now().timestamp()), args.ttl_min, apply=False))
        return 0
    approval = read_approval(args.approval)
    if not approval or approval.get("manifest_sha256") != plan_man["manifest_sha256"]:
        dump({"refused": "APPROVAL_MISSING" if not approval else "APPROVAL_MISMATCH", "manifest_sha256": plan_man["manifest_sha256"]})
        return 4
    res = fw.pause(os.path.abspath(args.run), disc, run, uid, int(datetime.datetime.now().timestamp()), args.ttl_min, apply=True)
    dump(res)
    return 0 if not res.get("refused") and all(r["action"] != "BOOTOUT_FAILED" for r in res["rows"]) else 8


def run_cmd(args, env, uid):
    import fr_run
    ctx = fr_run.live_ctx(env, args.home, args.releases, args.version, agents_dir=args.agents_dir)
    run_dir = os.path.abspath(args.run)
    if args.plan:
        man = fr_run.plan_run(run_dir, ctx, args.chief, DEFAULT_PROTECT + args.protect, args.unprotect, args.wave, args.busy_timeout_min,
                              canary=1 if args.canary is None else args.canary, strict_advisor=bool(args.strict_advisor), only=args.only)
        dump({"run_manifest": os.path.join(run_dir, fr_run.RUN_MANIFEST), "manifest_sha256": man["manifest_sha256"], "refused": man["refused"],
              "target": man["target"], "counts": man["counts"], "holds": man["holds"], "watchers_pause": man["watchers"]["pause"],
              "watchers_pause_detail": (man["watchers"].get("binding") or {}).get("pause", []),
              "watchers_unclassified": [j["label"] for j in man["watchers"]["unclassified"]], "snapshot_dir": man["snapshot_dir"],
              "chief_respawn": man["chief_respawn"],
              "scratch_held": {r["pane"]: [d["path"] for d in r.get("held_scratch") or []] for r in man["rows"] if r.get("held_scratch")},
              "scratch_advice": fr_run.SCRATCH_ADVICE})
        return 3 if man["refused"] else 0
    rep, rc = fr_run.apply_run(run_dir, ctx, read_approval(args.approval), args.unprotect, args.resume_run, canary=args.canary,
                               strict_advisor=args.strict_advisor, continue_after_breaker=args.continue_after_breaker)
    dump(rep if rep.get("refused") else {"report": os.path.join(run_dir, "report.json"), "counts": rep["counts"], "advisor": rep["advisor"],
                                         "failed": rep["failed"], "error": rep["error"], "watchers_resume": rep["watchers"]["resume"]["result"],
                                         "breaker": fr_run.breaker_line(rep["breaker"]) if rep["breaker"] else None, "warnings": rep["warnings"],
                                         "chief_respawn": rep["chief_respawn"]})
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
