#!/usr/bin/env python3
"""beads_place.py -- CUTGRAPH1 goal-path ranking and placement commands.

`--mode rank --goal ID` applies goal-seeded personalized PageRank only to the
open goal and its open blocks prerequisites. `--mode place --title TEXT`
scores each open kind:goal subgraph by TF-IDF and prints the selected goal,
nearest target, parent, and the create/link commands. The blocks edge is added
from the target to the new issue; parent-child is grouping only.

Read-only: reads tracker JSONL (`--db` accepts an issues.jsonl file, a
beads.db whose sibling issues.jsonl is read, or a directory). Stdlib only.
Exit 0 on a ranking/recommendation, 3 when no open goal can be used, 2 on
usage or unreadable tracker.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import shlex
import sys
from collections import Counter, deque
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from bead_lint import GOAL_LABEL, GOAL_PATH_LABEL, encode_goal_path_id  # noqa: E402  (single home)

TOKEN_RE = re.compile(r"[a-z0-9]+")
STOPWORDS = frozenset(
    "a an and are as at be by for from has have in into is it its of on or "
    "that the this to was were will with not no all any each per via".split()
)


def jsonl_path(db: str) -> str:
    if os.path.isdir(db):
        for cand in (os.path.join(db, "issues.jsonl"),
                     os.path.join(db, ".beads", "issues.jsonl")):
            if os.path.isfile(cand):
                return cand
        raise FileNotFoundError(f"no issues.jsonl under {db}")
    if db.endswith(".jsonl"):
        return db
    return os.path.join(os.path.dirname(os.path.abspath(db)), "issues.jsonl")


def load_rows(db: str) -> list[dict]:
    rows = []
    with open(jsonl_path(db), encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                row = json.loads(line)
                if isinstance(row, dict) and row.get("id"):
                    rows.append(row)
    return rows


def is_open(row: dict) -> bool:
    return (row.get("status") or "open") not in ("closed", "tombstone")


def tokens(text: str) -> list[str]:
    return [t for t in TOKEN_RE.findall(text.lower())
            if len(t) > 1 and t not in STOPWORDS]


def doc_text(row: dict) -> str:
    return f"{row.get('title') or ''} {row.get('title') or ''} {row.get('description') or ''}"


def goal_paths(goal_id: str, byid: dict[str, dict]) -> dict[str, list[str]]:
    """Return shortest goal-to-blocker paths over open `blocks` edges."""
    root = byid.get(goal_id)
    if root is None or not is_open(root):
        return {}
    paths = {goal_id: [goal_id]}
    queue = deque([goal_id])
    while queue:
        bid = queue.popleft()
        deps = sorted(
            dep.get("depends_on_id") for dep in byid[bid].get("dependencies") or []
            if dep.get("type") == "blocks" and dep.get("depends_on_id") in byid
            and is_open(byid[dep["depends_on_id"]])
        )
        for dep_id in deps:
            if dep_id not in paths:
                paths[dep_id] = paths[bid] + [dep_id]
                queue.append(dep_id)
    return paths


def goal_subgraph(goal_id: str, byid: dict[str, dict]) -> list[str]:
    """The open goal plus every open bead it waits on through blocks edges."""
    return list(goal_paths(goal_id, byid))


def rank_goal(rows: list[dict], goal_id: str, *, damping: float = 0.85,
              tolerance: float = 1e-12, max_iterations: int = 1000) -> dict:
    """Goal-seeded personalized PageRank over only the open goal subgraph."""
    byid = {row["id"]: row for row in rows}
    root = byid.get(goal_id)
    paths = goal_paths(goal_id, byid)
    if root is None or not is_open(root) or GOAL_LABEL not in (root.get("labels") or []) or not paths:
        return {"verdict": "NO_OPEN_GOAL", "goal": goal_id, "ranking": [],
                "advice": f"{goal_id} is missing, closed, or not labeled {GOAL_LABEL}"}
    nodes = sorted(paths)
    node_set = set(nodes)
    dependencies = {
        node: sorted({
            dep["depends_on_id"] for dep in byid[node].get("dependencies") or []
            if dep.get("type") == "blocks" and dep.get("depends_on_id") in node_set
        })
        for node in nodes
    }
    personalization = {node: 1.0 if node == goal_id else 0.0 for node in nodes}
    scores = dict(personalization)
    delta = math.inf
    for iteration in range(1, max_iterations + 1):
        dangling = math.fsum(scores[node] for node in nodes if not dependencies[node])
        updated = {
            node: (1.0 - damping) * personalization[node] + damping * dangling * personalization[node]
            for node in nodes
        }
        for source in nodes:
            targets = dependencies[source]
            if targets:
                share = damping * scores[source] / len(targets)
                for target in targets:
                    updated[target] += share
        total = math.fsum(updated.values())
        if abs(total - 1.0) > 1e-12:
            raise ValueError(f"PageRank mass is not conserved: {total!r}")
        delta = math.fsum(abs(updated[node] - scores[node]) for node in nodes)
        scores = updated
        if delta < tolerance:
            break
    else:
        return {"verdict": "NO_CONVERGENCE", "goal": goal_id, "ranking": [],
                "iterations": max_iterations, "delta": delta}
    ranking = sorted(
        ({"id": node, "title": byid[node].get("title") or "",
          "score": scores[node], "path": list(reversed(paths[node]))} for node in nodes),
        key=lambda row: (-row["score"], row["id"]),
    )
    return {"verdict": "RANKED", "goal": {"id": goal_id, "title": byid[goal_id].get("title") or ""},
            "node_count": len(nodes), "iterations": iteration, "delta": delta,
            "ranking": ranking}


def parent_of(row: dict, byid: dict[str, dict]) -> str | None:
    for dep in row.get("dependencies") or []:
        pid = dep.get("depends_on_id")
        if dep.get("type") == "parent-child" and pid in byid and is_open(byid[pid]):
            return pid
    return None


def place(rows: list[dict], title: str, description: str = "") -> dict:
    byid = {r["id"]: r for r in rows}
    goals = sorted((r for r in rows if GOAL_LABEL in (r.get("labels") or []) and is_open(r)),
                   key=lambda r: r["id"])
    if not goals:
        return {"verdict": "NO_OPEN_GOAL", "goals": [],
                "advice": "no open kind:goal bead; create it with --labels kind:intake"}
    members = {g["id"]: [b for b in goal_subgraph(g["id"], byid) if is_open(byid[b])]
               for g in goals}
    corpus = sorted({b for ids in members.values() for b in ids})
    tf = {b: Counter(tokens(doc_text(byid[b]))) for b in corpus}
    df: Counter = Counter()
    for counts in tf.values():
        df.update(counts.keys())
    n = len(corpus)

    def vec(counts: Counter) -> dict[str, float]:
        return {t: c * (math.log((1 + n) / (1 + df[t])) + 1.0) for t, c in counts.items()}

    def cosine(a: dict[str, float], b: dict[str, float]) -> float:
        dot = sum(w * b.get(t, 0.0) for t, w in a.items())
        na = math.sqrt(sum(w * w for w in a.values()))
        nb = math.sqrt(sum(w * w for w in b.values()))
        return dot / (na * nb) if na and nb else 0.0

    query = vec(Counter(tokens(f"{title} {title} {description}")))
    score = {b: round(cosine(query, vec(tf[b])), 6) for b in corpus}
    ranking = []
    for g in goals:
        ranked = sorted(members[g["id"]], key=lambda b: (-score[b], b))
        ranking.append({"goal": g["id"], "title": g.get("title") or "",
                        "score": score[ranked[0]] if ranked else 0.0,
                        "nearest": [{"id": b, "title": byid[b].get("title") or "",
                                     "score": score[b]} for b in ranked[:5]]})
    ranking.sort(key=lambda r: (-r["score"], r["goal"]))
    best = ranking[0]
    target = best["nearest"][0]["id"] if best["nearest"] else best["goal"]
    parent = parent_of(byid[target], byid) or parent_of(byid[best["goal"]], byid)
    create = ["br", "create", "--title", title]
    if description:
        create += ["--description", description]
    create += ["--labels", GOAL_PATH_LABEL + encode_goal_path_id(target)]
    if parent:
        create += ["--parent", parent]
    return {
        "verdict": "PLACED",
        "goal": {"id": best["goal"], "title": best["title"], "score": best["score"]},
        "target": best["nearest"][0] if best["nearest"] else {"id": target, "score": 0.0},
        "parent": parent,
        "commands": [shlex.join(create), f"br dep add {target} <NEW_ID>"],
        "ranking": ranking,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--mode", choices=("place", "rank"), default="place")
    ap.add_argument("--goal", help="goal bead ID (required with --mode rank)")
    ap.add_argument("--title")
    ap.add_argument("--description", default="")
    ap.add_argument("--db", default=os.path.join(".beads", "issues.jsonl"),
                    help="tracker JSONL, beads.db (sibling issues.jsonl is read) or directory")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    if args.mode == "rank" and (not args.goal or args.title is not None):
        ap.error("--mode rank requires --goal and forbids --title")
    if args.mode == "place" and (not args.title or args.goal is not None):
        ap.error("--mode place requires --title and forbids --goal")
    try:
        rows = load_rows(args.db)
    except (OSError, ValueError) as exc:
        print(f"beads_place: cannot read tracker: {exc}", file=sys.stderr)
        return 2
    result = rank_goal(rows, args.goal) if args.mode == "rank" else place(rows, args.title, args.description)
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    elif result["verdict"] == "RANKED":
        print(f"goal: {result['goal']['id']}  {result['goal']['title']}")
        for row in result["ranking"]:
            print(f"{row['score']:.12f}  {row['id']}  {' -> '.join(row['path'])}")
    elif result["verdict"] == "PLACED":
        print(f"goal:   {result['goal']['id']}  {result['goal']['title']}")
        print(f"target: {result['target']['id']}  (score {result['target']['score']})")
        for step, cmd in enumerate(result["commands"], 1):
            print(f"{step}. {cmd}")
    else:
        print(result.get("advice", result["verdict"]))
    return 0 if result["verdict"] in ("RANKED", "PLACED") else 3


if __name__ == "__main__":
    sys.exit(main())
