#!/usr/bin/env python3
"""ac_phase.py -- acceptance-item evidence phases and in_review admission.

ACPHASE1 (ompkit-9e9w6). One home for the
shared contract that bead_lint.py (check l), br_create_guard_core.py (create
admission) and br-update-lint.py (`--status in_review` admission) apply.

Phase grammar. An acceptance item is a line matching ``^\\s*-\\s*\\[( |x|X)\\]``
(lines split on "\\n"). Its phase tag is the first bracketed token after the
checkbox: ``[build]`` (provable in the candidate repo state), ``[landed]``
(provable at the landing ref), ``[live]`` (needs a release, install or live
run) or ``[after <window>]`` with window ``\\d+[mhd]`` or
``>=YYYY-MM-DDTHH:MMZ``. Tags are case-sensitive lowercase and an item
carries exactly one: a second phase tag right after the first makes the item
UNTAGGED (phase None), as does any other first token. An untagged item whose
text starts with ``AC-KITLIB`` is phase build by definition.

Cutover. Beads created at or after AC_PHASE_CUTOVER are ENFORCED; older
beads are LEGACY (reported, never refused). A missing or unreadable
created_at is ENFORCED: the gate never guesses a bead into the exemption.

Digest. ac_sha256 is the sha256 of the UTF-8 acceptance text with every
item's ``[x]``/``[X]`` checkbox replaced by ``[ ]``, so ticking keeps it.

in_review admission of an ENFORCED bead requires every build/landed item ticked.

Python 3.9 stdlib only; no I/O.
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timedelta, timezone

AC_PHASE_CUTOVER = "2026-10-24T00:00:00Z"
PHASES = ("build", "landed", "live", "after")
TAG_HELP = "[build] | [landed] | [live] | [after <window>]"

ITEM_RE = re.compile(r"^\s*-\s*\[( |x|X)\]")
# One token of the leading run of bracketed tokens after the checkbox.
RUN_TOKEN_RE = re.compile(r"\s*\[([^\[\]]*)\]")
# Phase-shaped token text, valid window or not: two of these in the run are
# AC_PHASE_MULTI even when one window is malformed.
PHASE_SHAPED_RE = re.compile(r"(?:build|landed|live|after(?: [^\]]*)?)")
PHASE_TAG_RE = re.compile(
    r"(?:(build|landed|live)|after (\d+[mhd]|>=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z))"
)
BOX_RE = re.compile(r"^(\s*-\s*\[)[xX](\])")
TS_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?"
    r"(Z|[+-]\d{2}:?\d{2})?$"
)


def parse_ts(value: object) -> datetime | None:
    """Aware UTC datetime for an ISO-8601 stamp (br writes nanosecond Z), else None."""
    if not isinstance(value, str):
        return None
    m = TS_RE.match(value.strip())
    if not m:
        return None
    year, month, day, hour, minute, sec, frac, zone = m.groups()
    try:
        out = datetime(int(year), int(month), int(day), int(hour), int(minute),
                       int(sec or 0), int((frac or "0")[:6].ljust(6, "0")),
                       tzinfo=timezone.utc)
    except ValueError:
        return None
    if zone and zone != "Z":
        sign = 1 if zone[0] == "+" else -1
        digits = zone[1:].replace(":", "")
        out -= sign * timedelta(hours=int(digits[:2]), minutes=int(digits[2:]))
    return out


CUTOVER_AT = parse_ts(AC_PHASE_CUTOVER)


def parse(ac_text: str | None) -> list[dict]:
    """Acceptance items of `ac_text` with their phase (contract section 1).

    The phase tag is read from the leading run of bracketed tokens after
    the checkbox (scope letters such as [a] or [a,b] may share the run).
    Exactly one phase-shaped token, with a valid window, sets the phase;
    two or more set `multi` (AC_PHASE_MULTI) and leave phase None.
    """
    items: list[dict] = []
    for line in (ac_text or "").split("\n"):
        m = ITEM_RE.match(line)
        if not m:
            continue
        rest = line[m.end():]
        tokens: list[str] = []
        pos = 0
        # Each token consumes at least "[]", so the run ends within len(rest).
        while pos < len(rest):
            token = RUN_TOKEN_RE.match(rest, pos)
            if not token:
                break
            tokens.append(token.group(1))
            pos = token.end()
        shaped = [t for t in tokens if PHASE_SHAPED_RE.fullmatch(t)]
        phase = window = None
        text = rest.strip()
        if len(shaped) == 1:
            tag = PHASE_TAG_RE.fullmatch(shaped[0])
            if tag:
                phase = tag.group(1) or "after"
                window = tag.group(2)
                kept = [f"[{t}]" for t in tokens if t != shaped[0]]
                text = " ".join(part for part in kept + [rest[pos:].strip()] if part)
        elif not shaped and text.startswith("AC-KITLIB"):
            phase = "build"
        items.append({
            "index": len(items),
            "checked": m.group(1) in ("x", "X"),
            "phase": phase,
            "window": window,
            "multi": len(shaped) >= 2,
            "text": text,
            "line": line,
        })
    return items


def ac_sha256(ac_text: str | None) -> str:
    """Digest of the acceptance text, invariant under ticking (section 3)."""
    lines = (ac_text or "").split("\n")
    unticked = "\n".join(BOX_RE.sub(r"\1 \2", line) for line in lines)
    return hashlib.sha256(unticked.encode("utf-8")).hexdigest()


def is_enforced(created_at: object) -> bool:
    """True when the bead was created at or after the cutover (section 2)."""
    created = parse_ts(created_at)
    return created is None or created >= CUTOVER_AT


def tag_refusals(ac_text: str | None) -> list[tuple[str, str]]:
    """AC_PHASE_UNTAGGED / AC_PHASE_MULTI refusals naming each offending item."""
    items = parse(ac_text)
    out: list[tuple[str, str]] = []
    untagged = [item for item in items if item["phase"] is None and not item["multi"]]
    if untagged:
        out.append(("AC_PHASE_UNTAGGED",
                    f"{_item_names(untagged)}; tag each with one of {TAG_HELP}"))
    multi = [item for item in items if item["multi"]]
    if multi:
        out.append(("AC_PHASE_MULTI",
                    f"{_item_names(multi)}; keep exactly one of {TAG_HELP}"))
    return out


def overall_verdict(items: list[dict]) -> str:
    """Section 5 verdict over items carrying `phase` and `status`.

    Untagged items are graded like build/landed: they must PASS.
    """
    if any(item["status"] == "FAIL" for item in items):
        return "FAIL"
    timed = [item for item in items if item["phase"] in ("live", "after")]
    code = [item for item in items if item["phase"] not in ("live", "after")]
    if all(item["status"] == "PASS" for item in code):
        if all(item["status"] == "PASS" for item in timed):
            return "PASS"
        if any(item["status"] == "WAITING" for item in timed):
            return "WAITING"
    return "UNVERIFIED"


def _item_names(items: list[dict]) -> str:
    return " | ".join(f"item {item['index'] + 1}: {item['line'].strip()[:120]}"
                      for item in items)


def in_review_admission(bead: dict) -> dict:
    """Return phase and build/landed acceptance-tick refusals."""
    if not is_enforced(bead.get("created_at")):
        return {"enforced": False, "refusals": [],
                "notice": f"AC_PHASE_LEGACY {bead.get('id')} created "
                          f"{bead.get('created_at')} before {AC_PHASE_CUTOVER}: "
                          "phase gates not enforced"}
    items = parse(bead.get("acceptance_criteria"))
    refusals = tag_refusals(bead.get("acceptance_criteria"))
    unticked = [item for item in items
                if item["phase"] in ("build", "landed") and not item["checked"]]
    if unticked:
        refusals.append(("AC_UNTICKED_BUILD_LANDED",
                         f"{_item_names(unticked)}; tick build/landed items once proven"))
    return {"enforced": True, "refusals": refusals, "notice": None}
