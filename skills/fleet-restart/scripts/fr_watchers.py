"""fleet-restart watchers stage: classify launchd jobs, pause the pane actors and
state mutators for the length of a restart, resume exactly what was paused.

Every launchctl call goes through an injected run_fn(argv, env) -> (rc, text);
the selftest drives it with a fake. A dead-man LaunchAgent resumes the watchers
if the run dies before its finally block. Stdlib only, no regex."""
import datetime
import glob
import json
import os
import plistlib
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REGISTRY_PATH = os.path.join(os.path.dirname(HERE), "watchers.json")
SCRIPT_PATH = os.path.join(HERE, "fleet_restart.py")
DEADMAN_PREFIX = "com.omp-kit.fleet-restart-resume."
DEADMAN_INTERVAL = 300
# Pane-actor signatures, matched on text normalized to single spaces with quotes,
# commas and brackets removed (so ["tmux", "send-keys"] and `tmux -L x send-keys` match).
SIGNATURES = ("send-keys", "respawn-pane", " ntm send ", " omp-kit send ")
SCRIPT_CAP = 2_000_000
PUNCT = str.maketrans({c: " " for c in "\"'`,;|&()[]{}"})
PAUSED = "watchers-paused.json"
RESUMED = "watchers-resumed.json"


def iso(epoch):
    return datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_registry(path=REGISTRY_PATH):
    with open(path) as fh:
        return json.load(fh)["jobs"]


def signatures_in(text):
    flat = " " + " ".join(text.translate(PUNCT).split()) + " "
    return [s.strip() for s in SIGNATURES if s in flat]


def read_script(path):
    """Text of a script file an argument names; None for binaries, huge or unreadable files."""
    try:
        if not os.path.isfile(path) or os.path.getsize(path) > SCRIPT_CAP:
            return None
        with open(path, "rb") as fh:
            data = fh.read()
    except OSError:
        return None
    if b"\0" in data[:4096]:
        return None
    return data.decode("utf-8", "replace")


def is_loaded(run_fn, uid, label):
    rc, _ = run_fn(["launchctl", "print", "gui/%d/%s" % (uid, label)], None)
    return rc == 0


def discover(agents_dir, registry, run_fn, uid):
    """Every *.plist in agents_dir, classified. Unreadable plists are reported, not fatal."""
    jobs, unreadable = [], []
    for path in sorted(glob.glob(os.path.join(agents_dir, "*.plist"))):
        try:
            with open(path, "rb") as fh:
                data = plistlib.load(fh)
            if not isinstance(data, dict):
                raise ValueError("plist root is not a dict")
        except Exception as exc:  # malformed plist: report, keep going
            unreadable.append({"plist": path, "error": "%s: %s" % (type(exc).__name__, exc)})
            continue
        label = str(data.get("Label") or os.path.basename(path)[:-len(".plist")])
        args = data.get("ProgramArguments") or ([data["Program"]] if data.get("Program") else [])
        args = [str(a) for a in args] if isinstance(args, list) else [str(args)]
        row = {"label": label, "plist": path, "loaded": is_loaded(run_fn, uid, label)}
        reg = registry.get(label)
        if label.startswith(DEADMAN_PREFIX):
            row.update({"registered": False, "class": "dead-man", "pause": False, "status": "DEADMAN"})
        elif reg:
            row.update({"registered": True, "class": reg["class"], "pause": bool(reg["pause"]), "status": "REGISTERED"})
        else:
            sigs, scanned = signatures_in(" ".join(args)), []
            for a in args:
                p = os.path.expanduser(a)
                if not os.path.isabs(p):
                    continue
                text = read_script(p)
                if text is not None:
                    scanned.append(p)
                    sigs += [s for s in signatures_in(text) if s not in sigs]
            row.update({"registered": False, "class": "unregistered", "pause": False, "signatures": sigs, "scanned": scanned})
            # A job that is not loaded cannot act during the run; it is reported, not held.
            row["status"] = ("HOLD_UNCLASSIFIED" if row["loaded"] else "UNCLASSIFIED_NOT_LOADED") if sigs else "UNREGISTERED"
        jobs.append(row)
    seen = {j["label"] for j in jobs}
    missing = sorted(set(registry) - seen)
    return {"agents_dir": agents_dir, "jobs": jobs, "unreadable": unreadable, "registered_missing": missing,
            "unclassified": [j["label"] for j in jobs if j["status"] == "HOLD_UNCLASSIFIED"],
            "pause_plan": [j["label"] for j in jobs if j.get("pause") and j["loaded"]],
            "deadman_left": [j["label"] for j in jobs if j["status"] == "DEADMAN"]}


def pause_plan_manifest(disc):
    """Standalone `watchers pause` approval target: bound to the exact labels it boots out."""
    return {"kind": "watchers-pause", "rows": [{"pane": label, "label": label} for label in disc["pause_plan"]]}


def deadman_label(run_dir):
    return DEADMAN_PREFIX + os.path.basename(os.path.normpath(run_dir)).replace(" ", "_")


