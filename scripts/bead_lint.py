#!/usr/bin/env python3
"""bead_lint.py -- upstream home of the bead-lint north-star checks + pagerank-cert block.

Provenance: ported verbatim from
skill-library-growth/scripts/bead-lint.py at d621765876faafb542d19f397e5b0e3d3e6dbc39
(bead skill-library-growth-4ov9; rz5.119 bead-lint merge open item).
Semantics are byte-identical except two parameterized defaults that preserve
exact behavior at their defaults: check_g(label/plan/section_re) and
check_j(stale_days), plus scope_beads(parked_label).

Single-home rule: this module OWNS every symbol it defines. The growth
scripts/bead-lint.py imports them (fail-closed exit 2 when this home is
missing) and keeps only live-tool composition (br/bv/omp-kit doctor),
dispositions, receipt assembly and its CLI. A check that fires via the
growth gate fires identically here: same code objects, proven by both
--selftest suites.

Check catalog (all trace to the beads-north-star standard):
  a-label  b-what-why-acc  c-lettered-scope  d-negative-specimen
  e-typed-edges  f-fanout-depth  g-eco-plan-cite  h-placeholders
  i-mention-edges  j-stale-blocked (warning)  k-close-receipt
  l-ac-phase  l-ac-phase-legacy (warning)
l-ac-phase (ACPHASE1 ompkit-9e9w6): every acceptance item of a bead created
at or after ac_phase.AC_PHASE_CUTOVER carries exactly one phase tag
([build] | [landed] | [live] | [after <window>]) in the leading run of
bracketed tokens after its checkbox (scope letters may share the run; zero
tags is AC_PHASE_UNTAGGED, two or more AC_PHASE_MULTI); beads created before it
are reported under l-ac-phase-legacy and never refused. Grammar, cutover and
digest live in ac_phase.py, shared with the create and in_review gates.
Pagerank block: build_pagerank_fixture + run_pagerank_cert (replay via
bv-readiness-probe.sh pagerank-cert; bv --robot-next is a composite
scheduler score and is never the centrality sink).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import kitlib_tmp  # noqa: E402  (owned temp dirs: removed on exit and HUP/INT/TERM)
import ac_phase  # noqa: E402  (ACPHASE1 phase grammar and cutover; sibling in every release)

KIT_BEAD_LINT_VERSION = "bead-lint.kit/v1"
DAMPING = 0.85
TOLERANCE = 1e-9
def _default_probe() -> str:
    env = os.environ.get("BV_READINESS_PROBE", "")
    if env:
        return env
    return os.path.join(
        os.environ.get("HOME", ""),
        "Developer/flywheel/.flywheel/scripts/bv-readiness-probe.sh",
    )


PROBE_DEFAULT = _default_probe()
ALLOWED_DEP_TYPES = {"blocks", "parent-child", "related", "discovered-from"}
STALE_DAYS = 14

CHECKBOX_RE = re.compile(r"^\s*-\s*\[[ xX]\]", re.M)
WHAT_RE = re.compile(r"\bWHAT\s*:")
WHY_RE = re.compile(r"\bWHY\s*:")
SCOPE_LETTER_RE = re.compile(r"\(([a-z])\)")
BOX_CITE_RE = re.compile(r"\[([a-z](?:\s*[,;]\s*[a-z])*)\]")
NEGATIVE_RE = re.compile(
    r"plant|known-?bad|negativ|mutant|fire|refus|reject", re.I
)
PLACEHOLDER_RE = re.compile(r"TODO|TBD|<\.\.\.>|<…>|\?\?\?")
BEAD_MENTION_RE = re.compile(
    r"\b([a-z][a-z0-9]*(?:-[a-z0-9]+)+(?:\.[0-9]+(?:\.[0-9]+)*)?)\b"
)
BEAD_RELATION_WORD_RE = re.compile(r"[a-z]+")
ECO_SECTION_RE = re.compile(r"(?i)\bsection\b|\bsec\.\s*\d|§")


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_iso(ts: str) -> datetime | None:
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None


def run(cmd: list[str], cwd: str, timeout: int = 180) -> tuple[int, str, str]:
    try:
        p = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout,
            stdin=subprocess.DEVNULL,  # pysafe(subprocess-orphan): callers pass only single-process leaf binaries (`br` tracker reads/writes, pagerank-cert probe) with no descendants; the timeout bounds each call
        )
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError as e:
        return 127, "", f"not found: {e}"
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout}s: {' '.join(cmd)}"


def scope_beads(
    beads: list[dict], parked_label: str = "parked"
) -> list[dict]:
    return [
        b
        for b in beads
        if b.get("status") != "closed"
        and parked_label not in (b.get("labels") or [])
    ]


def nonclosed_beads(beads: list[dict]) -> list[dict]:
    return [b for b in beads if b.get("status") != "closed"]

def check_a(beads: list[dict]) -> list[str]:
    return [b["id"] for b in beads if not b.get("labels")]


def has_what_why(desc: str) -> bool:
    return bool(WHAT_RE.search(desc) and WHY_RE.search(desc))


def check_b(beads: list[dict]) -> list[str]:
    bad = []
    for b in beads:
        desc = b.get("description") or ""
        acc = b.get("acceptance_criteria") or ""
        if not has_what_why(desc):
            bad.append(b["id"])
        elif not acc.strip() or not CHECKBOX_RE.search(acc):
            bad.append(b["id"])
    return bad


def what_segment(desc: str) -> str:
    m = WHY_RE.search(desc)
    return desc[: m.start()] if m else desc


def box_cites(box_line: str) -> set[str]:
    stripped = re.sub(r"^\s*-\s*\[[ xX]\]\s*", "", box_line)
    out: set[str] = set()
    for m in BOX_CITE_RE.finditer(stripped):
        for part in re.split(r"[,;]", m.group(1)):
            part = part.strip()
            if len(part) == 1:
                out.add(part)
    return out


def iter_box_lines(acc: str) -> list[str]:
    return [
        line
        for line in (acc or "").splitlines()
        if re.match(r"^\s*-\s*\[[ xX]\]", line)
    ]


def check_c(beads: list[dict]) -> list[str]:
    bad = []
    for b in beads:
        seg = what_segment(b.get("description") or "")
        scope = set(SCOPE_LETTER_RE.findall(seg))
        if not scope:
            continue
        lines = iter_box_lines(b.get("acceptance_criteria") or "")
        cited: set[str] = set()
        empty_box = False
        for line in lines:
            cites = box_cites(line)
            if not cites:
                empty_box = True
            cited |= cites
        if empty_box or (scope - cited):
            bad.append(b["id"])
    return bad


def check_d(beads: list[dict]) -> list[str]:
    return [
        b["id"]
        for b in beads
        if not NEGATIVE_RE.search(b.get("acceptance_criteria") or "")
    ]


def check_e(beads: list[dict]) -> list[str]:
    bad = []
    for b in beads:
        for dep in b.get("dependencies") or []:
            if dep.get("type") not in ALLOWED_DEP_TYPES:
                bad.append(b["id"])
                break
    return bad

def dep_targets_in_scope(
    beads: list[dict], scope_ids: set[str]
) -> dict[str, list[str]]:
    return {
        b["id"]: [
            d.get("depends_on_id")
            for d in (b.get("dependencies") or [])
            if d.get("depends_on_id") in scope_ids
        ]
        for b in beads
    }


def check_f(beads: list[dict]) -> tuple[list[str], dict[str, str]]:
    scope_ids = {b["id"] for b in beads}
    targets = dep_targets_in_scope(beads, scope_ids)
    children: dict[str, list[str]] = {bid: [] for bid in scope_ids}
    for src, tgts in targets.items():
        for t in tgts:
            children[t].append(src)
    bad: set[str] = set()
    detail: dict[str, str] = {}
    for bid, ch in children.items():
        if len(ch) > 20:
            bad.add(bid)
            detail[bid] = f"fanout {len(ch)} > 20"
    sys.setrecursionlimit(max(10000, len(beads) * 4 + 100))
    memo: dict[str, int | None] = {}

    def depth(bid: str, stack: frozenset[str]) -> int | None:
        if bid in memo:
            return memo[bid]
        if bid in stack:
            memo[bid] = None
            return None
        ds = []
        for t in targets.get(bid, []):
            d = depth(t, stack | {bid})
            if d is None:
                memo[bid] = None
                return None
            ds.append(d)
        memo[bid] = (1 + max(ds)) if ds else 0
        return memo[bid]

    for b in beads:
        d = depth(b["id"], frozenset())
        if d is not None and d > 4:
            bad.add(b["id"])
            detail[b["id"]] = f"chain depth {d} > 4"
    return sorted(bad), detail


def check_g(
    beads: list[dict],
    label: str = "eco",
    plan: str = "PLAN_eco.md",
    section_re: re.Pattern = ECO_SECTION_RE,
) -> list[str]:
    bad = []
    for b in beads:
        if label not in (b.get("labels") or []):
            continue
        text = (b.get("description") or "") + "\n" + (
            b.get("acceptance_criteria") or ""
        )
        if plan not in text or not section_re.search(text):
            bad.append(b["id"])
    return bad


def check_h(beads: list[dict]) -> list[str]:
    bad = []
    for b in beads:
        text = (
            (b.get("title") or "")
            + "\n"
            + (b.get("description") or "")
            + "\n"
            + (b.get("acceptance_criteria") or "")
        )
        if PLACEHOLDER_RE.search(text):
            bad.append(b["id"])
    return bad


def check_i(
    beads: list[dict],
    byid: set[str],
    graph_beads: list[dict] | None = None,
) -> list[str]:
    edge_types: dict[tuple[str, str], set[str]] = {}

    def add_edge(source: object, target: object, edge_type: object) -> None:
        if not isinstance(source, str) or not isinstance(target, str):
            return
        if not isinstance(edge_type, str):
            return
        edge_types.setdefault((source, target), set()).add(edge_type)
        if edge_type in {"related", "parent-child"}:
            edge_types.setdefault((target, source), set()).add(edge_type)

    for record in beads if graph_beads is None else graph_beads:
        source_id = record.get("id")
        if not isinstance(source_id, str):
            continue
        for edge in record.get("dependencies") or []:
            if not isinstance(edge, dict):
                continue
            target_id = edge.get("depends_on_id") or edge.get("id")
            edge_type = edge.get("type") or edge.get("dependency_type")
            add_edge(source_id, target_id, edge_type)
        for edge in record.get("dependents") or []:
            if not isinstance(edge, dict):
                continue
            dependent_id = (
                edge.get("id")
                or edge.get("issue_id")
                or edge.get("depends_on_id")
            )
            edge_type = edge.get("type") or edge.get("dependency_type")
            add_edge(dependent_id, source_id, edge_type)

    causal_words = {
        "block", "blocked", "blocks", "depend", "depends", "dependency",
        "dependencies", "require", "requires", "required", "prerequisite",
    }
    bad = []
    for bead in beads:
        bead_id = bead.get("id")
        if not isinstance(bead_id, str):
            continue
        text = (
            (bead.get("description") or "")
            + "\n"
            + (bead.get("acceptance_criteria") or "")
        ).lower()
        contexts: dict[str, set[str]] = {}
        for match in BEAD_MENTION_RE.finditer(text):
            mention = match.group(1)
            if mention not in byid or mention == bead_id:
                continue
            line_start = text.rfind("\n", 0, match.start()) + 1
            line_end = text.find("\n", match.end())
            if line_end < 0:
                line_end = len(text)
            words = set(
                BEAD_RELATION_WORD_RE.findall(text[line_start:line_end])
            )
            mention_fixture = (
                bool(words & {"mention", "mentions", "mentioned", "mentioning"})
                and "edge" in words
                and bool(words & {"fail", "fails", "failed", "pass", "passes", "passed"})
            )
            regex_fixture = (
                bool(words & {"regex", "pattern", "matcher"})
                and bool(words & {"match", "matches", "matched", "matching"})
                and not (words & causal_words)
                and not (words & {"parent", "child", "children", "related"})
            )
            # These clauses describe matcher fixtures, not references by the
            # bead that contains them.
            if mention_fixture or regex_fixture:
                continue
            if words & causal_words:
                relation = "blocks"
            elif words & {"parent", "child", "children"}:
                relation = "parent-child"
            elif "related" in words or {"discovered", "from"} <= words:
                relation = "related"
            else:
                relation = "generic"
            contexts.setdefault(mention, set()).add(relation)

        for mention, relations in contexts.items():
            outgoing = edge_types.get((bead_id, mention), set())
            incoming = edge_types.get((mention, bead_id), set())
            connected = outgoing | incoming
            valid = True
            if "blocks" in relations and "blocks" not in outgoing:
                valid = False
            if (
                "parent-child" in relations
                and "parent-child" not in connected
            ):
                valid = False
            if "related" in relations and not (
                {"related", "discovered-from"} & connected
            ):
                valid = False
            if "generic" in relations and not connected:
                valid = False
            if not valid:
                bad.append(bead_id)
                break
    return bad


def latest_comment_ts(bead: dict) -> datetime | None:
    best = None
    for c in bead.get("comments") or []:
        ts = parse_iso(c.get("created_at") or "")
        if ts and (best is None or ts > best):
            best = ts
    return best


def check_j(
    beads: list[dict], now: datetime, stale_days: int = STALE_DAYS
) -> list[str]:
    bad = []
    for b in beads:
        if b.get("status") not in ("blocked", "in_progress"):
            continue
        latest = latest_comment_ts(b)
        if latest is None or (now - latest).total_seconds() > stale_days * 86400:
            bad.append(b["id"])
    return bad


def ac_phase_failure(bead: dict) -> list[str]:
    """Named l-ac-phase failure for an ENFORCED bead.

    Detail carries AC_PHASE_UNTAGGED and/or AC_PHASE_MULTI with each
    offending item quoted, so the create and update gates name the line.
    """
    if not ac_phase.is_enforced(bead.get("created_at")):
        return []
    refusals = ac_phase.tag_refusals(bead.get("acceptance_criteria"))
    if not refusals:
        return []
    return ["l-ac-phase:" + " ; ".join(f"{code} {detail}" for code, detail in refusals)]


def check_l(beads: list[dict]) -> list[str]:
    """l-ac-phase: enforced beads with an untagged or multi-tagged item."""
    return [b["id"] for b in beads if ac_phase_failure(b)]


def check_l_legacy(beads: list[dict]) -> list[str]:
    """l-ac-phase-legacy (warning): pre-cutover beads with the same finding."""
    return [
        b["id"] for b in beads
        if not ac_phase.is_enforced(b.get("created_at"))
        and ac_phase.tag_refusals(b.get("acceptance_criteria"))
    ]

EDGE_EVIDENCE = (
    "br dep add --help states '<issue> depends on <depends-on>'; "
    "bv --robot-graph adjacency emits {from: dependent, to: dependency}, "
    "matching issues.jsonl {issue_id, depends_on_id}; rank mass flows "
    "dependent -> dependency and accumulates at dependencies "
    "(pagerank-bead-triage skill fixture convention; replication-proven: "
    "blocks-only power iteration over the bv-map node set reproduces "
    "bv --robot-insights full_stats.pagerank top 3 exactly)."
)


def build_pagerank_fixture(
    all_beads: list[dict], map_nodes: list[str], expected_top: str | None
) -> dict:
    # Replication gate (Main ruling 2026-10-09): the node set is bv's own
    # PageRank-map set, edges are blocks dependent->dependency from the
    # JSONL records. bv --robot-next is a composite scheduler score, the
    # wrong sink for a centrality cert; expected_top pins the map top.
    node_set = set(map_nodes)
    byid = {b["id"]: b for b in all_beads}
    nodes = sorted(node_set)
    edges = []
    for bid in nodes:
        b = byid.get(bid)
        if b is None:
            continue
        for d in b.get("dependencies") or []:
            t = d.get("depends_on_id")
            if t in node_set and d.get("type") == "blocks":
                edges.append({"from": bid, "to": t, "type": "blocks"})
    return {
        "nodes": nodes,
        "edges": edges,
        "damping": DAMPING,
        "tolerance": TOLERANCE,
        "expected_top_id": expected_top,
        "metadata": {
            "edge_direction": "dependent -> dependency (bv --robot-graph "
            "from/to; br dep add ISSUE DEPENDS_ON)",
            "edge_evidence": EDGE_EVIDENCE,
            "edge_types_included": ["blocks"],
            "node_scope": "bv --robot-insights PageRank-map node set "
            "(replication gate; next-top reported ungated in meta)",
        },
    }


def run_pagerank_cert(fixture: dict, probe: str) -> dict:
    work = kitlib_tmp.owned_tmp("bead-lint-pagerank")
    path = os.path.join(work.path, "fixture.json")
    try:
        with open(path, "w") as f:
            json.dump(fixture, f)
        rc, out, err = run(
            [probe, "pagerank-cert", "--pagerank-graph-fixture", path,
             "--json"],
            os.getcwd(),
        )
        try:
            receipt = json.loads(out)
        except Exception:
            receipt = {
                "schema_version": "bv-readiness-probe.pagerank-cert/v1",
                "status": "fail",
                "failure_class": ["probe_unparsable"],
                "raw_stderr": err[:500],
            }
        receipt["_probe_rc"] = rc
        return receipt
    finally:
        work.cleanup()


def mkcheck(
    check_id: str, klass: str, offending: list[str], note: str = ""
) -> dict:
    off = sorted(set(offending))
    return {
        "id": check_id,
        "class": klass,
        "status": "fail" if (klass == "error" and (off or note)) else "pass",
        "offending_ids": off,
        "count": len(off),
        "note": note,
    }

BASE_TS = "2026-10-09T00:00:00Z"


def mkbead(
    bid: str,
    status: str = "open",
    labels: list[str] | None = None,
    desc: str = "",
    acc: str = "",
    deps: list[dict] | None = None,
    comments: list[dict] | None = None,
    close_reason: str | None = None,
    created_at: str = BASE_TS,
) -> dict:
    out = {
        "id": bid,
        "title": f"Selftest {bid}",
        "status": status,
        "priority": 2,
        "issue_type": "task",
        "created_at": created_at,
        "created_by": "bead-lint-selftest",
        "updated_at": BASE_TS,
        "source_repo": "selftest",
        "source_repo_path": "/tmp/bead-lint-selftest",  # tempsafe: fake fixture field value, nothing is created there
        "compaction_level": 0,
        "original_size": 0,
        "labels": labels if labels is not None else ["selftest"],
        "description": desc,
        "acceptance_criteria": acc,
        "dependencies": deps or [],
        "comments": comments
        if comments is not None
        else [
            {
                "id": 1,
                "issue_id": bid,
                "author": "bead-lint-selftest",
                "text": "fresh checkpoint",
                "created_at": utcnow_iso(),
            }
        ],
    }
    if close_reason is not None:
        out["close_reason"] = close_reason
    return out


def dep_to(src: str, dst: str, dtype: str = "blocks") -> dict:
    return {
        "issue_id": src,
        "depends_on_id": dst,
        "type": dtype,
        "created_at": BASE_TS,
        "created_by": "bead-lint-selftest",
        "metadata": "{}",
        "thread_id": "",
    }


CLEAN_DESC = (
    "WHAT: (a) build the widget; (b) document the widget. "
    "Selftest anchor bead st-base over a related edge, non-blocking. "
    "WHY: the widget line is down without it."
)
# Every fixture item carries a phase tag (ACPHASE1) so only the planted
# l-ac-phase beads are l offenders; letters share the tag's leading run.
CLEAN_ACC = (
    "- [ ] [a] [build] widget builds; planted negative: with the guard removed the "
    "build-fixture test goes RED (known-bad specimen fixtures/bad-input).\n"
    "- [ ] [b] [landed] widget docs render; planted negative: docs job fails on the "
    "bad-markdown specimen.\n"
)
# The cutover instant itself is enforced; one microsecond earlier is legacy.
L_ENFORCED_TS = "2026-10-24T00:00:00Z"
L_LEGACY_TS = "2026-10-23T23:59:59.999999Z"


def clean_bead(bid: str, **kw) -> dict:
    kw.setdefault("desc", CLEAN_DESC)
    kw.setdefault("acc", CLEAN_ACC)
    kw.setdefault("deps", [dep_to(bid, "st-base", "related")])
    return mkbead(bid, **kw)


def build_selftest_beads() -> tuple[list[dict], dict[str, list[str]]]:
    beads = [mkbead(
        "st-base", desc="WHAT: anchor. WHY: referenced by edges.",
        acc="- [ ] [build] anchor present; planted negative: anchor-missing "
        "fixture goes RED.\n",
    )]
    expected: dict[str, list[str]] = {}
    beads.append(clean_bead("st-clean-a"))
    beads.append(clean_bead("st-clean-b"))
    beads.append(mkbead("st-v-a", labels=[], desc=CLEAN_DESC, acc=CLEAN_ACC,
                        deps=[dep_to("st-v-a", "st-base", "related")]))
    expected["a-label"] = ["st-v-a"]
    beads.append(clean_bead("st-v-b", desc="no sections here",
                            acc="planted negative specimen noted, no list"))
    expected["b-what-why-acc"] = ["st-v-b"]
    beads.append(clean_bead(
        "st-v-c",
        acc="- [ ] [build] widget builds, no cites at all.\n"
        "- [ ] [b] [build] docs render; planted negative bad-markdown RED.\n",
    ))
    expected["c-lettered-scope"] = ["st-v-c"]
    beads.append(clean_bead(
        "st-v-d",
        acc="- [ ] [a] [build] widget builds with no adversarial specimen.\n"
        "- [ ] [b] [build] docs render, again no adversarial specimen.\n",
    ))
    expected["d-negative-specimen"] = ["st-v-d"]
    beads.append(clean_bead(
        "st-v-e", deps=[dep_to("st-v-e", "st-base", "mystery")]))
    expected["e-typed-edges"] = ["st-v-e"]
    beads.append(clean_bead("st-v-f"))
    for n in range(21):
        beads.append(clean_bead(
            f"st-v-f-kid-{n:02d}",
            desc="WHAT: (a) kid slice of the fanout parent. "
            "WHY: proves the epic splits.",
            acc="- [ ] [a] [build] kid slice lands; planted negative: kid-missing "
            "fixture goes RED.\n",
            deps=[dep_to(f"st-v-f-kid-{n:02d}", "st-v-f")],
        ))
    expected["f-fanout-depth"] = ["st-v-f"]
    beads.append(clean_bead(
        "st-v-g",
        labels=["selftest", "eco"],
        desc="WHAT: (a) eco thing. WHY: cited plan work.",
        acc="- [ ] [a] [build] eco thing done; planted negative bad specimen RED.\n",
    ))
    expected["g-eco-plan-cite"] = ["st-v-g"]
    beads.append(clean_bead(
        "st-v-h",
        desc=CLEAN_DESC + " Still TODO: finish later.",
    ))
    expected["h-placeholders"] = ["st-v-h"]
    beads.append(mkbead(
        "st-v-i", desc=CLEAN_DESC + " See st-clean-a.",
        acc=CLEAN_ACC, deps=[dep_to("st-v-i", "st-base", "related")],
    ))
    id_test_desc = (
        "WHAT: (a) resolve the tracker reference; (b) preserve the control. "
        "WHY: references require a typed edge."
    )
    dotted_id = "ompkit-rc-epic-land-fix-release-dogfood-rz5.119"
    for target in ("ompkit-axz7m", dotted_id, "bd-abc123"):
        beads.append(mkbead(target, desc=id_test_desc, acc=CLEAN_ACC))
    beads.append(mkbead(
        "st-v-i-single",
        desc=id_test_desc + "\nSee ompkit-axz7m.",
        acc=CLEAN_ACC,
    ))
    beads.append(mkbead(
        "st-v-i-legacy",
        desc=id_test_desc + "\nSee bd-abc123.",
        acc=CLEAN_ACC,
    ))
    beads.append(mkbead(
        "st-v-i-dotted-missing",
        desc=id_test_desc + f"\nDepends on {dotted_id}.",
        acc=CLEAN_ACC,
    ))
    beads.append(mkbead(
        "st-v-i-dotted-blocks",
        desc=id_test_desc + f"\nDepends on {dotted_id}.",
        acc=CLEAN_ACC,
        deps=[dep_to("st-v-i-dotted-blocks", dotted_id, "blocks")],
    ))
    beads.append(mkbead(
        "st-v-i-related-only",
        desc=id_test_desc + "\nRequires ompkit-axz7m.",
        acc=CLEAN_ACC,
        deps=[dep_to("st-v-i-related-only", "ompkit-axz7m", "related")],
    ))
    beads.append(mkbead(
        "st-v-i-related-control",
        desc=id_test_desc + "\nThis is related to ompkit-axz7m.",
        acc=CLEAN_ACC,
        deps=[dep_to("st-v-i-related-control", "ompkit-axz7m", "related")],
    ))
    beads.append(mkbead(
        "st-v-i-discovered",
        desc=id_test_desc + f"\ndiscovered-from: {dotted_id}.",
        acc=CLEAN_ACC,
        deps=[dep_to("st-v-i-discovered", dotted_id, "related")],
    ))
    beads.append(mkbead(
        "st-v-i-prose",
        desc=id_test_desc + "\nnon-author and pre-push are ordinary prose.",
        acc=CLEAN_ACC,
    ))
    beads.append(mkbead(
        "st-v-i-meta",
        desc="WHAT: preserve literal examples. WHY: this tests metalinguistic references.",
        acc=CLEAN_ACC
        + "- [ ] [c] [build] a description mentioning ompkit-axz7m with no "
        "edge fails i-mention-edges, and one mentioning ...rz5.119 with a "
        "blocks edge to ...rz5.119 passes; planted negative: the no-edge "
        "fixture is RED.\n",
    ))
    beads.append(mkbead(
        "st-v-i-regex-example",
        desc=id_test_desc
        + "\nThe rework miner found check_i's regex never matched ompkit-axz7m.",
        acc=CLEAN_ACC,
    ))
    beads.append(mkbead(
        "st-v-i-steps-example",
        desc=id_test_desc
        + "\nLint a bead whose description mentions ompkit-axz7m with no edge: "
        "check_i passes it.",
        acc=CLEAN_ACC,
    ))
    parent_id, child_id = "st-v-i-parent", "st-v-i-child"
    parent = mkbead(
        parent_id,
        desc=id_test_desc + f"\nParent of {child_id}.",
        acc=CLEAN_ACC,
    )
    child = mkbead(
        child_id,
        desc=id_test_desc + f"\nChild of {parent_id}.",
        acc=CLEAN_ACC,
        deps=[dep_to(child_id, parent_id, "parent-child")],
    )
    parent["dependents"] = [
        {"id": child_id, "dependency_type": "parent-child"}
    ]
    beads.extend([parent, child])
    expected["i-mention-edges"] = [
        "st-v-e",
        "st-v-i",
        "st-v-i-single",
        "st-v-i-legacy",
        "st-v-i-dotted-missing",
        "st-v-i-related-only",
    ]
    beads.append(clean_bead(
        "st-v-j", status="blocked", comments=[],
    ))
    expected["j-stale-blocked"] = ["st-v-j"]
    # K fixtures (k-close-receipt): closed beads live OUTSIDE scope_beads,
    # so these exercise the ADV-4 unscoped path. The cited ids are
    # well-formed; resolution depends on receipt files on disk, which the
    # selftest does not create — so K2 (missing receipt) is the expected
    # finding for st-v-k2. st-v-k1 cites no id (clean), st-v-k3 cites a
    expected["elapsed-time-mix"] = ["st-v-time", "st-v-time-sitreps", "st-v-time-daily", "st-v-time-dated",
                                    "st-v-time-armed"]
    beads.append(clean_bead(
        "st-v-time",
        acc=CLEAN_ACC + "- [ ] [c] [after 7d] measured over 7 days; planted negative: "
        "a one-day fixture must be rejected.\n",
    ))
    # ompkit-fp72.135.3.48: a runtime counter in code behavior is not an
    # observation window (GOALKEEP1 AC2 text verbatim behind its phase tags),
    # while counted reports or runs over time still are. These hang off
    # st-v-time, not st-base, so st-base stays under the f-fanout limit.
    def time_bead(bid: str, extra: str) -> dict:
        return clean_bead(bid, desc=CLEAN_DESC.replace("st-base", "st-v-time"), acc=CLEAN_ACC + extra,
                          deps=[dep_to(bid, "st-v-time", "related")])

    beads.append(time_bead(
        "st-v-time-counter",
        "- [ ] [a] [build] Bounds: at most one wake per 10 min per seat; after 3 consecutive wakes "
        "whose turns made no tool call, the extension stops waking and records GOAL_IDLE_ESCALATE "
        "(custom entry) so the sentinel mails the director and logs a prompt review.\n",
    ))
    beads.append(time_bead(
        "st-v-time-sitreps",
        "- [ ] [c] [after 6h] control: the optimized helper over 6 consecutive hourly sitreps shows "
        "no rc=124; planted negative: a stubbed helper still yields rc 124.\n",
    ))
    beads.append(time_bead(
        "st-v-time-daily",
        "- [ ] [c] [after 3d] 3 consecutive daily reports show the count; planted negative: a "
        "missing report reads UNKNOWN.\n",
    ))
    # The real TIMEAC1 time items, verbatim behind a phase tag: a dated window
    # (SCRATCHBIN1-M ompkit-fp72.19.1.50) and a first-armed-run milestone
    # (cfsios cfs-inbound-call-capture-0uyn2). Both escaped the classifier.
    beads.append(time_bead(
        "st-v-time-dated",
        "- [ ] [c] [after 7d] On or after 2026-10-27, from the scratch ledger and reaper receipts: owner-released "
        "share of dirs created 2026-10-20..27 vs the 18/~2.7k baseline, and reaped bytes for the same "
        "week vs 242.3 GB; both numbers posted with their producer commands.\n",
    ))
    beads.append(time_bead(
        "st-v-time-armed",
        "- [ ] [c] [live] GATED REMAINDER: first armed run + live inbound call with ring proof (needs approved "
        "test numbers + ring timing per director 9696)\n",
    ))
    # A ticked elapsed item cannot hold a close open (the harm TIMEAC1 targets),
    # so beside open code items it is no mix; the unticked st-v-time above is.
    beads.append(time_bead(
        "st-v-time-ticked",
        "- [x] [c] [after 7d] measured over 7 days; planted negative: a one-day fixture must be "
        "rejected.\n",
    ))
    # l-ac-phase (ACPHASE1): enforced untagged and enforced multi-tagged
    # beads are offenders; the same untagged text one microsecond before
    # the cutover is a legacy warning only. Controls: enforced fully
    # tagged, and enforced AC-KITLIB lines (implicitly build).
    untagged_acc = CLEAN_ACC + "- [ ] [b] docs link checked; planted negative: dead link RED.\n"
    beads.append(clean_bead("st-v-l", acc=untagged_acc, created_at=L_ENFORCED_TS))
    beads.append(clean_bead(
        "st-v-l-multi", created_at=L_ENFORCED_TS,
        acc=CLEAN_ACC + "- [ ] [b] [build] [live] docs live; planted negative: stale page RED.\n"))
    expected["l-ac-phase"] = ["st-v-l", "st-v-l-multi"]
    beads.append(clean_bead("st-v-l-legacy", acc=untagged_acc, created_at=L_LEGACY_TS))
    expected["l-ac-phase-legacy"] = ["st-v-l-legacy"]
    beads.append(clean_bead("st-clean-l", created_at=L_ENFORCED_TS))
    beads.append(clean_bead(
        "st-clean-l-kitlib", created_at=L_ENFORCED_TS,
        acc=CLEAN_ACC + "- [ ] AC-KITLIB-2 [b] ratchet holds; planted negative: regression RED.\n"))
    beads.append(clean_bead("st-v-k1", status="closed",
                            close_reason="done at commit abc1234"))
    beads.append(clean_bead(
        "st-v-k2", status="closed",
        close_reason="landed; receipt ev_" + "a" * 64,
    ))
    expected["k-close-receipt"] = ["st-v-k2"]
    beads.append(clean_bead(
        "st-v-k3", status="closed",
        close_reason="malformed run ev_" + "a" * 65,
    ))
    beads.append(clean_bead("st-clean-k", status="closed",
                            close_reason="no ids here at all"))
    beads.append(clean_bead("st-cyc-a", deps=[dep_to("st-cyc-a", "st-cyc-b"),
                                              dep_to("st-cyc-a", "st-base",
                                                     "related")]))
    beads.append(clean_bead("st-cyc-b", deps=[dep_to("st-cyc-b", "st-cyc-a"),
                                              dep_to("st-cyc-b", "st-base",
                                                     "related")]))
    expected["bv-cycles"] = ["st-cyc-a", "st-cyc-b"]
    return beads, expected


def build_clean_beads() -> list[dict]:
    beads = [mkbead(
        "st-base", desc="WHAT: anchor. WHY: referenced by edges.",
        acc="- [ ] [build] anchor present; planted negative: anchor-missing "
        "fixture goes RED.\n",
    )]
    beads.append(clean_bead("st-clean-a"))
    beads.append(clean_bead("st-clean-b"))
    return beads


def write_jsonl(path: str, beads: list[dict]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for b in beads:
            f.write(json.dumps(b) + "\n")


def _load_jsonl(path: str) -> list[dict]:
    # Test-only reader: stdlib JSONL round-trip (no br dependency) proving
    # the checks operate on serialized shapes, not just live objects.
    beads = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                beads.append(json.loads(line))
    return beads


LETTERED_IDS = [
    "a-label", "b-what-why-acc", "c-lettered-scope", "d-negative-specimen",
    "e-typed-edges", "f-fanout-depth", "g-eco-plan-cite", "h-placeholders",
    "i-mention-edges", "j-stale-blocked", "k-close-receipt",
    "l-ac-phase", "l-ac-phase-legacy",
]

# V2Adv-5: the warning→error tier is a DATE, encoded here. Before this date
# k-close-receipt findings are warnings; after, errors. (j-stale stays
# warning forever — that was the false precedent.)
K_WARN_UNTIL = "2026-10-24T00:00:00+00:00"
# Receipt directories searched for resolution (first match wins). Committed
# convention per V2Adv-3: docs/evidence/receipts/ is the canonical home;
# var/receipts/ accepted for repos that gitignore docs/evidence.
RECEIPT_DIRS = ("docs/evidence/receipts", "var/receipts")
EV_FIND = re.compile(r"ev_([0-9a-f]{64})")
HEX_CHAR = re.compile(r"[0-9a-f]")
WORD_CHAR = re.compile(r"[A-Za-z0-9_]")


def iter_ev_ids(text: str) -> list[str]:
    """Well-formed ev_ ids only (the shared grammar, V2Adv-2): a 65+-hex
    run or a token glued to a preceding word char ('dev_<64hex>') is
    malformed — it never counts as a receipt id here. Malformed-token
    FIRE is the Layer-4 rule's job, not this check's."""
    out = []
    for m in EV_FIND.finditer(text):
        start, end = m.start(), m.end()
        if end < len(text) and HEX_CHAR.match(text[end]):
            continue
        if start > 0 and WORD_CHAR.match(text[start - 1]):
            continue
        out.append(m.group(0))
    return out


def _receipt_dirs_for(source_repo_path: str | None) -> list[Path]:
    roots = []
    for base in (source_repo_path, os.getcwd()):
        if not base:
            continue
        for d in RECEIPT_DIRS:
            p = Path(base) / d
            if p.is_dir() and p not in roots:
                roots.append(p)
    return roots


def k_tier(now: datetime) -> str:
    """k-close-receipt enforcement tier (V2Adv-5): 'warning' before
    K_WARN_UNTIL, 'error' after. Missing-evidence closes are refused only
    at the error tier; unresolvable cited ids are findings at both tiers."""
    return "warning" if now.isoformat() < K_WARN_UNTIL else "error"


def _receipt_tool() -> Path:
    """Path of the receipt verifier check_k resolves cited ids with.

    Separate function (not inline) so the selftest can plant a missing
    tool and prove the check fails closed instead of going inert."""
    return Path(__file__).parent / "receipt.py"


def check_k(
    beads: list[dict], now: datetime
) -> list[str]:
    """k-close-receipt: every well-formed ev_ id cited in a close_reason
    must RESOLVE — a receipt file exists in a known receipts dir, its
    stored id equals the cited id, and `receipt.py verify` passes on it.
    Full-bead iteration (ADV-4): closes live outside scope_beads' open-
    only view. Warning tier until K_WARN_UNTIL (V2Adv-5), then errors.
    At the error tier a closed bead citing NO well-formed ev_ id is
    refused outright (RECEIPT1 [b]): cite one resolving id under
    docs/evidence/receipts/ or var/receipts/.
    """
    import importlib.util

    tool = _receipt_tool()
    if not tool.is_file():
        # Fail CLOSED (xa5s.13 class — a guard never fails open): a missing
        # verifier must not read as "every cited id resolves". No cited id
        # can be verified, so every closed bead is an offender until the
        # tool is restored. (Open beads are unaffected: nothing to verify.)
        return sorted({b["id"] for b in beads if b.get("status") == "closed"})
    spec = importlib.util.spec_from_file_location("_receipt_tool", tool)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    tier = k_tier(now)
    bad: list[str] = []
    for b in beads:  # ALL beads, bypassing scope_beads (ADV-4)
        reason = b.get("close_reason") or ""
        if not reason:
            # No close text at all: only a close is refused, and only
            # past the warn date (legacy closes predate the rule).
            if tier == "error" and b.get("status") == "closed":
                bad.append(f"{b['id']}:no-ev:missing")
            continue
        dirs = _receipt_dirs_for(b.get("source_repo_path"))
        ids = iter_ev_ids(reason)
        if not ids:
            # Close text cites no well-formed ev_ id (malformed runs do
            # not count, V2Adv-2): refused past the warn date.
            if tier == "error" and b.get("status") == "closed":
                bad.append(f"{b['id']}:no-ev:missing")
            continue
        for ev in ids:
            hit = None
            for d in dirs:
                for cand in d.glob("*.receipt.json"):
                    try:
                        rec = json.loads(cand.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError):
                        continue
                    if rec.get("evidence_id") == ev:
                        hit = cand
                        break
                if hit:
                    break
            if hit is None:
                bad.append(f"{b['id']}:{ev[:12]}:missing")
                continue
            try:
                check_domain = mod.check_domain
                stored_id = rec["evidence_id"]
                check_domain(rec)
                actual = mod.compute_id(
                    {k: v for k, v in rec.items() if k != "evidence_id"}
                )
                if actual != stored_id:
                    bad.append(f"{b['id']}:{ev[:12]}:drift")
            except Exception as exc:
                bad.append(f"{b['id']}:{ev[:12]}:domain({exc})")
                continue
    # report at bead granularity, deduped; the bead id list is what the
    # lettered-check contract carries (offenders, not notes).
    # Suffix key: :missing = cited id has no resolving receipt file,
    # :drift = stored id disagrees with its record, :domain(...) =
    # out-of-domain record, :no-ev:missing = error-tier close cites no
    # well-formed ev_ id at all (the close path asks for one).
    offenders = sorted({item.split(":", 1)[0] for item in bad})
    return offenders


def run_lettered(
    beads: list[dict], now: datetime
) -> dict[str, list[str]]:
    scoped = scope_beads(beads)
    byid = {b["id"] for b in beads}
    return {
        "a-label": check_a(scoped),
        "b-what-why-acc": check_b(scoped),
        "c-lettered-scope": check_c(scoped),
        "d-negative-specimen": check_d(scoped),
        "e-typed-edges": check_e(scoped),
        "f-fanout-depth": check_f(scoped)[0],
        "g-eco-plan-cite": check_g(scoped),
        "h-placeholders": check_h(scoped),
        "i-mention-edges": check_i(scoped, byid, graph_beads=beads),
        "j-stale-blocked": check_j(scoped, now),
        # ADV-4: closes live outside scope_beads — check_k sees ALL beads.
        "k-close-receipt": check_k(beads, now),
        "l-ac-phase": check_l(scoped),
        # Warning row (like j): pre-cutover beads are reported, never refused.
        "l-ac-phase-legacy": check_l_legacy(scoped),
    }

# ---- LINTGATE1 (ompkit-fp72.19.1.28): create-time per-bead gate ----
# The fleet fails these checks on hundreds of beads because nothing refuses
# a bead that would fail. The admission path (br-create-guard.py at create,
# br-update-lint.py at content edits) refuses via lint_bead_failures with a
# LINT_REFUSED verdict naming each failing check.

# Per-bead subset enforced at admission: graph/global checks (e, f, g, j,
# k) need tracker-wide context or lifecycle state and stay in the runner.
GATE_CHECKS = (
    "a-label",
    "b-what-why-acc",
    "c-lettered-scope",
    "d-negative-specimen",
    "h-placeholders",
    "i-mention-edges",
    "elapsed-time-mix",
    "l-ac-phase",
)

# TIMEAC1: elapsed acceptance is evidence that cannot be graded during the
# code-review pass.  Keep the classifier deliberately narrow: it recognizes
# explicit windows, repeated observations, trends, or live-run milestones,
# rather than ordinary words such as "today" or "run".
_ELAPSED_ACCEPTANCE_RE = re.compile(
    r"(?:"
    r"\bmeasur(?:e|ed|ement|ing)\b[^.\n]{0,100}\b(?:over|for|across)\b"
    r"|\b(?:over|for|across)\s+\d+\s*(?:hours?|hrs?|h|days?|d|weeks?|w|minutes?|mins?|m)\b"
    r"|\b\d+\s*(?:hours?|hrs?|h|days?|d|weeks?|w|minutes?|mins?)\s+(?:window|period|deadline)\b"
    r"|\b\d+\s*-\s*(?:minutes?|mins?)\b"
    r"|\b\d+\s*(?:hours?|hrs?|h|days?|d|weeks?|w|minutes?|mins?|m)\s+downtrend\b"
    # "N consecutive" is a window only when it counts reports, runs or time
    # periods; "3 consecutive wakes" is a runtime counter in code behavior.
    r"|\b\d+\s+consecutive\s+(?:(?:daily|hourly|weekly|nightly)\s+)?"
    r"(?:reports?|runs?|sitreps?|days?|hours?|weeks?|ticks?|cycles?|windows?)\b"
    r"|\bconsecutive\s+(?:daily|weekly|reports?|runs?)\b"
    # A first armed or live run is a milestone that cannot happen in review.
    r"|\bfirst\s+(?:live|armed)\s+(?:run|report|measurement|proof)\b"
    # An explicit dated window: "on or after 2026-10-27, ..." waits for a date.
    r"|\bon\s+or\s+after\s+\d{4}-\d{2}-\d{2}\b"
    r"|\blive\s+(?:run|ring|measurement)\s+(?:proof|evidence)\b"
    r"|\bafter\s+(?:the\s+)?kit\s+release\s+is\s+installed\b"
    r"|\bwithin\s+\d+\s+fast[- ]lane\s+cadences?\s+of\s+deploy\b"
    r"|\bnext\s+push[- ]run\b"
    r")",
    re.IGNORECASE,
)

_AC_CHECKBOX_ITEM_RE = re.compile(r"^\s*(?:[-*+]\s*)?\[([ xX])\]\s*")
_AC_NUMBERED_ITEM_RE = re.compile(r"^\s*\d+[.)]\s+")
_AC_BULLET_ITEM_RE = re.compile(r"^\s*[-*+]\s+")
_AC_SECTION_HEADERS = {
    "acceptance", "acceptance criteria", "requirements", "verification",
}


def classify_acceptance(bead: dict) -> dict[str, object]:
    """Classify checkbox, numbered, bullet and prose AC items."""
    acceptance = bead.get("acceptance_criteria") or ""
    items: list[dict[str, object]] = []
    current_index = 0
    current_lines: list[str] = []
    current_kind: str | None = None
    current_ticked = False

    def flush() -> None:
        nonlocal current_lines, current_kind
        text = " ".join(current_lines).strip()
        if text:
            folded = text.casefold()
            is_classifier_example = (
                "classified elapsed" in folded
                or "classified as elapsed" in folded
            )
            items.append({
                "index": current_index,
                "text": text,
                "elapsed": (
                    bool(_ELAPSED_ACCEPTANCE_RE.search(text))
                    and not is_classifier_example
                ),
                "ticked": current_ticked,
            })
        current_lines = []
        current_kind = None

    for index, raw in enumerate(acceptance.splitlines(), 1):
        stripped = raw.strip()
        if not stripped:
            flush()
            continue
        if (
            stripped.startswith("#")
            or stripped.casefold().rstrip(":") in _AC_SECTION_HEADERS
        ):
            flush()
            continue
        checkbox = _AC_CHECKBOX_ITEM_RE.match(raw)
        marker = (
            checkbox
            or _AC_NUMBERED_ITEM_RE.match(raw)
            or _AC_BULLET_ITEM_RE.match(raw)
        )
        if marker is not None:
            flush()
            current_index = index
            current_lines = [raw[marker.end():].strip()]
            current_kind = "list"
            current_ticked = bool(
                checkbox and checkbox.group(1).casefold() == "x"
            )
            continue
        if current_kind == "list" and raw[:1].isspace():
            current_lines.append(stripped)
            continue
        if current_kind == "list":
            flush()
        if current_kind is None:
            current_index = index
            current_ticked = False
            current_kind = "prose"
        current_lines.append(stripped)
    flush()

    # A ticked time item cannot hold a close open, which is the harm TIMEAC1
    # targets, so only open time items count; a ticked one is neither kind.
    elapsed_items = [item for item in items if item["elapsed"] and not item["ticked"]]
    code_items = [item for item in items if not item["elapsed"]]
    return {
        "items": items,
        "elapsed_items": elapsed_items,
        "code_items": code_items,
        "mixed": bool(elapsed_items and code_items),
    }


def elapsed_time_mix_failure(bead: dict) -> list[str]:
    """Return a named TIMEAC1 failure, including the offending time item."""
    result = classify_acceptance(bead)
    if not result["mixed"]:
        return []
    elapsed_items = result["elapsed_items"]
    detail = str(elapsed_items[0].get("text", ""))[:160]
    return [f"elapsed-time-mix:{detail}"]

# br-lint-template section map, read off `br lint --json` behavior
# (tests/test_bead_lint_gate.sh template-agreement re-verifies it against
# the live tracker): exact `## <Section>` header lines per issue type,
# plus the acceptance disjunction (section line OR non-empty field).
TEMPLATE_SECTIONS = {
    "bug": ("## Steps to Reproduce",),
    "epic": ("## Success Criteria",),
}
TEMPLATE_ACCEPTANCE_TYPES = ("bug", "task", "feature")
ACCEPTANCE_HEADER = "## Acceptance Criteria"


def template_missing(
    issue_type: str | None,
    description: str | None,
    acceptance_criteria: str | None,
) -> list[str]:
    """Sections `br lint` would flag missing (br-lint-template)."""
    missing: list[str] = []
    heads = {
        line.strip()
        for line in (description or "").splitlines()
        if line.strip().startswith("##")
    }
    for section in TEMPLATE_SECTIONS.get(issue_type or "", ()):
        if section not in heads:
            missing.append(section)
    if (issue_type or "") in TEMPLATE_ACCEPTANCE_TYPES:
        if (ACCEPTANCE_HEADER not in heads
                and not (acceptance_criteria or "").strip()):
            missing.append(ACCEPTANCE_HEADER)
    return missing


def lint_bead(bead: dict, byid: set[str] | None = None) -> dict[str, list[str]]:
    """Per-bead LINTGATE1 verdict over GATE_CHECKS.

    `bead` is one JSONL-shaped record (prospective creates carry id
    "<new>"); `byid` defaults to just this bead. Offender lists hold the
    bead id when it fails, exactly like the batch checks.
    """
    bead = dict(bead)
    bead.setdefault("id", "<new>")
    single = [bead]
    ids = set(byid) if byid is not None else {bead["id"]}
    return {
        "a-label": check_a(single),
        "b-what-why-acc": check_b(single),
        "c-lettered-scope": check_c(single),
        "d-negative-specimen": check_d(single),
        "h-placeholders": check_h(single),
        "i-mention-edges": check_i(single, ids),
        "elapsed-time-mix": [bead["id"]] if elapsed_time_mix_failure(bead) else [],
        "l-ac-phase": [bead["id"]] if ac_phase_failure(bead) else [],
    }


def lint_bead_failures(
    bead: dict, byid: set[str] | None = None
) -> list[str]:
    """Failing check names for one bead, including br-lint-template.

    Tombstones (deleted records) are exempt: `br lint` never flags
    them, and the gate must agree with `br lint` bead for bead.
    """
    if (bead.get("status") or "") == "tombstone":
        return []
    failures = [
        check_id
        for check_id, offenders in lint_bead(bead, byid).items()
        if offenders and check_id not in ("elapsed-time-mix", "l-ac-phase")
    ]
    failures.extend(elapsed_time_mix_failure(bead))
    failures.extend(ac_phase_failure(bead))
    if template_missing(
        bead.get("issue_type") or bead.get("type"),
        bead.get("description"),
        bead.get("acceptance_criteria"),
    ):
        failures.append("br-lint-template")
    return sorted(failures)


def normalize_show_record(record: dict) -> dict:
    """`br show --json` record -> JSONL shape the checks read (live)."""
    out = dict(record)
    deps = []
    for dep in record.get("dependencies") or []:
        deps.append({
            "depends_on_id": dep.get("depends_on_id", dep.get("id")),
            "type": dep.get("type", dep.get("dependency_type")),
        })
    out["dependencies"] = deps
    if "issue_type" not in out and "type" in out:
        out["issue_type"] = out["type"]
    return out


def live_bead(repo: str, bead_id: str, timeout: int = 60) -> dict:
    """Live single-bead read via `br show` (never the JSONL export)."""
    rc, out, err = run(["br", "show", bead_id, "--json"], repo, timeout)
    if rc != 0:
        raise RuntimeError(
            f"br show {bead_id} failed rc={rc}: {(err or out)[:300]}")
    try:
        data = json.loads(out)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"br show {bead_id} unparsable: {exc}")
    record = data[0] if isinstance(data, list) else data
    if not isinstance(record, dict) or record.get("id") != bead_id:
        raise RuntimeError(f"br show {bead_id} returned no such bead")
    return normalize_show_record(record)


def load_live_beads(repo: str, timeout: int = 120) -> list[dict]:
    """Flush-first repo read: `br sync --flush-only`, then the JSONL.

    Fail-closed: a failed flush raises instead of linting a stale export
    (the LINTGATE1 staleness trap: --no-auto-flush writers leave fixed
    beads failing until a flush).
    """
    rc, out, err = run(["br", "sync", "--flush-only"], repo, timeout)
    if rc != 0:
        raise RuntimeError(
            f"br sync --flush-only failed rc={rc}: {(err or out)[:300]}")
    path = os.path.join(repo, ".beads", "issues.jsonl")
    return _load_jsonl(path)


def backlog_report(beads: list[dict]) -> list[dict]:
    """One row per open in-scope bead failing the admission gate."""
    byid = {b["id"] for b in beads}
    rows = []
    for bead in scope_beads(beads):
        if bead.get("status") != "open":
            continue
        failures = lint_bead_failures(bead, byid)
        if failures:
            rows.append({
                "id": bead["id"],
                "owner": (bead.get("assignee")
                          or bead.get("created_by") or ""),
                "checks": failures,
                "title": bead.get("title") or "",
            })
    return sorted(rows, key=lambda row: row["id"])


def run_selftest(probe: str) -> tuple[bool, dict]:
    fails: list[str] = []
    log: dict = {"mutation": [], "clean": {}}
    work = kitlib_tmp.owned_tmp("bead-lint-kit-selftest")
    tmp = work.path
    try:
        beads, expected = build_selftest_beads()
        jsonl = os.path.join(tmp, "issues.jsonl")
        write_jsonl(jsonl, beads)
        loaded = _load_jsonl(jsonl)
        if len(loaded) != len(beads):
            return False, {"fatal": "JSONL round-trip lost beads"}
        # K_WARN_UNTIL is a date, not a mock: pin the lettered comparison
        # to a pre-warn clock so the suite stays green on both sides of
        # 2026-10-24, then prove the tier flip with explicit clocks.
        now = datetime(2026, 10, 10, tzinfo=timezone.utc)
        assert k_tier(now) == "warning"
        got = run_lettered(loaded, now)
        late = datetime(2026, 10, 25, tzinfo=timezone.utc)
        assert k_tier(late) == "error"
        # Post-warn k offenders: k2 (cited id unresolvable) plus every
        # close citing no well-formed id (k1 plain text, clean-k no ids,
        # k3 malformed 65-hex run, V2Adv-2). A resolving close passes.
        want_late = sorted(["st-clean-k", "st-v-k1", "st-v-k2", "st-v-k3"])
        got_late = sorted(run_lettered(loaded, late)["k-close-receipt"])
        if got_late != want_late:
            fails.append(f"k-tier: post-warn want {want_late} got {got_late}")
        log["k_tier"] = {"warning_now": k_tier(now), "error_now": k_tier(late),
                         "post_warn_offenders": got_late}
        # Planted negative (xa5s.13 class): with the receipt verifier
        # missing, the check fails CLOSED — every closed fixture is
        # flagged, never a silent pass.
        _real_tool = _receipt_tool
        globals()["_receipt_tool"] = lambda: Path(tmp) / "no-such-receipt.py"
        try:
            got_notool = sorted(check_k(loaded, late))
        finally:
            globals()["_receipt_tool"] = _real_tool
        want_notool = sorted(b["id"] for b in loaded
                             if b.get("status") == "closed")
        if got_notool != want_notool:
            fails.append(f"k-notool: want {want_notool} got {got_notool}")
        log["k_missing_tool"] = {"offenders": got_notool}
        for cid in LETTERED_IDS:
            w, g = sorted(expected[cid]), sorted(got[cid])
            if g != w:
                fails.append(f"{cid}: want {w} got {g}")
        for cid in LETTERED_IDS:
            # Mutation proof (acceptance [a]): with this check muted, its
            # planted violator escapes, so the strict comparison REDs.
            muted = dict(got)
            muted[cid] = []
            flips = sorted(muted[cid]) != sorted(expected[cid])
            log["mutation"].append({"disabled": cid,
                                    "verdict_flips_to_fail": flips})
            if not flips:
                fails.append(f"mutation: disabling {cid} changes nothing")
        # elapsed-time-mix (TIMEAC1) is a per-bead admission check, not a
        # runner row, so it gets its own strict comparison here: the planted
        # violators must fail and every control (counter, ticked) must pass.
        # Before ompkit-fp72.135.3.48 only the violators were checked.
        got_time = sorted(b["id"] for b in scope_beads(loaded) if elapsed_time_mix_failure(b))
        want_time = sorted(expected["elapsed-time-mix"])
        if got_time != want_time:
            fails.append(f"elapsed-time-mix: want {want_time} got {got_time}")
        log["mutation"].append({"disabled": "elapsed-time-mix", "verdict_flips_to_fail": bool(want_time)})
        if not want_time:
            fails.append("mutation: disabling elapsed-time-mix changes nothing")
        elapsed_forms = [
            (
                "numbered-24h",
                "1. [a] [build] build code; planted negative: remove it and RED.\n"
                "2. [b] [after 24h] observe a 24 h window; planted negative: "
                "omit the window and RED.\n",
                True,
            ),
            (
                "no-dash-checkbox",
                "[ ] [a] [build] build code; planted negative: remove it and RED.\n"
                "[ ] [b] [after 24h] observe over 24 h; planted negative: "
                "omit the window and RED.\n",
                True,
            ),
            (
                "plain-prose",
                "Build [a] code; planted negative: remove it and RED.\n\n"
                "Observe [b] over 24 h; planted negative: omit it and RED.\n",
                True,
            ),
            (
                "after-release-installed",
                "- [ ] [a] [build] build code; planted negative: remove it and RED.\n\n"
                "After the kit release is installed, [b] verify; planted negative: "
                "use the stale release and RED.\n",
                True,
            ),
            (
                "fast-lane-cadence",
                "- [ ] [a] [build] build code; planted negative: remove it and RED.\n"
                "Within 2 fast-lane cadences of deploy, [b] verify; planted negative: "
                "omit verification and RED.\n",
                True,
            ),
            (
                "minute-task",
                "- [ ] [a] [build] build code; planted negative: remove it and RED.\n"
                "A 30-min task [b] must finish; planted negative: omit the task and RED.\n",
                True,
            ),
            (
                "next-push-run",
                "- [ ] [a] [build] build code; planted negative: remove it and RED.\n"
                "On the next push-run, [b] verify; planted negative: omit the check and RED.\n",
                True,
            ),
            (
                "classifier-self-reference",
                "- [ ] [a] [build] build code; planted negative: remove it and RED.\n"
                "- [ ] [b] [build] numbered acceptance naming a 24 h window "
                "is classified elapsed; planted negative: classifier fixtures "
                "must not require a wait.\n",
                False,
            ),
            (
                "ordinary-today-control",
                "- [ ] [a] [build] build code; planted negative: remove it and RED.\n\n"
                "The [b] result is reviewed today; planted negative: omit review and RED.\n",
                False,
            ),
        ]
        elapsed_probe_results = {}
        for name, acceptance, expected_elapsed in elapsed_forms:
            time_probe = clean_bead(
                f"st-v-time-probe-{name}",
                acc=acceptance,
            )
            time_probe_id = str(time_probe["id"])
            direct = bool(elapsed_time_mix_failure(time_probe))
            gate = any(
                item.startswith("elapsed-time-mix:")
                for item in lint_bead_failures(time_probe, {time_probe_id})
            )
            elapsed_probe_results[name] = {
                "expected": expected_elapsed,
                "direct": direct,
                "gate": gate,
            }
            if direct != expected_elapsed or gate != expected_elapsed:
                fails.append(
                    f"elapsed-format {name}: expected {expected_elapsed}, "
                    f"direct={direct}, gate={gate}"
                )
        log["elapsed_format_probes"] = elapsed_probe_results
        clean = build_clean_beads()
        cjsonl = os.path.join(tmp, "clean.jsonl")
        write_jsonl(cjsonl, clean)
        cloaded = _load_jsonl(cjsonl)
        stray = run_lettered(cloaded, now)
        flagged = sorted({i for v in stray.values() for i in v})
        if flagged:
            fails.append(f"clean fixture flagged: {flagged}")
        log["clean"] = {"flagged": flagged}
        # LINTGATE1: the per-bead gate bites per check, passes the control.
        gate_ids = {b["id"] for b in loaded}
        for cid in GATE_CHECKS:
            violators = expected.get(cid, [])
            if not violators:
                fails.append(f"gate: no planted violator for {cid}")
                continue
            for vid in violators:
                bead = next(b for b in loaded if b["id"] == vid)
                actual = lint_bead_failures(bead, gate_ids)
                if not any(item == cid or item.startswith(cid + ":")
                           for item in actual):
                    fails.append(f"gate: {cid} misses planted {vid}")
        # Controls include the ACPHASE1 legacy bead (reported, never refused)
        # and the enforced tagged / AC-KITLIB beads.
        for cid in ("st-clean-a", "st-clean-b", "st-clean-l",
                    "st-clean-l-kitlib", "st-v-l-legacy"):
            bead = next(b for b in loaded if b["id"] == cid)
            got_gate = lint_bead_failures(bead, gate_ids)
            if got_gate:
                fails.append(f"gate: control {cid} flagged {got_gate}")
        log["gate"] = {"checks": list(GATE_CHECKS)}
        # LINTGATE1: template_missing probes (agreement with live `br
        # lint` is proved by tests/test_bead_lint_gate.sh, not here).
        probes = [
            (("task", "WHAT: x. WHY: y.", "- [ ] done; planted RED."),
             []),
            (("task", "WHAT: x. WHY: y.", ""), ["## Acceptance Criteria"]),
            (("task", "WHAT: x. WHY: y.\n## Acceptance Criteria\ntext", ""),
             []),
            (("bug", "WHAT: x. WHY: y.\n## Steps to Reproduce\nt", ""),
             ["## Acceptance Criteria"]),
            (("bug", "WHAT: x. WHY: y.\n## Steps to Reproduce\nt",
              "- [ ] x; planted RED."), []),
            (("bug", "text\n## steps to reproduce", "- [ ] x; RED."),
             ["## Steps to Reproduce"]),
            (("epic", "text", "- [ ] x"), ["## Success Criteria"]),
            (("epic", "text\n## Success Criteria\nt", ""), []),
            (("feature", "WHAT: x. WHY: y.", ""), ["## Acceptance Criteria"]),
            (("chore", "text", ""), []),
        ]
        for (itype, desc, acc), want in probes:
            got = template_missing(itype, desc, acc)
            if sorted(got) != sorted(want):
                fails.append(f"template: {(itype, desc[:20], acc[:10])} "
                             f"want {want} got {got}")
        log["template_probes"] = {"count": len(probes)}
        green = {
            "nodes": ["st-top", "st-mid", "st-leaf"],
            "edges": [{"from": "st-leaf", "to": "st-mid"},
                      {"from": "st-mid", "to": "st-top"}],
            "damping": DAMPING,
            "tolerance": TOLERANCE,
            "expected_top_id": "st-top",
            "bv_top_id": "st-top",
        }
        gr = run_pagerank_cert(green, probe)
        if not (gr.get("status") == "pass"
                and gr.get("residual_l1", 1) < TOLERANCE
                and gr.get("predicted_top_id") == "st-top"
                and gr.get("node_order_invariant") is True):
            fails.append(f"pagerank green failed: {gr}")
        red = dict(green)
        red["bv_top_id"] = "st-leaf"
        rr = run_pagerank_cert(red, probe)
        if not (rr.get("status") == "fail"
                and "bv_top_mismatch" in rr.get("failure_class", [])):
            fails.append(f"pagerank red failed: {rr}")
        log["pagerank_green"] = {k: gr.get(k) for k in
                                 ("status", "residual_l1",
                                  "predicted_top_id",
                                  "node_order_invariant")}
        log["pagerank_red_failure_class"] = rr.get("failure_class")
        chain = [
            mkbead("sx-a", desc="WHAT: a. WHY: b.",
                   acc="- [ ] done; planted negative RED.\n",
                   deps=[dep_to("sx-a", "sx-b")]),
            mkbead("sx-b", desc="WHAT: a. WHY: b.",
                   acc="- [ ] done; planted negative RED.\n",
                   deps=[dep_to("sx-b", "sx-c")]),
            mkbead("sx-c", desc="WHAT: a. WHY: b.",
                   acc="- [ ] done; planted negative RED.\n"),
        ]
        cnodes = ["sx-a", "sx-b", "sx-c"]
        rp = run_pagerank_cert(
            build_pagerank_fixture(chain, cnodes, "sx-c"), probe)
        if rp.get("status") != "pass":
            fails.append(f"sink agree must pass: {rp}")
        rf = run_pagerank_cert(
            build_pagerank_fixture(chain, cnodes, "sx-a"), probe)
        if not (rf.get("status") == "fail"
                and "expected_top_mismatch" in rf.get("failure_class", [])):
            fails.append(f"sink disagree must fail expected_top_mismatch: {rf}")
        log["sink_flip"] = {"agree": rp.get("status"),
                            "disagree": rf.get("status")}
    finally:
        work.cleanup()
    return (not fails), {"failures": fails, "log": log}


def live_ids(repo: str, timeout: int = 120) -> set[str]:
    """Every tracker id, read live with `br list` (no flush, no tracker write)."""
    rc, out, err = run(["br", "list", "--status", "all", "--deferred",
                        "--limit", "0", "--json"], repo, timeout)
    if rc != 0:
        raise RuntimeError(f"br list failed rc={rc}: {(err or out)[:300]}")
    try:
        data = json.loads(out)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"br list unparsable: {exc}")
    rows = data.get("issues", data) if isinstance(data, dict) else data
    return {row["id"] for row in rows
            if isinstance(row, dict) and row.get("id")}


def lint_one(repo: str, bead_id: str) -> tuple[int, dict]:
    """Per-bead verdict from the live tracker: the same checks the create and
    update gates run (lint_bead_failures). Exit 0 PASS, 1 FAIL, 3 UNVERIFIED."""
    try:
        bead = live_bead(repo, bead_id)
        byid = live_ids(repo) | {bead["id"]}
    except (RuntimeError, OSError) as exc:
        return 3, {"bead": bead_id, "verdict": "UNVERIFIED",
                   "reason": str(exc)[:300]}
    failures = lint_bead_failures(bead, byid)
    return (1 if failures else 0), {
        "bead": bead_id, "verdict": "FAIL" if failures else "PASS",
        "failures": failures}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Upstream home: bead-lint north-star checks (a)-(j) + "
        "pagerank-cert block; --selftest proves each check bites.",
    )
    ap.add_argument("--probe", default=PROBE_DEFAULT,
                    help="bv-readiness-probe.sh path")
    ap.add_argument("--selftest", action="store_true",
                    help="planted violator per (a)-(j), clean pass, "
                    "per-check mutation proof, pagerank green/red + sink")
    ap.add_argument("--pretty", action="store_true",
                    help="indent the JSON")
    ap.add_argument("--out", default="", help="also write JSON to PATH")
    ap.add_argument("--bead", default="",
                    help="lint one bead from the live tracker (br show/list, "
                    "no flush); prints PASS, FAIL with the failing check "
                    "names, or UNVERIFIED; exit 0 PASS, 1 FAIL, 3 UNVERIFIED")
    ap.add_argument("--repo", default=".",
                    help="tracker repo for --bead (the directory holding .beads)")
    ap.add_argument("--json", action="store_true",
                    help="with --bead, print the verdict as JSON")
    args = ap.parse_args(argv)
    if args.bead:
        code, verdict = lint_one(os.path.abspath(args.repo), args.bead)
        if args.json:
            print(json.dumps(verdict, indent=2 if args.pretty else None,
                             sort_keys=True))
        elif verdict["verdict"] == "FAIL":
            print(f"FAIL {args.bead}: {', '.join(verdict['failures'])}")
        elif verdict["verdict"] == "UNVERIFIED":
            print(f"UNVERIFIED {args.bead}: {verdict['reason']}")
        else:
            print(f"PASS {args.bead}")
        return code
    if not args.selftest:
        ap.print_help()
        return 2
    ok, report = run_selftest(args.probe)
    payload = {"schema_version": KIT_BEAD_LINT_VERSION,
               "mode": "selftest",
               "generated_at": utcnow_iso(),
               "ok": ok,
               "report": report}
    text = json.dumps(payload, indent=2 if args.pretty else None,
                      sort_keys=True)
    print(text)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text + "\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
