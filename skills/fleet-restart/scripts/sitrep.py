#!/usr/bin/env python3
"""Parsed fleet sitrep: every value comes from a structured source, never from reading a pane by eye.

  agents     tmux list-panes + process tree -> fleet_restart.find_agent (omp argv, MCP versions)
  state      fleet_restart.parse_screen (plain splits on the status bar; UNKNOWN fails closed)
  callbacks  kit-callback grammar `DONE|BLOCKED <bead> <sha> <evidence>; NEXT <item>`: anchored head
             regex for status/bead/sha, then the LAST "; NEXT" splits evidence from next. Soft-wrapped
             pane paragraphs are rejoined before parsing; input is capped at MAX_LINE characters.
  beads      br JSON; closed beads come from their own `--status closed` query (the default list
             omits them, so a close count built on it is always 0)
  CI         gh run list JSON for the repo's origin
Repos are the git toplevels of agent pane cwds plus every --repo. Output: one JSON receipt with a
sha256 over its body; any table is rendered from that JSON. Read-only. Stdlib only.

  python3 sitrep.py [--repo PATH ...] [--out FILE]
  python3 sitrep.py --selftest
"""
import argparse, datetime, hashlib, importlib.util, json, os, re, subprocess, sys, time

_FR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fleet_restart.py")
_spec = importlib.util.spec_from_file_location("fleet_restart", _FR)
fr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fr)

HEAD_RE = re.compile(r"^(DONE|BLOCKED) ([^ ;]+) ([^ ;]+) ")  # exclusive classes, no nested quantifiers
NEXT_SEP = re.compile(r"; *NEXT:? ")
GITHUB_RE = re.compile(r"^(?:https://github\.com/|git@github\.com:)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?$")
MAX_LINE = 2000
WRAP_STOP = ("DONE ", "BLOCKED ", "─", "╭", "╰", "※")


def run(argv, cwd=None):
    result = fr.capture_command(argv, cwd=cwd, env=fr.tmux_env(dict(os.environ)))
    rc = 124 if result.timed_out else result.rc if result.rc is not None else 127
    return rc, fr.process_text(result.stdout), fr.process_text(result.stderr)


def match_callback(line):
    line = line[:MAX_LINE]
    m = HEAD_RE.match(line)
    if not m:
        return None
    seps = list(NEXT_SEP.finditer(line, m.end()))
    if not seps:
        return None
    nxt = line[seps[-1].end():].strip()
    if not nxt:
        return None
    return {"status": m.group(1), "bead": m.group(2), "sha": m.group(3),
            "evidence": line[m.end():seps[-1].start()].strip(), "next": nxt}


def parse_callback(text):
    """Last callback in a pane tail; a wrapped paragraph is rejoined up to a blank, rule or next callback."""
    lines = [ln.strip(" │") for ln in text.splitlines()]
    hit = None
    for i, ln in enumerate(lines):
        if not ln.startswith(("DONE ", "BLOCKED ")):
            continue
        parts = [ln.strip()]
        for nxt in lines[i + 1:i + 8]:
            s = nxt.strip()
            if not s or s.startswith(WRAP_STOP):
                break
            parts.append(s)
        hit = match_callback(" ".join(parts)) or hit
    return hit


def _rows(out):
    data = json.loads(out)
    return data.get("issues", data) if isinstance(data, dict) else data


def beads(repo, run_fn=run, today=None):
    today = today or datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    rc, out, err = run_fn(["br", "list", "--json", "--limit", "0"], cwd=repo)
    if rc != 0:
        return {"error": (err or out).strip()[:200]}
    try:
        rows = _rows(out)
    except ValueError:
        return {"error": "br list output is not JSON"}
    by = {}
    for r in rows:
        by[r.get("status")] = by.get(r.get("status"), 0) + 1
    rc, out, err = run_fn(["br", "list", "--json", "--status", "closed", "--limit", "0"], cwd=repo)
    try:
        closed = _rows(out) if rc == 0 else None
    except ValueError:
        closed = None
    rc, out, _ = run_fn(["br", "ready", "--json"], cwd=repo)
    try:
        ready = len(_rows(out)) if rc == 0 else None
    except ValueError:
        ready = None
    return {"in_progress": by.get("in_progress", 0), "open": by.get("open", 0), "ready": ready,
            "closed_today": None if closed is None else sum(1 for r in closed if str(r.get("closed_at") or "").startswith(today))}


