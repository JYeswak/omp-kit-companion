#!/usr/bin/env python3
"""fleet-restart helper: snapshot, align check, restart plan, gated send, verify,
handoff and staged re-dispatch messages for an OMP agent fleet in tmux.

Every command is read-only or plan/dry-run by default. The only writers are
`send --apply` (needs an operator approval bound to the manifest sha256) and
`align --relink --apply` (atomic symlink replace with an undo record).
Stdlib only. Run through the interpreter: python3 scripts/fleet_restart.py <cmd>.
"""
import argparse
import datetime
import glob
import hashlib
import json
import os
import re
import shlex
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
        return False, "TMUX_ENV_MISSING", "export TMUX_TMPDIR=<fleet socket dir> (this fleet: /Users/josh/.tmux-sockets)"
    if not os.path.exists(sock):
        return False, "TMUX_SOCKET_MISSING", "no tmux server socket at %s" % sock
    return True, "OK", sock


def tmux_env(env):
    keep = {k: env[k] for k in ("TMUX", "TMUX_TMPDIR") if env.get(k)}
    out = dict(os.environ)
    out.update(keep)
    return out


# ---------- process + screen parsing ----------

def normalize_flags(tokens):
    """Split --k=v, drop --resume and its value (a restart may resume a session)."""
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
        if t == "--resume":
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


def parse_screen(lines):
    """IDLE when the bottom status bar starts with the prompt glyph π; BUSY on a
    braille spinner; UNKNOWN otherwise (fail closed). Plain splits, no regex:
    screen lines are untrusted text."""
    bottom = [ln for ln in lines if ln.strip()][-STATUS_DEPTH:]
    for line in reversed(bottom):
        if STATUS_MARK not in line:
            continue
        head = line[:line.index(STATUS_MARK)].lstrip(BOX).replace(" > ", " · ")
        parts = head.split("·")
        if len(parts) < 2:
            continue
        first = parts[0].split()
        tok = first[0] if first else ""
        words = parts[1].split(None, 1)
        model = words[1].strip() if len(parts) >= 3 and len(words) == 2 else ""
        if tok == "π":
            return {"state": "IDLE", "model": model}
        if tok and "\u2800" <= tok[0] <= "\u28ff":
            return {"state": "BUSY", "model": model}
        return {"state": "UNKNOWN", "model": model}
    return {"state": "UNKNOWN", "model": ""}


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

def classify(pane, procs, chief, protect):
    row = {"pane": pane["pane"], "pane_id": pane["pane_id"], "session": pane["pane"].split(":", 1)[0], "cwd": pane["cwd"]}
    agent = find_agent(procs, pane["pane_pid"])
    screen = parse_screen(pane.get("screen", []))
    row["state"], row["screen_model"] = screen["state"], screen["model"]
    if agent:
        row.update({"omp_pid": agent["pid"], "args": agent["args"], "flags": agent["flags"], "mcp": agent["mcp"], "mcp_pids": agent["mcp_pids"]})
    if pane["pane"] in protect or pane["pane_id"] in protect:
        row["action"] = "SKIP_PROTECTED"
    elif pane["pane"] == chief or pane["pane_id"] == chief:
        row["action"] = "SKIP_CHIEF"
    elif not agent:
        row["action"] = "SKIP_SHELL"
    elif any(pane["cwd"] == c or pane["cwd"].startswith(c + "/") for c in FORBIDDEN_CWDS):
        row["action"] = "HOLD_CWD"
    elif screen["state"] == "BUSY":
        row["action"] = "QUEUE_BUSY"
    elif screen["state"] != "IDLE":
        row["action"] = "HOLD_UNKNOWN_STATE"
    else:
        row["action"] = "RESTART"
    return row


def build_plan(inv, chief, protect, align_report):
    plan = {"created": now(), "snapshot_at": inv.get("captured_at"), "chief": chief, "protect": list(protect),
            "align": {k: align_report[k] for k in ("ok", "version", "expected", "stale")}, "rows": []}
    if not align_report["ok"]:
        plan["refused"] = "ALIGN_STALE"
        return plan
    plan["rows"] = [classify(p, inv["procs"], chief, protect) for p in inv["panes"]]
    return plan


def respawn_cmd(row):
    return "cd %s && omp %s" % (shlex.quote(row["cwd"]), " ".join(shlex.quote(f) for f in row["flags"]))


