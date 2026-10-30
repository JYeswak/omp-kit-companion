#!/usr/bin/env python3
"""beads_place.py -- CUTGRAPH1 box e (ompkit-774u.61): where does a new bead go?

Lists the open kind:goal beads, ranks the open beads on each goal's blocks path
(the goal and every bead it waits on through blocks edges, any depth) by TF-IDF
cosine similarity to the new bead's text, and prints the recommended goal, the
nearest bead the new bead should block, and the two commands that place it:

  1. br create --title ... --labels goal-path:<target> [--parent <epic>]
  2. br dep add <target> <NEW_ID>      (the target waits on the new bead)

parent-child is grouping only; the blocks edge from step 2 is what satisfies
bead_lint m-goal-path. Read-only: reads the tracker's JSONL export (--db takes
a .jsonl file, a beads.db whose sibling issues.jsonl is read, or a directory
holding issues.jsonl or .beads/issues.jsonl). Stdlib only.

Exit 0 recommendation printed, 3 no open goal (label the bead kind:intake),
2 usage or unreadable tracker.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import shlex
import sys
from collections import Counter

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


def goal_subgraph(goal_id: str, byid: dict[str, dict]) -> list[str]:
    """The goal plus every bead it waits on through blocks edges, any depth."""
    seen: list[str] = []
    queue = [goal_id]
    while queue:
        bid = queue.pop(0)
        if bid in seen or bid not in byid:
            continue
        seen.append(bid)
        for dep in byid[bid].get("dependencies") or []:
            if dep.get("type") == "blocks":
                queue.append(dep.get("depends_on_id"))
    return seen


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
    ap.add_argument("--title", required=True)
    ap.add_argument("--description", default="")
    ap.add_argument("--db", default=os.path.join(".beads", "issues.jsonl"),
                    help="tracker JSONL, beads.db (sibling issues.jsonl is read) or directory")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    try:
        rows = load_rows(args.db)
    except (OSError, ValueError) as exc:
        print(f"beads_place: cannot read tracker: {exc}", file=sys.stderr)
        return 2
    result = place(rows, args.title, args.description)
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    elif result["verdict"] == "PLACED":
        print(f"goal:   {result['goal']['id']}  {result['goal']['title']}")
        print(f"target: {result['target']['id']}  (score {result['target']['score']})")
        for step, cmd in enumerate(result["commands"], 1):
            print(f"{step}. {cmd}")
    else:
        print(result["advice"])
    return 0 if result["verdict"] == "PLACED" else 3


if __name__ == "__main__":
    sys.exit(main())
