"""Read-only evidence probe: how br stores dependency edges.

Prints the dependency-type histogram across every bead with edges, the (dependent status,
blocker status) pairs of every `blocks` edge, and each edge where a status=blocked bead depends
on a closed bead. Runs br with --no-auto-import --no-auto-flush, so the tracker is never written.
Run from a tracker root: python3 edge_shapes.py
"""
import collections
import json
from br_shapes import checked_output

FLAGS = ["--json", "--no-auto-import", "--no-auto-flush"]
rows = json.loads(checked_output(["br", "list", "--all", "--limit", "0", *FLAGS]))["issues"]
ids = [r["id"] for r in rows if r.get("dependency_count", 0) > 0]
shown = json.loads(checked_output(["br", "show", *ids, *FLAGS])) if ids else []
edges = [(x, e) for x in shown for e in x.get("dependencies") or []]
print("dependency_types", dict(sorted(collections.Counter(e["dependency_type"] for _, e in edges).items())))
print("edge_keys", sorted({k for _, e in edges for k in e}))
pairs = collections.Counter((x["status"], e["status"]) for x, e in edges if e["dependency_type"] == "blocks")
print("blocks_pairs(dependent,blocker)", dict(sorted(pairs.items())))
for x, e in edges:
    if e["dependency_type"] == "blocks" and x["status"] == "blocked" and e["status"] == "closed":
        print("blocked_on_closed", x["id"], "->", e["id"])