def deadman_plist(run_dir, label, python):
    return {"Label": label, "ProgramArguments": [python, SCRIPT_PATH, "watchers", "resume", "--run", run_dir, "--if-expired", "--apply"],
            "StartInterval": DEADMAN_INTERVAL, "RunAtLoad": False, "ProcessType": "Background",
            "EnvironmentVariables": {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR": run_dir},
            "StandardOutPath": os.path.join(run_dir, "deadman.out.log"), "StandardErrorPath": os.path.join(run_dir, "deadman.err.log")}


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(obj, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, path)


def read_json(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None


def pause(run_dir, disc, run_fn, uid, now_epoch, ttl_min=90, apply=False, python=None):
    """Dry run by default. Apply: install the dead-man first (a failed install aborts
    before any bootout), then boot out each loaded pause:true job, recording every row."""
    path = os.path.join(run_dir, PAUSED)
    prior = read_json(path) or {}
    carried = {r["label"]: r for r in prior.get("rows", []) if r.get("action") == "BOOTED_OUT" and not r.get("resumed")}
    rows = []
    for j in disc["jobs"]:
        if not j.get("pause"):
            continue
        if j["label"] in carried and not j["loaded"]:
            rows.append(dict(carried.pop(j["label"]), carried=True))  # paused by an earlier attempt of this run
            continue
        rows.append({"label": j["label"], "plist": j["plist"], "was_loaded": j["loaded"],
                     "action": "WOULD_BOOTOUT" if j["loaded"] else "SKIP_NOT_LOADED"})
    rows += [dict(r, carried=True) for r in carried.values()]
    label = deadman_label(run_dir)
    record = {"run_dir": run_dir, "paused_at": iso(now_epoch), "paused_epoch": now_epoch, "expires_at": iso(now_epoch + ttl_min * 60),
              "expires_epoch": now_epoch + ttl_min * 60, "ttl_min": ttl_min, "deadman": {"label": label, "plist": os.path.join(disc["agents_dir"], label + ".plist")},
              "rows": rows}
    if not apply:
        record["mode"] = "DRY_RUN"
        return record
    record["mode"] = "APPLY"
    dm = record["deadman"]
    with open(dm["plist"], "wb") as fh:
        plistlib.dump(deadman_plist(run_dir, label, python or default_python()), fh)
    if not is_loaded(run_fn, uid, label):
        rc, out = run_fn(["launchctl", "bootstrap", "gui/%d" % uid, dm["plist"]], None)
        dm.update({"rc": rc, "out": out[-300:]})
    dm["loaded"] = is_loaded(run_fn, uid, label)
    if not dm["loaded"]:
        os.unlink(dm["plist"])
        record["refused"] = "DEADMAN_NOT_LOADED"
        for r in rows:
            if r["action"] == "WOULD_BOOTOUT":
                r["action"] = "NOT_PAUSED"
        write_json(path, record)
        return record
    write_json(path, record)
    for r in rows:
        if r["action"] != "WOULD_BOOTOUT":
            continue
        rc, out = run_fn(["launchctl", "bootout", "gui/%d/%s" % (uid, r["label"])], None)
        r.update({"rc": rc, "out": out[-300:], "at": iso(now_epoch)})
        r["action"] = "BOOTED_OUT" if not is_loaded(run_fn, uid, r["label"]) else "BOOTOUT_FAILED"
        write_json(path, record)
    return record


def default_python():
    return "/usr/bin/python3" if os.path.exists("/usr/bin/python3") else sys.executable


def resume(run_dir, run_fn, uid, now_epoch, if_expired=False, apply=False):
    """Bootstrap exactly the rows this run booted out, verify each is loaded, remove
    the dead-man. Idempotent: a second call finds every row loaded and no dead-man."""
    record = read_json(os.path.join(run_dir, PAUSED))
    if not record:
        return {"result": "NOTHING_PAUSED", "rows": []}
    if if_expired and now_epoch < record["expires_epoch"]:
        return {"result": "NOT_EXPIRED", "expires_at": record["expires_at"], "rows": []}
    todo = [r for r in record["rows"] if r.get("action") == "BOOTED_OUT"]
    out = {"run_dir": run_dir, "at": iso(now_epoch), "mode": "APPLY" if apply else "DRY_RUN", "if_expired": if_expired, "rows": []}
    if not apply:
        out["rows"] = [{"label": r["label"], "action": "WOULD_BOOTSTRAP"} for r in todo]
        return out
    for r in todo:
        row = {"label": r["label"], "plist": r["plist"]}
        if is_loaded(run_fn, uid, r["label"]):
            row["action"] = "ALREADY_LOADED"
        else:
            rc, text = run_fn(["launchctl", "bootstrap", "gui/%d" % uid, r["plist"]], None)
            row.update({"rc": rc, "out": text[-300:]})
            row["action"] = "RESUMED" if is_loaded(run_fn, uid, r["label"]) else "RESUME_FAILED"
        out["rows"].append(row)
    dm = record["deadman"]
    out["result"] = "RESUMED" if all(r["action"] in ("RESUMED", "ALREADY_LOADED") for r in out["rows"]) else "RESUME_FAILED"
    if out["result"] == "RESUMED":
        for r in record["rows"]:
            if r.get("action") == "BOOTED_OUT":
                r["resumed"] = out["at"]
        write_json(os.path.join(run_dir, PAUSED), record)
    out["deadman"] = {"label": dm["label"], "removed": out["result"] == "RESUMED"}
    write_json(os.path.join(run_dir, RESUMED), out)
    if out["result"] == "RESUMED":
        # The dead-man may be the caller: write the record first, boot it out last.
        if os.path.exists(dm["plist"]):
            os.unlink(dm["plist"])
        if is_loaded(run_fn, uid, dm["label"]):
            run_fn(["launchctl", "bootout", "gui/%d/%s" % (uid, dm["label"])], None)
    return out
