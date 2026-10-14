"""fleet-restart save stage: per agent pane, the facts a restart must keep —
live argv, session file, advisor state and its WATCHDOG rosters, owned scratch,
repo dirt. Inventory git uses --no-optional-locks. preserve_work pins dirty
repos on a private index and copies held scratch; it never writes the shared index."""
import hashlib
import json
import os
import shutil
import subprocess

import fleet_restart as core

try:  # native YAML parser for profile config.yml; absent -> config state "unparsed", never guessed
    import yaml
except ImportError:  # pragma: no cover - depends on the interpreter
    yaml = None

WATCHDOG_NAMES = ("WATCHDOG.yml", "WATCHDOG.yaml")


def profile_of(flags):
    for i, t in enumerate(flags[:-1]):
        if t == "--profile":
            return flags[i + 1]
    return None


def agent_dir(home, profile):
    return os.path.join(home, ".omp", "agent") if not profile else os.path.join(home, ".omp", "profiles", profile, "agent")


def flag_value(flags, name):
    for i, t in enumerate(flags[:-1]):
        if t == name:
            return flags[i + 1]
    return None


def resume_id(raw_args):
    """The --resume/-r/--restore value of the live process (normalize_flags drops it from `flags`)."""
    toks = core.omp_match(raw_args or "") or []
    for i, t in enumerate(toks):
        for flag in core.RESUME_FLAGS:
            if t.startswith(flag + "=") and flag.startswith("--"):
                return t.split("=", 1)[1]
            if t == flag and i + 1 < len(toks):
                return toks[i + 1]
    return None


def session_candidates(lsof_text):
    """Main session files open by the process: `lsof -Fn` name lines ending .jsonl that sit
    directly in sessions/<cwd-slug>/. Subagent and __advisor transcripts live one level
    deeper (sessions/<slug>/<session>/x.jsonl) and are excluded, as is any __advisor* name."""
    out = []
    for line in lsof_text.splitlines():
        if not line.startswith("n") or not line.endswith(".jsonl"):
            continue
        path = line[1:]
        if os.path.basename(path).startswith("__advisor"):
            continue
        if os.path.basename(os.path.dirname(os.path.dirname(path))) == "sessions" and path not in out:
            out.append(path)
    return out


def executable(lsof_text):
    """The running executable: the first name after an `ftxt` field in `lsof -Fn` output
    (lsof lists the program text before loaded libraries). A re-exec keeps the pid, so
    this, not argv, says which OMP build a pane runs."""
    fd = None
    for line in lsof_text.splitlines():
        if line.startswith("f"):
            fd = line[1:]
        elif line.startswith("n") and fd == "txt":
            return line[1:]
    return None


def version_of(path):
    """Tern installs each build at …/omp/versions/<x.y.z>; None for anything else."""
    if path and os.path.basename(os.path.dirname(path)) == "versions":
        return os.path.basename(path)
    return None


def is_bun(exe, args):
    return os.path.basename(exe or "") == "bun" or bool(core.OMP_RE.search(args or ""))


def target_live(run_fn):
    """Restart target: realpath of the login shell's `omp` (zsh -lc 'command -v omp')."""
    rc, out = run_fn(["zsh", "-lc", "command -v omp"], None)
    cmd = out.strip().splitlines()[-1] if rc == 0 and out.strip() else ""
    if not cmd.startswith("/"):
        return {"ok": False, "why": "login shell has no omp on PATH (rc %d: %s)" % (rc, out.strip()[-200:])}
    real = os.path.realpath(cmd)
    return {"ok": True, "command": "omp", "which": cmd, "path": real, "version": version_of(real), "via": "zsh -lc 'command -v omp'"}


def pane_mode(save_row, target):
    """RESTART (/restart, same pid) only when the running executable is already the
    target build and not a bun launch; /restart re-execs process.execPath, so any
    other pane needs RESPAWN to change version."""
    if save_row.get("exe_real") and save_row["exe_real"] == target.get("path") and not save_row.get("bun"):
        return "RESTART"
    return "RESPAWN"


def pick_session(cands, rid):
    if rid:
        hits = [c for c in cands if c == rid or rid in os.path.basename(c)]
        if len(hits) == 1:
            return hits[0], None
    if len(cands) == 1:
        return cands[0], None
    return None, ("HOLD_NO_SESSION" if not cands else "HOLD_SESSION_AMBIGUOUS")