def check_cmd_flags(cmd, live_flags):
    """A launch command must carry exactly the live process flags (minus --resume)."""
    tail = cmd.split("&&", 1)[-1]
    toks = shlex.split(tail)
    if not toks or os.path.basename(toks[0]) != "omp":
        return False, "NOT_AN_OMP_COMMAND"
    if not same_flags(toks[1:], live_flags):
        return False, "FLAGS_NOT_FROM_LIVE_ARGS"
    return True, "OK"


def restart_manifest(plan, mode="restart"):
    rows = []
    for r in plan["rows"]:
        if r["action"] != "RESTART":
            continue
        row = {"pane": r["pane"], "pane_id": r["pane_id"], "session": r["session"], "flags": r["flags"]}
        if mode == "restart":
            row.update({"kind": "keys", "text": "/restart"})
        else:
            row.update({"kind": "respawn", "cmd": respawn_cmd(r)})
        rows.append(row)
    return {"kind": "restart-" + mode, "created": now(), "rows": rows}


def messages_manifest(plan, handoff, snapshot_dir, kit_version, out_dir, directors):
    """Directors are named by the operator (pane position is not a role: on
    2026-10-11 uds--burn-down:0.1 was a worker and control-plane:0.1 ran UDS)."""
    if not directors:
        raise ValueError("DIRECTORS_REQUIRED: pass the operator-confirmed director panes")
    unknown = set(directors) - {r["pane"] for r in plan["rows"]}
    if unknown:
        raise ValueError("DIRECTORS_NOT_IN_PLAN: %s" % ", ".join(sorted(unknown)))
    os.makedirs(out_dir, exist_ok=True)
    dirs = set(directors)
    rows = []
    for r in plan["rows"]:
        if r["action"] != "RESTART":
            continue
        snap = os.path.join(snapshot_dir, "panes", r["pane"].replace(":", ".") + ".md")
        role = "director" if r["pane"] in dirs else "worker"
        if role == "director":
            text = (
                "Fresh session on omp-kit %s. Read %s, your row and your workers' rows, then your pane snapshot %s.\n"
                "1. HEALTH: /Users/josh/Developer/foundry/bin/flywheel doctor --repo %s --json and ntm health %s --json. "
                "A stale user/shell pane is a warning, not a block; exit 30 repo_not_initialized means phase INIT.\n"
                "2. INTEGRATE: verify and close or reopen every bead your workers reported pushed (check the sha is on origin/main).\n"
                "3. DISPATCH from br ready, one bead per idle worker.\n"
                "Callback, one line: %s\n" % (kit_version, handoff, snap, r["cwd"], r["session"], CALLBACK))
        else:
            text = (
                "Fresh session on omp-kit %s. Read your row in %s and your pane snapshot %s.\n"
                "Take the next bead from your own br ready frontier.\n"
                "Callback, one line: %s\n" % (kit_version, handoff, snap, CALLBACK))
        path = os.path.join(out_dir, "%s.%s.txt" % (role, r["pane"].replace(":", ".")))
        with open(path, "w") as fh:
            fh.write(text)
        rows.append({"pane": r["pane"], "pane_id": r["pane_id"], "session": r["session"], "role": role, "kind": "file", "file": path,
                     "sha256": hashlib.sha256(text.encode()).hexdigest()})
    rows.sort(key=lambda x: 0 if x["role"] == "director" else 1)
    return {"kind": "messages", "created": now(), "rows": rows}


# ---------- gated send ----------

def manifest_sha(manifest):
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
    return ["tmux", "respawn-pane", "-k", "-t", row["pane_id"], "%s; exec zsh -l" % row["cmd"]]


def send(manifest, apply, approval, env, uid, capture_fn, run_fn, role=None):
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
        if r["kind"] == "respawn":
            good, code = check_cmd_flags(r["cmd"], r["flags"])
            if not good:
                out["result"] = "REFUSED_" + code
                res["rows"].append(out)
                continue
        if r["kind"] == "file":
            with open(r["file"], "rb") as fh:
                if hashlib.sha256(fh.read()).hexdigest() != r["sha256"]:
                    out["result"] = "REFUSED_FILE_CHANGED_AFTER_APPROVAL"
                    res["rows"].append(out)
                    continue
        state = parse_screen(capture_fn(r["pane_id"]))["state"]
        if state != "IDLE":
            out["result"] = "QUEUED_BUSY" if state == "BUSY" else "HELD_UNKNOWN_STATE"
            res["rows"].append(out)
            continue
        argv = tmux_respawn_argv(r) if r["kind"] == "respawn" else ntm_argv(r)
        rc, text = run_fn(argv, tmux_env(env))
        out.update({"argv": argv, "rc": rc, "out": text[-500:], "result": "SENT" if rc == 0 else "SEND_FAILED"})
        res["rows"].append(out)
    return res