def ci(repo, run_fn=run):
    """Every workflow run on main's current HEAD commit, and one verdict over them. Picking "the latest
    run" misreports: repos name their CI differently and skip some pushes, so on 2026-10-11 the latest
    run was a days-old failure (omp-kit-private) or a Dependabot run (uds), neither on HEAD."""
    rc, url, _ = run_fn(["git", "-C", repo, "remote", "get-url", "origin"])
    m = GITHUB_RE.match(url.strip()[:500])
    if rc != 0 or not m:
        return {"error": "no github origin"}
    rc, out, _ = run_fn(["git", "-C", repo, "ls-remote", "origin", "refs/heads/main"])
    if rc != 0 or not out.strip():
        return {"repo": m.group(1), "error": "cannot read origin main"}
    head = out.split()[0]
    rc, out, err = run_fn(["gh", "run", "list", "--repo", m.group(1), "--commit", head, "--limit", "50",
                           "--json", "workflowName,status,conclusion"])
    if rc != 0:
        return {"repo": m.group(1), "main_head": head[:9], "error": err.strip()[:200]}
    latest = {}
    for r in json.loads(out):  # newest first: keep each workflow's latest attempt on HEAD
        latest.setdefault(r["workflowName"], r["conclusion"] or r["status"])
    states = set(latest.values())
    if not latest:
        verdict = "NO_RUNS_ON_HEAD"
    elif states & {"failure", "timed_out", "startup_failure", "action_required"}:
        verdict = "FAILING"
    elif states - {"success", "skipped", "neutral"}:
        verdict = "RUNNING"
    else:
        verdict = "GREEN"
    return {"repo": m.group(1), "main_head": head[:9], "verdict": verdict, "workflows": latest}


def toplevel(path):
    rc, out, _ = run(["git", "-C", path, "rev-parse", "--show-toplevel"])
    return out.strip() if rc == 0 else None


def sitrep(extra_repos):
    env = dict(os.environ)
    ok, code, detail = fr.env_check(env, os.getuid())
    if not ok:
        return {"refused": code, "why": detail}
    inv = fr.live_inventory(env, lines=120)
    panes, repos = [], set(extra_repos)
    for p in inv["panes"]:
        agent = fr.find_agent(inv["procs"], p["pane_pid"])
        if not agent:
            continue
        _, tail, _ = run(["tmux", "capture-pane", "-p", "-t", p["pane_id"], "-S", "-120"])
        st = fr.parse_screen(p["screen"])
        top = toplevel(p["cwd"])
        if top:
            repos.add(top)
        panes.append({"pane": p["pane"], "pane_id": p["pane_id"], "state": st["state"], "model": st["model"],
                      "flags": " ".join(agent["flags"]), "mcp": agent["mcp"], "cwd": p["cwd"], "repo": top,
                      "callback": parse_callback(tail)})
    body = {"captured_at": inv["captured_at"], "panes": panes,
            "beads": {r: beads(r) for r in sorted(repos)}, "ci": {r: ci(r) for r in sorted(repos)}}
    return {"sha256": hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest(), **body}


