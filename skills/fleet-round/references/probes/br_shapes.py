"""Read-only projection of br JSON output shapes (fleet-round evidence probe).

Runs br with --no-auto-import --no-auto-flush (no tracker writes) and prints only key names,
enum values and edge shapes, so the REA capture stays small.
"""
from __future__ import annotations

import collections
import importlib
import json
import locale
from pathlib import Path
import shutil
import subprocess
import sys
from types import ModuleType


def _runner() -> ModuleType:
    root = Path(__file__).resolve().parents[4]
    try:
        package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        package = {}
    if package.get("name") != "omp-kit-companion":
        launcher = shutil.which("omp-kit")
        if launcher is None:
            raise RuntimeError("fleet-round probes require an installed omp-kit runner")
        root = Path(launcher).resolve().parent.parent
    sys.path.insert(0, str(root / "scripts"))
    return importlib.import_module("kitlib_run")


def checked_output(argv: list[str]) -> str:
    result = _runner().run(argv, deadline_s=60, max_output_bytes=16 * 1024 * 1024)
    if result.timed_out:
        raise subprocess.TimeoutExpired(argv, 60, output=result.stdout, stderr=result.stderr)
    if result.truncated:
        raise RuntimeError("fleet-round probe output exceeded its capture bound: %s" % argv[0])
    if result.rc != 0:
        raise subprocess.CalledProcessError(result.rc, argv, output=result.stdout, stderr=result.stderr)
    return result.stdout.decode(locale.getpreferredencoding(False)).replace("\r\n", "\n").replace("\r", "\n")

FLAGS = ["--json", "--no-auto-import", "--no-auto-flush"]


def br(*args):
    out = checked_output(["br", *args, *FLAGS])
    return json.loads(out)


if __name__ == "__main__":
    which = sys.argv[1]
    if which == "list":
        d = br("list", "--all", "--limit", "0")
        print("envelope_keys", sorted(d.keys()))
        print("row_keys", sorted(d["issues"][0].keys()))
        print("status_counts", dict(sorted(collections.Counter(i["status"] for i in d["issues"]).items())))
        print("issue_type_counts", dict(sorted(collections.Counter(i["issue_type"] for i in d["issues"]).items())))
    elif which == "show":
        d = br("show", *sys.argv[2:])
        print("top_type", type(d).__name__, len(d))
        for x in d:
            print("id", x["id"], "parent", json.dumps(x.get("parent")))
            print(" keys", sorted(x.keys()))
            print(" dependencies", json.dumps([{k: e.get(k) for k in ("id", "status", "dependency_type")} for e in x.get("dependencies") or []]))
            print(" dependents", json.dumps([{k: e.get(k) for k in ("id", "status", "dependency_type")} for e in (x.get("dependents") or [])[:3]]))
            print(" comment_keys", sorted((x.get("comments") or [{}])[0].keys()))
    elif which == "ready":
        d = br("ready", "--limit", "0")
        print("top_type", type(d).__name__, len(d))
        print("row_keys", sorted(d[0].keys()) if d else [])
        print("first", [(x["id"], x["status"], x["issue_type"]) for x in d[:5]])
    elif which == "cycles":
        print(json.dumps(br("dep", "cycles")))
