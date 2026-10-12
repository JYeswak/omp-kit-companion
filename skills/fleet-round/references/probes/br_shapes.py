"""Read-only projection of br JSON output shapes (fleet-round evidence probe).

Runs br with --no-auto-import --no-auto-flush (no tracker writes) and prints only key names,
enum values and edge shapes, so the REA capture stays small.
"""
import collections
import json
import subprocess
import sys

FLAGS = ["--json", "--no-auto-import", "--no-auto-flush"]


def br(*args):
    out = subprocess.run(["br", *args, *FLAGS], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


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