def selftest():
    fails = []
    pos = {"DONE ompkit-x1 abc1234 tests 7/7; NEXT ompkit-x2": ("ompkit-x1", "tests 7/7", "ompkit-x2"),
           "BLOCKED uds-e4qy.3 2ea8cad6 uds-r8ce,ev_233c; NEXT verify-r8ce": ("uds-e4qy.3", "uds-r8ce,ev_233c", "verify-r8ce"),
           "BLOCKED zestroku-qfl 98ee780 no fix on origin; NEXT: check %8": ("zestroku-qfl", "no fix on origin", "check %8"),
           "DONE a b c; d; NEXT e": ("a", "c; d", "e")}  # ';' inside evidence (real cfsios shape)
    for s, want in pos.items():
        r = match_callback(s)
        got = r and (r["bead"], r["evidence"], r["next"])
        print("%s POS %r" % ("PASS" if got == want else "FAIL", s))
        fails += [] if got == want else [s]
    for s in ["DONE", "DONE a b", "DONE ompkit-x1 abc1234 no next field", "DONE a b c; NEXT ",
              "IDLE %8 agent: DONE x y z; NEXT w", "the line said DONE a b c; NEXT d"]:
        bad = match_callback(s) is not None
        print("%s NEG %r rejected" % ("FAIL" if bad else "PASS", s))
        fails += [s] if bad else []
    w = parse_callback("x\n DONE cfs-a.74 d2848d2 HEALTH pass, 6/6;    \n four dispatches; NEXT reap\n callbacks\n\n DONE z\n")
    ok = bool(w) and (w["bead"], w["next"]) == ("cfs-a.74", "reap callbacks")
    print("%s wrapped paragraph rejoined before parse: %r" % ("PASS" if ok else "FAIL", w))
    fails += [] if ok else ["wrapped"]
    for probe in ("DONE a b " + "x" * MAX_LINE * 4, "DONE a b " + "; " * MAX_LINE * 4):
        t = time.perf_counter(); match_callback(probe); dt = time.perf_counter() - t
        print("%s near-miss %d chars in %.4fs" % ("PASS" if dt < 0.05 else "FAIL", len(probe), dt))
        fails += [] if dt < 0.05 else ["slow"]
    # planted negative: closes must come from the closed query; the default list never returns them
    def fake(argv, cwd=None):
        if "--status" in argv:
            return 0, json.dumps([{"status": "closed", "closed_at": "2026-10-11T09:40:37Z"}] * 3), ""
        if argv[1] == "ready":
            return 0, "[]", ""
        return 0, json.dumps([{"status": "open"}, {"status": "in_progress"}]), ""
    b = beads("/x", run_fn=fake, today="2026-10-11")
    ok = b["closed_today"] == 3 and b["open"] == 1 and b["ready"] == 0
    print("%s closed_today from the closed query: %r" % ("PASS" if ok else "FAIL", b))
    fails += [] if ok else ["closed_today"]
    # planted negatives: verdict is over every workflow on HEAD; no run on HEAD is not "green"
    def fake_ci(runs_on_head):
        def fn(argv, cwd=None):
            if argv[3:5] == ["remote", "get-url"]:
                return 0, "https://github.com/o/r.git\n", ""
            if argv[0] == "gh":
                return 0, json.dumps(runs_on_head), ""
            return 0, "a" * 40 + "\trefs/heads/main\n", ""
        return fn
    ok_run = {"workflowName": "Dependabot Updates", "status": "completed", "conclusion": "success"}
    cases_ci = [([], "NO_RUNS_ON_HEAD"),
                ([ok_run], "GREEN"),
                ([ok_run, {"workflowName": "CI", "status": "completed", "conclusion": "failure"}], "FAILING"),
                ([{"workflowName": "CI", "status": "in_progress", "conclusion": ""}, ok_run], "RUNNING"),
                ([{"workflowName": "CI", "status": "completed", "conclusion": "success"},
                  {"workflowName": "CI", "status": "completed", "conclusion": "failure"}], "GREEN")]  # newest attempt wins
    for runs_on_head, want in cases_ci:
        got = ci("/x", run_fn=fake_ci(runs_on_head))["verdict"]
        print("%s CI verdict %s for %s" % ("PASS" if got == want else "FAIL", got, [r["conclusion"] or r["status"] for r in runs_on_head]))
        fails += [] if got == want else ["ci " + want]
    print("selftest: %s (%d failing)" % ("PASS" if not fails else "FAIL", len(fails)))
    return 1 if fails else 0


def main(argv):
    ap = argparse.ArgumentParser(prog="sitrep.py")
    ap.add_argument("--repo", action="append", default=[], help="extra tracker repo (e.g. one with no agent pane cwd in it)")
    ap.add_argument("--out")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    res = sitrep(a.repo)
    text = json.dumps(res, indent=1, ensure_ascii=False)
    if a.out:
        with open(a.out, "w") as fh:
            fh.write(text + "\n")
    print(text)
    return 2 if res.get("refused") else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