# ---------- verify ----------

def verify(plan, inv_after, expect_mcp, mode="restart", sent=None):
    """`sent`: pane names the send log marks SENT; verify only what was restarted."""
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
            if set(agent["mcp_pids"]) & set(r.get("mcp_pids", [])):
                why.append("mcp child pids %s unchanged: no restart observed" % sorted(set(agent["mcp_pids"]) & set(r["mcp_pids"])))
            if not same_flags(agent["flags"], r["flags"]):
                why.append("flags %s != live-before %s" % (agent["flags"], r["flags"]))
            for name, ver in (expect_mcp or {}).items():
                if agent["mcp"].get(name) != ver:
                    why.append("mcp %s=%s != %s" % (name, agent["mcp"].get(name), ver))
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


def live_inventory(env, lines=TAIL_LINES, out_dir=None):
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
    out += ["", "## Open for the next chief", "",
            "- Not restarted yet (restart at turn boundary or after operator decision): %s" % (", ".join(queued) or "none"),
            "- First messages are STAGED, not sent. Send directors first only after operator approval of the staged manifest; workers after directors report HEALTH.",
            "- Callback grammar (one line): `%s`" % CALLBACK,
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


def main(argv):
    ap = argparse.ArgumentParser(prog="fleet_restart.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("env")
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
    m = sub.add_parser("manifest")
    m.add_argument("kind", choices=["restart", "respawn", "messages"])
    m.add_argument("--plan", required=True)
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
    h = sub.add_parser("handoff")
    h.add_argument("--plan", required=True)
    h.add_argument("--snapshot", required=True)
    h.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    env, uid = dict(os.environ), os.getuid()

    if args.cmd == "env":
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
    if args.cmd == "manifest":
        plan = load(args.plan)
        if plan.get("refused"):
            print("plan refused: %s" % plan["refused"], file=sys.stderr)
            return 3
        if args.kind == "messages":
            if not (args.handoff and args.snapshot and args.staged_dir and args.directors):
                ap.error("messages needs --handoff --snapshot --staged-dir and one --directors per operator-confirmed director pane")
            try:
                man = messages_manifest(plan, args.handoff, args.snapshot, plan["align"]["version"], args.staged_dir, args.directors)
            except ValueError as exc:
                print(str(exc), file=sys.stderr)
                return 3
        else:
            man = restart_manifest(plan, mode=args.kind)
        if args.only:
            man["rows"] = [r for r in man["rows"] if r["pane"] in args.only or r["pane_id"] in args.only]
        man["manifest_sha256"] = manifest_sha(man)
        dump(man, args.out)
        return 0
    if args.cmd == "approval-template":
        man = load(args.manifest)
        dump({"manifest_sha256": manifest_sha(man), "approved_by": "<operator name>", "quote": "<operator's approval message, verbatim>",
              "rows": [r["pane"] for r in man["rows"]]})
        return 0
    if args.cmd == "send":
        man = load(args.manifest)
        approval = load(args.approval) if args.approval else None
        if approval and ("<" in approval.get("approved_by", "<") or "<" in approval.get("quote", "<")):
            approval = None
        res = send(man, args.apply, approval, env, uid, capture_live(env), run, role=args.role)
        dump(res, args.log)
        return 0 if not res.get("refused") and all(r["result"] in ("SENT", "WOULD_SEND") for r in res["rows"]) else 4
    if args.cmd == "verify":
        plan = load(args.plan)
        inv = load(args.inventory) if args.inventory else live_inventory(env)
        expect = dict(x.split("=", 1) for x in args.expect_mcp)
        sent = {r["pane"] for r in load(args.sent_log)["rows"] if r.get("result") == "SENT"} if args.sent_log else None
        res = verify(plan, inv, expect, mode=args.mode, sent=sent)
        dump(res)
        return 0 if res["verified"] == res["total"] else 5
    if args.cmd == "handoff":
        plan = load(args.plan)
        text = render_handoff(plan, args.snapshot, plan["align"]["version"], plan["chief"])
        with open(args.out, "w") as fh:
            fh.write(text)
        print(args.out)
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