def config_advisor(path):
    """advisor.enabled from a profile config.yml, nested or dotted key: enabled |
    disabled | absent | unparsed:<why>. Only `enabled` makes the source `config`."""
    if not os.path.isfile(path):
        return "absent"
    if yaml is None:
        return "unparsed:pyyaml-missing"
    try:
        with open(path) as fh:
            doc = yaml.safe_load(fh)
    except Exception as exc:
        return "unparsed:%s" % type(exc).__name__
    if not isinstance(doc, dict):
        return "absent" if doc is None else "unparsed:not-a-mapping"
    vals = []
    if isinstance(doc.get("advisor"), dict) and "enabled" in doc["advisor"]:
        vals.append(doc["advisor"]["enabled"])
    if "advisor.enabled" in doc:
        vals.append(doc["advisor.enabled"])
    if not vals:
        return "absent"
    return "enabled" if vals[-1] is True else "disabled"


def advisor_state(screen, flags, adir):
    cfg = config_advisor(os.path.join(adir, "config.yml"))
    source = "flag" if "--advisor" in flags else "config" if cfg == "enabled" else "runtime"
    return {"on": core.advisor_badge(screen), "source": source, "config": cfg}


def sha256_file(path):
    try:
        with open(path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()
    except OSError:
        return None


def watchdog_files(adir, project_dirs):
    out = []
    for scope, d in [("user", adir)] + [("project", p) for p in project_dirs]:
        for name in WATCHDOG_NAMES:
            p = os.path.join(d, name)
            if os.path.isfile(p) and p not in [x["path"] for x in out]:
                out.append({"scope": scope, "path": p, "sha256": sha256_file(p)})
    return out


def repo_root(cwd):
    d = os.path.abspath(cwd)
    while True:
        if os.path.exists(os.path.join(d, ".git")):
            return d
        up = os.path.dirname(d)
        if up == d:
            return None
        d = up


def owner_pid(text):
    """pid from a scratch .owner file: `pid=N`, `pid: N` or JSON {"pid": N}."""
    text = text.strip()
    if text.startswith("{"):
        try:
            return int(json.loads(text).get("pid"))
        except (ValueError, TypeError, AttributeError):
            return None
    for line in text.splitlines():
        for sep in ("=", ":"):
            key, hit, val = line.partition(sep)
            if hit and key.strip().lower() == "pid":
                val = val.strip()
                return int(val) if val.isdigit() else None
    return None


def git_common_dir(repo):
    """The repo's common git dir (worktrees keep refs and reflogs there)."""
    g = os.path.join(repo, ".git")
    if os.path.isfile(g):
        with open(g) as fh:
            first = fh.readline().strip()
        if not first.startswith("gitdir:"):
            return None
        g = os.path.normpath(os.path.join(repo, first.split(":", 1)[1].strip()))
        common = os.path.join(g, "commondir")
        if os.path.isfile(common):
            with open(common) as fh:
                g = os.path.normpath(os.path.join(g, fh.readline().strip()))
    return g if os.path.isdir(g) else None


def last_push(repo):
    """Newest `update by push` timestamp in the remote-tracking reflogs, or None.
    Reflog line: `<old> <new> <who> <epoch> <tz>\\t<message>`."""
    g = git_common_dir(repo) if repo else None
    best = None
    for root, _, files in os.walk(os.path.join(g, "logs", "refs", "remotes")) if g else []:
        for name in files:
            try:
                with open(os.path.join(root, name), errors="replace") as fh:
                    for line in fh:
                        head, tab, msg = line.partition("\t")
                        parts = head.split()
                        if tab and msg.startswith("update by push") and len(parts) >= 2 and parts[-2].isdigit():
                            best = max(best or 0, int(parts[-2]))
            except OSError:
                continue
    return best


def newest_file(path, cap=5000):
    """(mtime, path) of the newest file under a scratch dir (its .owner excluded), bounded walk."""
    newest, seen = (None, None), 0
    for root, _, files in os.walk(path):
        for name in files:
            if name == ".owner" and root == path:
                continue
            seen += 1
            if seen > cap:
                return newest
            full = os.path.join(root, name)
            try:
                m = int(os.lstat(full).st_mtime)
            except OSError:
                continue
            if newest[0] is None or m > newest[0]:
                newest = (m, full)
    return newest


def owned_scratch(base, pid):
    """Scratch under <repo>/var/agent-tmp tied to the omp pid, as (work, runtime).
    work: dirs whose .owner pid is the omp pid; a respawn kills that pid and
    scratch-reaper then deletes them. runtime: the dir named exactly `omp.<pid>`,
    the process's own TMPDIR (compile caches, locks, runners; the new process
    makes omp.<newpid>) -- listed, never a hold. `omp.<otherpid>` is ordinary work."""
    work, runtime = [], []
    try:
        entries = sorted(os.scandir(base), key=lambda e: e.name)
    except OSError:
        return work, runtime
    for e in entries:
        if not e.is_dir(follow_symlinks=False):
            continue
        is_runtime = e.name == "omp.%d" % pid
        if not is_runtime:
            try:
                with open(os.path.join(e.path, ".owner")) as fh:
                    text = fh.read(4096)
            except OSError:
                continue
            if owner_pid(text) != pid:
                continue
        mtime, newest = newest_file(e.path)
        (runtime if is_runtime else work).append({"path": e.path, "newest_mtime": mtime, "newest_file": newest})
    return work, runtime


def dirt_count(repo, run_fn, cache):
    if repo not in cache:
        rc, text = run_fn(["git", "--no-optional-locks", "-C", repo, "status", "--porcelain"], None)
        cache[repo] = sum(1 for ln in text.splitlines() if ln.strip()) if rc == 0 else None
    return cache[repo]


def lsof_live(run_fn):
    def lsof(pid):
        return run_fn(["lsof", "-nP", "-p", str(pid), "-Fn"], None)[1]
    return lsof


def save_pane(pane, procs, home, lsof_fn, run_fn, dirt_cache):
    agent = core.find_agent(procs, pane["pane_pid"])
    if not agent:
        return None
    flags = agent["flags"]
    profile = profile_of(flags)
    adir = agent_dir(home, profile)
    lsof_text = lsof_fn(agent["pid"])
    cands = session_candidates(lsof_text)
    session_file, hold = pick_session(cands, resume_id(agent["args"]))
    exe = executable(lsof_text)
    repo = repo_root(pane["cwd"])
    project_dirs = [d for d in dict.fromkeys([repo, pane["cwd"]]) if d]
    row = {"pane": pane["pane"], "pane_id": pane["pane_id"], "omp_pid": agent["pid"], "flags": flags, "args": agent["args"],
           "mcp_pids": agent["mcp_pids"], "cwd": pane["cwd"], "profile": profile or "default", "agent_dir": adir,
           "model": flag_value(flags, "--model") or core.parse_screen(pane.get("screen", []))["model"],
           "screen_model": core.parse_screen(pane.get("screen", []))["model"],
           "session_file": session_file, "session_candidates": cands, "holds": [],
           "exe": exe, "exe_real": os.path.realpath(exe) if exe else None, "bun": is_bun(exe, agent["args"])}
    row["version"] = "bun" if row["bun"] else version_of(row["exe_real"])
    if session_file:
        st = os.stat(session_file) if os.path.exists(session_file) else None
        row["session_size"] = st.st_size if st else None
        row["session_mtime"] = int(st.st_mtime) if st else None
    else:
        row["holds"].append(hold)
    row["advisor"] = advisor_state(pane.get("screen", []), flags, adir)
    row["advisor"]["watchdog_files"] = watchdog_files(adir, project_dirs)
    row["repo"] = repo
    row["last_push"] = last_push(repo)
    row["owned_scratch"], row["runtime_scratch"] = owned_scratch(os.path.join(repo or pane["cwd"], "var", "agent-tmp"), agent["pid"])
    row["held_scratch"] = held_scratch(row["owned_scratch"], row["last_push"])
    # held_scratch is a loss record. It is not a send hold.
    row["repo_dirt_count"] = dirt_count(repo, run_fn, dirt_cache) if repo else None
    return row


def held_scratch(work, push):
    """Work scratch with a file newer than the repo's last push (any file when no push is known)."""
    return [s for s in work if s["newest_mtime"] is not None and (push is None or s["newest_mtime"] > push)]


def revalidate_respawn(row, inv, lsof_fn):
    """Live re-check right before a respawn send, against the row's saved facts: the
    same omp pid (HELD_DRIFT), no git child (HOLD_GIT), the saved session file still
    open (HOLD_SESSION_CHANGED). Unsaved scratch is not a hold. Returns (hold, detail)
    or (None, None)."""
    p = next((x for x in inv["panes"] if x["pane_id"] == row["pane_id"]), None)
    agent = core.find_agent(inv["procs"], p["pane_pid"]) if p else None
    if not agent or agent["pid"] != row.get("omp_pid"):
        return "HELD_DRIFT", "omp pid now %s, saved %s" % (agent["pid"] if agent else None, row.get("omp_pid"))
    git = core.git_child(inv["procs"], p["pane_pid"])
    if git:
        return "HOLD_GIT", "git child pid %s" % git["pid"]
    if row.get("session_file") not in session_candidates(lsof_fn(agent["pid"])):
        return "HOLD_SESSION_CHANGED", "%s is no longer the open session" % row.get("session_file")
    return None, None


def respawn_revalidator(inventory_fn, lsof_fn):
    """revalidate_fn for fleet_restart.send: a fresh inventory per respawn row."""
    def check(row):
        return revalidate_respawn(row, inventory_fn({row["pane_id"]}), lsof_fn)
    return check


def save(inv, home, lsof_fn, run_fn):
    cache, rows = {}, []
    for p in inv["panes"]:
        r = save_pane(p, inv["procs"], home, lsof_fn, run_fn, cache)
        if r:
            rows.append(r)
    holds = {}
    for r in rows:
        for h in r["holds"]:
            holds.setdefault(h, []).append(r["pane"])
    return {"created": core.now(), "snapshot_at": inv.get("captured_at"), "rows": rows, "holds": holds,
            "counts": {"agent_panes": len(rows), "advisor_on": sum(1 for r in rows if r["advisor"]["on"]),
                       "session_files": sum(1 for r in rows if r["session_file"])}}


def session_kept(lsof_text, session_file):
    return session_file in session_candidates(lsof_text)


def watchdog_drift(save_doc):
    """Re-hash every recorded WATCHDOG file; report, never rewrite."""
    out, seen = [], set()
    for r in save_doc["rows"]:
        for f in r["advisor"].get("watchdog_files", []):
            if f["path"] in seen:
                continue
            seen.add(f["path"])
            now = sha256_file(f["path"])
            out.append({"path": f["path"], "before": f["sha256"], "after": now,
                        "status": "SAME" if now == f["sha256"] else ("GONE" if now is None else "CHANGED")})
    return out


def _git(repo, args, index=None):
    """Git with a private index. Never reads or writes the shared index."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_TERMINAL_PROMPT"] = "0"
    if index:
        env["GIT_INDEX_FILE"] = index
    run = subprocess.run(["git", "-C", repo, *args], env=env, capture_output=True, text=True)
    return run.returncode, (run.stdout or "").strip(), (run.stderr or "").strip()


def pin_repo(repo, ref, index_path):
    """Snapshot HEAD plus the worktree into `ref` without moving the worktree or the shared index."""
    rc, _, err = _git(repo, ["rev-parse", "HEAD"])
    if rc != 0:
        return None, err or "not a git repo"
    rc, _, err = _git(repo, ["read-tree", "HEAD"], index_path)
    if rc != 0:
        return None, err
    rc, _, err = _git(repo, ["add", "-A"], index_path)
    if rc != 0:
        return None, err
    rc, tree, err = _git(repo, ["write-tree"], index_path)
    if rc != 0:
        return None, err
    rc, sha, err = _git(repo, ["commit-tree", tree, "-p", "HEAD", "-m", "fleet-restart preserve"], index_path)
    if rc != 0:
        return None, err
    rc, _, err = _git(repo, ["update-ref", ref, sha])
    if rc != 0:
        return None, err
    return sha, None


def preserve_work(save_doc, dest):
    """Pin each dirty repo and copy held scratch out of reaper roots. Failure refuses the restart."""
    os.makedirs(dest, exist_ok=True)
    stamp = os.path.basename(dest.rstrip(os.sep)) or "preserve"
    repos, scratch, error, seen = [], [], None, set()
    for row in save_doc.get("rows") or []:
        repo = row.get("repo")
        if repo and repo not in seen and row.get("repo_dirt_count"):
            seen.add(repo)
            slug = hashlib.sha256(repo.encode()).hexdigest()[:12]
            ref = "refs/preserve/fleet-restart/%s/%s" % (stamp, slug)
            sha, err = pin_repo(repo, ref, os.path.join(dest, "index-%s" % slug))
            if err:
                error = "%s: %s" % (repo, err)
                break
            repos.append({"repo": repo, "ref": ref, "sha": sha})
        for held in row.get("held_scratch") or []:
            src = held.get("path")
            pane = str(row.get("pane") or "pane").replace("/", "_")
            target = os.path.join(dest, "scratch", pane, os.path.basename(src or "scratch"))
            try:
                shutil.copytree(src, target, symlinks=True)
            except OSError as exc:
                error = "%s: %s" % (src, exc)
                break
            scratch.append({"pane": row.get("pane"), "src": src, "dest": target})
        if error:
            break
    manifest = {"ok": error is None, "repos": repos, "scratch": scratch, "error": error}
    with open(os.path.join(dest, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
        fh.write("\n")
    return manifest
