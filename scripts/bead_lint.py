#!/usr/bin/env python3
"""bead_lint.py -- upstream home of the bead-lint north-star checks.

Provenance: ported verbatim from
skill-library-growth/scripts/bead-lint.py at d621765876faafb542d19f397e5b0e3d3e6dbc39
(bead skill-library-growth-4ov9; rz5.119 bead-lint merge open item).
The remaining parameterized defaults preserve the upstream stale-warning
and parked-bead behavior.

Single-home rule: this module OWNS every symbol it defines. The growth
scripts/bead-lint.py imports them (fail-closed exit 2 when this home is
missing) and keeps only live-tool composition (br/bv/omp-kit doctor),
dispositions, receipt assembly and its CLI. A check that fires via the
growth gate fires identically here: same code objects, proven by both
--selftest suites.

Check catalog (all trace to the beads-north-star standard):
  b-what-why-acc  d-negative-specimen  h-placeholders
  j-stale-blocked (warning)  k-close-receipt
  l-ac-phase  l-ac-phase-legacy (warning)  r-verify-replayable (admission only)
  p-pitfalls (admission; pre-cutover beads get PITFALLS_LEGACY warnings)
p-pitfalls (BEADPITFALL1 ompkit-fp72.120.16.159): a kind:fix/kind:feature bead
created at or after PITFALLS_CUTOVER carries a Pitfalls section with at least
one concrete item, or the owning repo's `omp-kit-brief: <repo> <sha256>` line;
the create and update gates refuse it naming the missing section and the fix.
RELLINT1 admission: a kind:goal/pillar:release acceptance must execute the
release-local.sh dry-run using its default freshly fetched origin head.
An explicit --source override or a printed command is not that readback;
positive bead-closure prerequisites never substitute for the release path.
l-ac-phase (ACPHASE1 ompkit-9e9w6): every acceptance item of a bead created
at or after ac_phase.AC_PHASE_CUTOVER carries exactly one phase tag
([build] | [landed] | [live] | [after <window>]) in the leading run of
bracketed tokens after its checkbox (scope letters may share the run; zero
tags is AC_PHASE_UNTAGGED, two or more AC_PHASE_MULTI); beads created before it
are reported under l-ac-phase-legacy and never refused. Grammar, cutover and
digest live in ac_phase.py, shared with the create and in_review gates.
r-verify-replayable (REPLAYABLE1 ompkit-fp72.135.3.71): the create and update
admission refuses a new or changed non-[v] acceptance box `omp-kit verify`
cannot replay (no backticked command, or a tag run that is not one scope letter
then one known phase), naming it with the corrected shape. The box grammar is
src/verify.ts's own, run through scripts/box-lint.ts, never re-implemented
here. Unchanged legacy boxes are reported by read-only lint and listing
(replayable_report, --replayable-report); a claim or in_review move of a bead
verify cannot replay is refused REFUSED_NOT_REPLAYABLE
(replayable_claim_refusal, J-2026-10-29-22).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import kitlib_tmp  # noqa: E402  (owned temp dirs: removed on exit and HUP/INT/TERM)
import kitlib_run  # noqa: E402  (bounded child runs; sibling in every release)
import ac_phase  # noqa: E402  (ACPHASE1 phase grammar and cutover; sibling in every release)

KIT_BEAD_LINT_VERSION = "bead-lint.kit/v1"
STALE_DAYS = 14

CHECKBOX_RE = re.compile(r"^\s*-\s*\[[ xX]\]", re.M)
WHAT_RE = re.compile(r"\bWHAT\s*:")
WHY_RE = re.compile(r"\bWHY\s*:")
NEGATIVE_RE = re.compile(
    r"plant|known-?bad|negativ|mutant|fire|refus|reject", re.I
)
PLACEHOLDER_RE = re.compile(r"TODO|TBD|<\.\.\.>|<…>|\?\?\?")


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
            stdin=subprocess.DEVNULL,  # pysafe(subprocess-orphan): callers pass single-process leaf binaries; the timeout bounds each call
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


def iter_box_lines(acc: str) -> list[str]:
    return [
        line
        for line in (acc or "").splitlines()
        if re.match(r"^\s*-\s*\[[ xX]\]", line)
    ]


def check_d(beads: list[dict]) -> list[str]:
    return [
        b["id"]
        for b in beads
        if not NEGATIVE_RE.search(b.get("acceptance_criteria") or "")
    ]


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

# REPLAYABLE1 (ompkit-fp72.135.3.71). The box grammar lives only in
# src/verify.ts; box-lint.ts runs it and this module shapes the verdict, so the
# admission lint and the verify verb cannot disagree about a box.
BOX_LINT = Path(__file__).resolve().parent / "box-lint.ts"
BOX_LINT_TIMEOUT_S = 15
REPLAYABLE_CHECK = "r-verify-replayable"


class BoxGrammarUnavailable(RuntimeError):
    """box-lint.ts could not run or answered off-contract; callers warn, never refuse blind."""


def box_grammar_argv() -> tuple[list[str], dict[str, str]]:
    """The runner for box-lint.ts: a release's own binary (BUN_BE_BUN=1 runs the
    shipped bundle with the embedded Bun) when scripts/ sits in a release, else
    bun from OMP_KIT_BUN or PATH in a checkout."""
    release_bin = BOX_LINT.parent.parent / "bin" / "omp-kit"
    if release_bin.is_file() and os.access(release_bin, os.X_OK):
        return [str(release_bin), str(BOX_LINT)], {"BUN_BE_BUN": "1"}
    bun = os.environ.get("OMP_KIT_BUN") or shutil.which("bun")
    if not bun:
        raise BoxGrammarUnavailable(
            "no release bin/omp-kit beside scripts/ and no bun on PATH")
    return [bun, str(BOX_LINT)], {}


def box_verdicts(items: list[dict]) -> list[dict]:
    """One box-lint.ts run over items ({id, acceptance, baseline}); rows in order."""
    argv, extra = box_grammar_argv()
    try:
        result = kitlib_run.run(
            argv, deadline_s=BOX_LINT_TIMEOUT_S,
            stdin=json.dumps({"items": items}).encode("utf-8"),
            env={**os.environ, **extra}, max_output_bytes=64 << 20)
    except OSError as exc:
        raise BoxGrammarUnavailable(f"box-lint.ts did not start: {exc}")
    if result.rc != 0 or result.timed_out or result.truncated:
        raise BoxGrammarUnavailable(
            f"box-lint.ts rc={result.rc} timed_out={result.timed_out} "
            f"truncated={result.truncated}: "
            f"{result.stderr.decode('utf-8', 'replace')[:300]}")
    try:
        doc = json.loads(result.stdout)
    except ValueError as exc:
        raise BoxGrammarUnavailable(f"box-lint.ts output unparsable: {exc}")
    rows = doc.get("items") if isinstance(doc, dict) and doc.get("schema") == "box-lint/v1" else None
    if not isinstance(rows, list) or len(rows) != len(items):
        raise BoxGrammarUnavailable("box-lint.ts answered off-contract")
    return rows


def replayable_findings(
    bead: dict, baseline: str | None
) -> tuple[list[str], list[str]]:
    """(failures, notices) for one prospective bead at admission.

    `baseline` is the stored acceptance an update replaces (None for a
    create). Only new or changed boxes can fail; unchanged ones are notices.
    """
    row = box_verdicts([{"id": bead.get("id") or "<new>",
                         "acceptance": bead.get("acceptance_criteria") or "",
                         "baseline": baseline}])[0]
    failures = []
    if row["refused"]:
        failures.append(
            f"{REPLAYABLE_CHECK}:ACCEPTANCE_NOT_REPLAYABLE "
            + " ; ".join(f["detail"] for f in row["refused"]))
    notices = []
    if row["legacy"]:
        notices.append(
            f"ACCEPTANCE_NOT_REPLAYABLE_LEGACY {row['id']}: unchanged boxes omp-kit "
            f"verify cannot replay (reported, not refused): "
            + " ; ".join(f["detail"] for f in row["legacy"]))
    return failures, notices


def replayable_claim_refusal(bead: dict) -> list[str]:
    """REPLAYABLE1 claim gate (J-2026-10-29-22): one line per reason `omp-kit
    verify` would refuse this bead ACCEPTANCE_NOT_REPLAYABLE, [] when it can
    replay it. Old and new boxes alike count: claiming is where legacy beads
    migrate."""
    row = box_verdicts([{"id": bead.get("id") or "<new>",
                         "acceptance": bead.get("acceptance_criteria") or "",
                         "baseline": None}])[0]
    if row["replayable"]:
        return []
    if row["boxes"] == 0:
        return ["no acceptance box verify can replay (a `- [ ] [<letter>] [<phase>]` "
                "box other than [v]); corrected shape: - [ ] [a] [build] <what it proves> "
                "`<one bounded command>` -> rc 0 (or: N pass 0 fail, prints <text>)"]
    return [finding["detail"] for finding in row["refused"]]


def replayable_report(beads: list[dict]) -> list[dict]:
    """Legacy report: one row per in-scope bead (not closed, not parked, not a
    tombstone) whose stored acceptance `omp-kit verify` cannot replay. Each bead
    is judged against its own unchanged text, so the report refuses nothing."""
    cut = [b for b in scope_beads(beads) if b.get("status") != "tombstone"]
    rows = box_verdicts([{"id": b["id"], "acceptance": b.get("acceptance_criteria") or "",
                          "baseline": b.get("acceptance_criteria") or ""} for b in cut])
    report = []
    for bead, row in zip(cut, rows):
        if row["replayable"]:
            continue
        report.append({
            "id": bead["id"],
            "status": bead.get("status") or "",
            "owner": bead.get("assignee") or bead.get("created_by") or "",
            "boxes": row["boxes"],
            "refused": len(row["refused"]),
            "not_replayable": [{"index": f["index"], "reason": f["reason"], "line": f["line"]}
                               for f in row["legacy"] + row["refused"]],
            "title": bead.get("title") or "",
        })
    return sorted(report, key=lambda r: r["id"])


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
    beads.append(clean_bead("st-v-b", desc="no sections here",
                            acc="planted negative specimen noted, no list"))
    expected["b-what-why-acc"] = ["st-v-b"]
    beads.append(clean_bead(
        "st-v-d",
        acc="- [ ] [a] [build] widget builds with no adversarial specimen.\n"
        "- [ ] [b] [build] docs render, again no adversarial specimen.\n",
    ))
    expected["d-negative-specimen"] = ["st-v-d"]
    beads.append(clean_bead(
        "st-v-h",
        desc=CLEAN_DESC + " Still TODO: finish later.",
    ))
    expected["h-placeholders"] = ["st-v-h"]
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
    # observation window, while counted reports or runs over time still are.
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
    "b-what-why-acc", "d-negative-specimen",
    "h-placeholders", "j-stale-blocked", "k-close-receipt",
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
    return {
        "b-what-why-acc": check_b(scoped),
        "d-negative-specimen": check_d(scoped),
        "h-placeholders": check_h(scoped),
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

# Per-bead subset enforced at admission; lifecycle checks stay in the runner.
GATE_CHECKS = (
    "b-what-why-acc",
    "d-negative-specimen",
    "h-placeholders",
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
    r"|\b\d+\s*(?:hours?|hrs?|h|days?|d|weeks?|w|minutes?|mins?)\s+(?:window|period|deadline)\b"
    r"|\b\d+\s*-\s*(?:minutes?|mins?)\b"
    r"|\bafter\s+(?:the\s+)?kit\s+release\s+is\s+installed\b"
    r"|\bwithin\s+\d+\s+fast[- ]lane\s+cadences?\s+of\s+deploy\b"
    r"|\bnext\s+push[- ]run\b"
    r"|\b\d+\s*(?:hours?|hrs?|h)\s+after\s+landing\b"
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


_RELEASE_CLOSURE_RE = re.compile(
    r"^(?:(?:all|every|each)\s+(?:(?:pinned|child|release)\s+)?"
    r"(?:beads?|children|issues?)\s+(?:(?:are|is)\s+|must\s+be\s+)?closed\b"
    r"|(?:tag(?:\s+the)?\s+release\s+(?:only\s+)?after|no\s+release\s+tag\s+until)\s+"
    r"(?:all\s+)?(?:(?:pinned|child)\s+)?(?:beads?|children|issues?)\s+"
    r"(?:(?:are|is)\s+|must\s+be\s+)?closed\b)",
    re.IGNORECASE,
)


def _origin_release_dry_run(command: str) -> bool:
    """Recognize a simple direct/bash/sh invocation; unsupported shell forms do not qualify."""
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|")
    lexer.whitespace_split = True
    try:
        words = list(lexer)
    except ValueError:
        return False
    if any(word and all(char in ";&|" for char in word) for word in words):
        return False
    if words and Path(words[0]).name in ("bash", "sh"):
        words = words[1:]
    if not words or Path(words[0]).name != "release-local.sh":
        return False
    dry_run = False
    index = 1
    while index < len(words):
        if words[index] == "--dry-run":
            dry_run = True
            index += 1
        elif words[index] == "--version" and index + 1 < len(words):
            index += 2
        else:
            return False
    return dry_run


def release_goal_failures(bead: dict) -> list[str]:
    """Release goals depend on the real release check, not closure-count ceremony."""
    if not {"kind:goal", "pillar:release"}.issubset(bead.get("labels") or []):
        return []
    items = ac_phase.parse(bead.get("acceptance_criteria"))
    failures = []
    if not any(
        _origin_release_dry_run(command)
        for item in items
        for command in item["line"].split("`")[1::2]
    ):
        failures.append("RELEASE_DRYRUN_BOX_MISSING")
    for item in items:
        line = item["text"]
        position = 0
        while token := ac_phase.RUN_TOKEN_RE.match(line, position):
            position = token.end()
        if _RELEASE_CLOSURE_RE.match(line[position:].lstrip()):
            failures.append("RELEASE_BEAD_CLOSURE_PREREQUISITE")
            break
    return failures


# ---- BEADPITFALL1 (ompkit-fp72.120.16.159, J-2026-11-03-52): p-pitfalls ----
# A build bead (kind:fix / kind:feature) states the rules its work will be judged
# by: a Pitfalls section with at least one concrete item, or the owning repo's
# `omp-kit-brief: <repo> <sha256>` digest line (the BRIEFCONTRACT1 task-brief
# line). Beads created at or after PITFALLS_CUTOVER (a create's created_at is its
# admission clock) are refused by the create and update gates; older beads get
# PITFALLS_LEGACY warning lines only (pitfalls_legacy), never a refusal.
PITFALLS_CHECK = "p-pitfalls"
PITFALLS_CUTOVER = "2026-11-05T00:00:00Z"  # BEADPITFALL1 landed 2026-11-04; creates from this UTC midnight are enforced
BUILD_LABELS = ("kind:fix", "kind:feature")
PITFALLS_HEADING_RE = re.compile(
    r"^\s{0,3}(?:#{1,6}\s*)?(?:\*\*)?pitfalls(?:\*\*)?\s*(?::(?:\*\*)?\s*(.*))?$", re.I)
PITFALLS_SECTION_END_RE = re.compile(r"^\s{0,3}(?:#{1,6}\s+\S|[A-Z][A-Z0-9_ -]{0,30}:(?:\s|$))")
PITFALLS_ITEM_RE = re.compile(r"^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+(.*)$")
PITFALL_PLACEHOLDER_RE = re.compile(
    r"^(?:none|n/?a|nothing|nil|tbd|todo|unknown|see above|same as above)\b", re.I)
BRIEF_LINE_RE = re.compile(r"^[ \t]*omp-kit-brief:[ \t]+/\S+[ \t]+[0-9a-f]{64}[ \t]*$", re.M)


def pitfall_items(desc: str | None) -> tuple[bool, list[str]]:
    """(has a Pitfalls heading, the items under every such heading).

    A section runs from `Pitfalls`/`## Pitfalls`/`Pitfalls: <text>` to the next
    markdown heading or upper-case `LABEL:` line; bullets, numbered items and
    plain lines are items, indented lines continue the item above."""
    lines = (desc or "").splitlines()
    found, items, i = False, [], 0
    while i < len(lines):
        heading = PITFALLS_HEADING_RE.match(lines[i])
        i += 1
        if not heading:
            continue
        found = True
        if (heading.group(1) or "").strip():
            items.append(heading.group(1).strip())
        while i < len(lines):
            line = lines[i]
            if line.strip() and (PITFALLS_HEADING_RE.match(line) or PITFALLS_SECTION_END_RE.match(line)):
                break
            i += 1
            if not line.strip():
                continue
            item = PITFALLS_ITEM_RE.match(line)
            if item:
                items.append(item.group(1).strip())
            elif items and line[:1].isspace():
                items[-1] += " " + line.strip()
            else:
                items.append(line.strip())
    return found, items


def concrete_pitfall(text: str) -> bool:
    """A pitfall names something checkable: three or more words, not a placeholder."""
    core = text.strip(" \t.:;-*`_")
    return len(re.findall(r"[\w/.'`-]+", core)) >= 3 and not PITFALL_PLACEHOLDER_RE.match(core)


def pitfalls_finding(bead: dict) -> list[str]:
    """p-pitfalls finding for one build bead, whatever its age."""
    labels = bead.get("labels") or []
    build = [lab for lab in BUILD_LABELS if lab in labels]
    if not build or (bead.get("status") or "") in ("closed", "tombstone"):
        return []
    desc = bead.get("description") or ""
    if BRIEF_LINE_RE.search(desc):
        return []
    found, items = pitfall_items(desc)
    if any(concrete_pitfall(item) for item in items):
        return []
    bid = bead.get("id") or "<new>"
    why = ("its Pitfalls section has no concrete item (each item needs three or more words "
           "and no placeholder such as none/n/a)") if found else "its description has no Pitfalls section"
    return [f"{PITFALLS_CHECK}:PITFALLS_MISSING {bid} is a build bead ({','.join(build)}) and {why}, "
            f"so the rules its work is judged by are unstated; fix: add to the description a "
            f"`## Pitfalls` section with at least one concrete `- <item>` (a repo gate it must pass, "
            f"a file held by another seat, a limit never to raise), or the "
            f"`omp-kit-brief: <repo> <sha256>` line `omp-kit brief --repo <owning repo>` prints"]


def pitfalls_enforced(created_at: str | None) -> bool:
    ts = parse_iso(created_at or "")
    cut = parse_iso(PITFALLS_CUTOVER)
    return ts is None or ts >= cut


def pitfalls_failure(bead: dict) -> list[str]:
    """Refusing p-pitfalls failure: beads (and creates) created at or after PITFALLS_CUTOVER."""
    if not pitfalls_enforced(bead.get("created_at")):
        return []
    return pitfalls_finding(bead)


def pitfalls_legacy(bead: dict) -> list[str]:
    """PITFALLS_LEGACY warning lines for a pre-cutover build bead (never refused)."""
    if pitfalls_enforced(bead.get("created_at")):
        return []
    return [line.replace(f"{PITFALLS_CHECK}:PITFALLS_MISSING", "PITFALLS_LEGACY", 1)
            for line in pitfalls_finding(bead)]


def lint_bead(bead: dict, byid: set[str] | None = None) -> dict[str, list[str]]:
    """Per-bead LINTGATE1 verdict over GATE_CHECKS.

    `bead` is one JSONL-shaped record (prospective creates carry id
    "<new>"); `byid` defaults to just this bead. Offender lists hold the
    bead id when it fails, exactly like the batch checks.
    """
    bead = dict(bead)
    bead.setdefault("id", "<new>")
    single = [bead]
    return {
        "b-what-why-acc": check_b(single),
        "d-negative-specimen": check_d(single),
        "h-placeholders": check_h(single),
        "elapsed-time-mix": [bead["id"]] if elapsed_time_mix_failure(bead) else [],
        "l-ac-phase": [bead["id"]] if ac_phase_failure(bead) else [],
    }


def lint_bead_failures(
    bead: dict, byid: set[str] | None = None,
    graph: list[dict] | None = None, dependents=None,
) -> list[str]:
    """Failing kit-specific checks for one bead; native br owns templates."""
    if (bead.get("status") or "") == "tombstone":
        return []
    failures = [
        check_id
        for check_id, offenders in lint_bead(bead, byid).items()
        if offenders and check_id not in ("elapsed-time-mix", "l-ac-phase")
    ]
    failures.extend(elapsed_time_mix_failure(bead))
    failures.extend(ac_phase_failure(bead))
    failures.extend(release_goal_failures(bead))
    failures.extend(pitfalls_failure(bead))
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


def run_selftest() -> tuple[bool, dict]:
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
        # REPLAYABLE1 (ompkit-fp72.135.3.71): the legacy report over a fixture
        # cut names exactly the in-scope beads verify cannot replay and refuses
        # nothing in it; the same commandless text as a new create is refused,
        # naming the box (planted negative), and a replayable create is admitted.
        rp_cut = [
            mkbead("rp-ok", acc="- [ ] [a] [build] tags parse `sh t.sh` -> rc 0\n"),
            mkbead("rp-nocmd", acc="- [ ] [a] [build] tags parse; planted negative RED.\n"),
            mkbead("rp-multi", acc="- [ ] [a,b] [build] `sh t.sh` -> rc 0\n"),
            mkbead("rp-untagged", acc="- [ ] AC1: tags parse\n"),
            mkbead("rp-closed", status="closed", acc="- [ ] [a] [build] no command\n"),
            mkbead("rp-parked", labels=["parked"], acc="- [ ] [a] [build] no command\n"),
        ]
        try:
            rp_rows = replayable_report(rp_cut)
            rp_refused = sum(row["refused"] for row in rp_rows)
            rp_plant, _ = replayable_findings(rp_cut[1], None)
            rp_control, _ = replayable_findings(rp_cut[0], None)
        except BoxGrammarUnavailable as exc:
            rp_rows, rp_refused, rp_plant, rp_control = [], -1, [], [f"unavailable: {exc}"]
        rp_ids = [row["id"] for row in rp_rows]
        if rp_ids != ["rp-multi", "rp-nocmd", "rp-untagged"]:
            fails.append(f"replayable-report: want rp-multi, rp-nocmd, rp-untagged got {rp_ids}")
        if rp_refused != 0:
            fails.append(f"replayable-report: refused {rp_refused} legacy boxes, want 0")
        if not (rp_plant and "box 1" in rp_plant[0] and "corrected shape" in rp_plant[0]):
            fails.append(f"replayable: commandless create not refused naming box 1: {rp_plant}")
        if rp_control:
            fails.append(f"replayable: replayable create refused: {rp_control}")
        log["replayable_report"] = {"rows": rp_rows, "refused": rp_refused,
                                    "planted_create": rp_plant}
        elapsed_forms = [
            (
                "hours-after-landing",
                "- [ ] [a] [build] build code; planted negative: remove it and RED.\n"
                "- [ ] [b] [live] 24 h after landing, cc.py unknowns shows rows "
                "with last_seen before landing; planted negative: stale rows RED.\n",
                True,
            ),
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
                "On the next push-run, [b] verify; planted negative: omit verification and RED.\n",
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
    finally:
        work.cleanup()
    return (not fails), {"failures": fails, "log": log}


def live_rows(repo: str, timeout: int = 120) -> list[dict]:
    """Every tracker row, read live with `br list` (no flush, no tracker write)."""
    rc, out, err = run(["br", "list", "--status", "all", "--deferred",
                        "--limit", "0", "--json"], repo, timeout)
    if rc != 0:
        raise RuntimeError(f"br list failed rc={rc}: {(err or out)[:300]}")
    try:
        data = json.loads(out)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"br list unparsable: {exc}")
    rows = data.get("issues", data) if isinstance(data, dict) else data
    return [row for row in rows if isinstance(row, dict) and row.get("id")]


def live_ids(repo: str, timeout: int = 120) -> set[str]:
    """Every tracker id, read live with `br list` (no flush, no tracker write)."""
    return {row["id"] for row in live_rows(repo, timeout)}


def replayable_report_live(repo: str) -> tuple[int, dict]:
    """--replayable-report: the legacy report over the live tracker's cut.
    Exit 0 with the report (it never refuses), 3 UNVERIFIED."""
    try:
        beads = live_rows(repo)
        rows = replayable_report(beads)
    except (RuntimeError, OSError) as exc:
        return 3, {"verdict": "UNVERIFIED", "reason": str(exc)[:300]}
    cut = len([b for b in scope_beads(beads) if b.get("status") != "tombstone"])
    return 0, {"verdict": "REPORT", "cut": cut, "not_replayable": len(rows),
               "replayable": cut - len(rows), "rows": rows}


def lint_one(repo: str, bead_id: str) -> tuple[int, dict]:
    """Per-bead verdict from the live tracker: the same checks the create and
    update gates run (lint_bead_failures). Exit 0 PASS, 1 FAIL, 3 UNVERIFIED."""
    try:
        bead = live_bead(repo, bead_id)
        rows = live_rows(repo)
        byid = {row["id"] for row in rows} | {bead["id"]}
        failures = lint_bead_failures(bead, byid, graph=rows)
    except (RuntimeError, OSError) as exc:
        return 3, {"bead": bead_id, "verdict": "UNVERIFIED",
                   "reason": str(exc)[:300]}
    return (1 if failures else 0), {
        "bead": bead_id, "verdict": "FAIL" if failures else "PASS",
        "failures": failures}


def admission_stdin() -> int:
    """Read-only batch composition over the existing predicates; never flush a tracker."""
    try:
        if sys.stdin.isatty():
            raise ValueError("admission-stdin requires piped JSON, not an interactive terminal")
        raw = sys.stdin.buffer.read((16 << 20) + 1)
        if len(raw) > 16 << 20:
            raise ValueError("admission input exceeds 16 MiB")
        payload = json.loads(raw)
        if not isinstance(payload, dict) or not isinstance(payload.get("records"), list):
            raise ValueError("records must be an array")
        records = payload["records"]
        if any(not isinstance(row, dict) or not isinstance(row.get("id"), str) for row in records):
            raise ValueError("every record needs an id")
        normalized = [normalize_show_record(row) for row in records]
        byid = {row["id"]: row for row in normalized}
        if len(byid) != len(normalized):
            raise ValueError("duplicate record id")
        targets = payload.get("targets")
        if not isinstance(targets, list) or any(not isinstance(value, str) or value not in byid for value in targets):
            raise ValueError("targets must name existing records")
        rows = [{"id": ident, "failures": lint_bead_failures(byid[ident], set(byid), normalized)} for ident in targets]
        print(json.dumps({"schema_version": KIT_BEAD_LINT_VERSION, "mode": "admission-stdin", "rows": rows}, sort_keys=True))
        return 0
    except (OSError, ValueError, TypeError, KeyError, BoxGrammarUnavailable) as error:
        print(json.dumps({"schema_version": KIT_BEAD_LINT_VERSION, "mode": "admission-stdin",
                          "error": str(error)}, sort_keys=True))
        return 3


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Upstream home: bead-lint north-star checks; "
        "--selftest proves each check bites.",
    )
    ap.add_argument("--selftest", action="store_true",
                    help="planted violator per check, clean pass, "
                    "per-check mutation proof")
    ap.add_argument("--pretty", action="store_true",
                    help="indent the JSON")
    ap.add_argument("--out", default="", help="also write JSON to PATH")
    ap.add_argument("--bead", default="",
                    help="lint one bead from the live tracker (br show/list, "
                    "no flush); prints PASS, FAIL with the failing check "
                    "names, or UNVERIFIED; exit 0 PASS, 1 FAIL, 3 UNVERIFIED")
    ap.add_argument("--repo", default=".",
                    help="tracker repo for --bead or --replayable-report "
                    "(the directory holding .beads)")
    ap.add_argument("--json", action="store_true",
                    help="with --bead, print the verdict as JSON")
    ap.add_argument("--replayable-report", action="store_true",
                    help="REPLAYABLE1: list the live tracker's in-scope beads "
                    "whose acceptance omp-kit verify cannot replay, as JSON; "
                    "reports only, never refuses; exit 0, 3 UNVERIFIED")
    ap.add_argument("--admission-stdin", action="store_true",
                    help="read-only canonical admission for records/targets JSON on stdin")
    args = ap.parse_args(argv)
    if args.admission_stdin:
        return admission_stdin()
    if args.replayable_report:
        code, report = replayable_report_live(os.path.abspath(args.repo))
        print(json.dumps({"schema_version": KIT_BEAD_LINT_VERSION,
                          "mode": "replayable-report",
                          "generated_at": utcnow_iso(), **report},
                         indent=2 if args.pretty else None, sort_keys=True))
        return code
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
    ok, report = run_selftest()
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
