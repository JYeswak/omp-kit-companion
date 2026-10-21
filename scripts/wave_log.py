#!/usr/bin/env python3
"""wave_log: append workflow waves only after staged disk admission.

DISKSTAGE-WIRE1 keeps the admission check in this real entrypoint, before any
ledger mutation.  The observer is statvfs only; sbh is deliberately not part
of this portable companion script.  A STOP/CRITICAL result records and
requests the native scratch reaper, then refuses the wave with a named code.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
import platform
import sys
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from pathlib import Path
from pysafe import run_bounded  # noqa: E402
BEAD = "ompkit-774u.9.8.1"
WARN_BELOW = 20.0
STOP_BELOW = 10.0
CRITICAL_BELOW = 5.0

def free_pct(path: str) -> float | None:
    try:
        stat = os.statvfs(path)
    except OSError:
        return None
    if stat.f_blocks <= 0 or stat.f_bavail < 0:
        return None
    return max(0.0, min(100.0, 100.0 * stat.f_bavail / stat.f_blocks))


def stage(pct: float | None) -> str:
    if pct is None:
        return "unknown"
    if pct < CRITICAL_BELOW:
        return "critical"
    if pct < STOP_BELOW:
        return "stop"
    if pct < WARN_BELOW:
        return "warn"
    return "ok"


def state_dir(explicit: str | None) -> Path:
    selected = explicit or os.environ.get("OMPKIT_DISK_STAGE_STATE")
    if selected:
        return Path(selected)
    return Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local" / "state"))) / "omp-kit" / "disk-stage"


def write_receipt(root: Path, current_stage: str, pct: float | None, action: str, detail: dict | None = None) -> Path:
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = root / "receipts.jsonl"
    row = {"ts": dt.datetime.now(dt.timezone.utc).isoformat(), "bead": BEAD,
           "stage": current_stage, "free_pct": pct, "observer": "statvfs", "action": action}
    if detail:
        row.update(detail)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, sort_keys=True) + "\n")
    return path


def native_reaper() -> dict:
    if platform.system() == "Darwin":
        command = ["launchctl", "kickstart", "gui/%s/com.omp-kit.scratch-reaper" % os.getuid()]
    elif platform.system() == "Linux":
        command = ["systemctl", "--user", "start", "omp-kit-scratch-reaper.service"]
    else:
        return {"action": "UNSUPPORTED", "command": None, "code": None, "stdout": "", "stderr": ""}
    try:
        result = run_bounded(command, timeout=30)
        stdout = result.text("stdout")[-2000:]
        stderr = result.text("stderr")[-2000:]
        code = result.returncode if result.outcome == "OK" else 124
        return {"action": "RECLAIM_TRIGGERED" if code == 0 else "RECLAIM_TRIGGER_FAILED",
                "command": command, "code": code, "stdout": stdout, "stderr": stderr}
    except (OSError, ValueError) as error:
        return {"action": "RECLAIM_TRIGGER_FAILED", "command": command, "code": 127,
                "stdout": "", "stderr": str(error)}


def append_wave(root: Path, repo: str, kind: str, beads: list[str], agent: str) -> str:
    ledger = root / "waves.jsonl"
    lock_path = root / "waves.lock"
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    wave = "W-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + f"-{os.getpid()}"
    row = {"schema_version": 1, "event": "open", "wave": wave, "repo": os.path.realpath(repo),
           "kind": kind, "beads": beads, "agent": agent, "at": dt.datetime.now(dt.timezone.utc).isoformat()}
    with lock_path.open("a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        with ledger.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, sort_keys=True) + "\n")
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
    return wave


def open_wave(args: argparse.Namespace) -> int:
    root = state_dir(args.state_dir)
    pct = free_pct(args.path)
    current_stage = stage(pct)
    if current_stage == "unknown":
        write_receipt(root, current_stage, pct, "observer-unavailable")
        print("DISK_OBSERVER_UNAVAILABLE")
        return 69
    if current_stage in ("stop", "critical"):
        action = native_reaper()
        write_receipt(root, current_stage, pct, "wave-refused", {"code": "DISK_WAVE_REFUSED", "reaper": action})
        print("DISK_WAVE_REFUSED")
        return 10
    beads = [item for item in (args.beads or "").split(",") if item]
    wave = append_wave(root / "waves", args.repo, args.kind, beads, args.agent or os.environ.get("AGENT_NAME", "unknown"))
    write_receipt(root, current_stage, pct, "wave-admit", {"wave": wave})
    if args.json:
        print(json.dumps({"overall": "OK", "wave": wave, "stage": current_stage, "free_pct": pct, "observer": "statvfs"}, sort_keys=True))
    else:
        print(f"WAVE_OPEN {wave} stage={current_stage} free={pct:.1f}% observer=statvfs")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="wave_log.py")
    sub = parser.add_subparsers(dest="command", required=True)
    opening = sub.add_parser("open")
    opening.add_argument("--repo", default=os.getcwd())
    opening.add_argument("--kind", choices=("build", "grade", "cleanup"), default="build")
    opening.add_argument("--beads", default="")
    opening.add_argument("--agent")
    opening.add_argument("--path", default=os.getcwd())
    opening.add_argument("--state-dir")
    opening.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    if args.command == "open":
        return open_wave(args)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
