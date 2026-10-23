#!/usr/bin/env python3
"""ac_phase.py -- acceptance-item evidence phases and in_review admission.

ACPHASE1 (ompkit-9e9w6) and PREGRADE1 (ompkit-3s6d2). One home for the
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

Pregrade record. ``$XDG_STATE_HOME/omp-kit/pregrade/<bead>.json`` (else
``$HOME/.local/state``; nothing else is consulted), schema
``omp-kit.pregrade.v1``, written by the grader. in_review admission of an
ENFORCED bead requires every build/landed item ticked. The pregrade record
is required only when the tracker repo opts in with ``<repo>/.omp/pregrade.json``
holding ``{"required": true}``: then a record for the same bead and digest,
verdict PASS or WAITING, ``at`` within 24 h, graded by someone other than the
author. An absent file or ``required: false`` leaves the record optional, so
a user with no fleet tooling is never asked for one; an unreadable or invalid
file fails closed (PREGRADE_CONFIG_INVALID, and the record is required).

Python 3.9 stdlib only; no I/O except reading the opt-in file and the record.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

AC_PHASE_CUTOVER = "2026-10-24T00:00:00Z"
PHASES = ("build", "landed", "live", "after")
TAG_HELP = "[build] | [landed] | [live] | [after <window>]"
PREGRADE_SCHEMA = "omp-kit.pregrade.v1"
PREGRADE_MAX_AGE = timedelta(hours=24)
# A record stamped later than this past `now` is not trusted as fresh.
PREGRADE_MAX_SKEW = timedelta(minutes=5)
ADMITTING_VERDICTS = ("PASS", "WAITING")
PREGRADE_CONFIG = os.path.join(".omp", "pregrade.json")
PREGRADE_HINT_MAX = 500

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
BEAD_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
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


def pregrade_dir(env: dict | None = None) -> Path:
    """Record directory from XDG_STATE_HOME, else HOME only (never ~/.claude, never a passwd lookup)."""
    env = os.environ if env is None else env
    base = env.get("XDG_STATE_HOME")
    if not base:
        home = env.get("HOME")
        if not home:
            raise ValueError("neither XDG_STATE_HOME nor HOME is set; no pregrade record directory")
        base = os.path.join(home, ".local", "state")
    return Path(base) / "omp-kit" / "pregrade"


def pregrade_config(repo: str | None) -> tuple[bool, str | None, str | None]:
    """(required, invalid_detail, hint) from ``<repo>/.omp/pregrade.json``.

    No repo or no file: not required. ``{"required": <bool>}`` (extra keys
    allowed): that bool, plus an optional string ``hint`` the repo uses to
    tell the worker how to produce a pregrade (control characters dropped,
    capped at PREGRADE_HINT_MAX chars). Anything else, a non-string hint
    included: required, with the reason it is invalid (fail closed).
    """
    if not repo:
        return False, None, None
    path = Path(repo) / PREGRADE_CONFIG
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return False, None, None
    except (OSError, UnicodeError, ValueError) as exc:
        return True, f"{path} unreadable: {exc}", None
    if not isinstance(config, dict) or not isinstance(config.get("required"), bool):
        return True, f'{path} must be a JSON object with a boolean "required"', None
    hint = config.get("hint")
    if hint is not None and not isinstance(hint, str):
        return True, f'{path} "hint" must be a string', None
    if hint is not None:
        hint = "".join(ch for ch in hint if unicodedata.category(ch) != "Cc")[:PREGRADE_HINT_MAX].strip() or None
    return config["required"], None, hint


def pregrade_path(bead_id: str, env: dict | None = None) -> Path:
    if not BEAD_ID_RE.match(bead_id or ""):
        raise ValueError(f"bead id unusable as a pregrade file name: {bead_id!r}")
    return pregrade_dir(env) / f"{bead_id}.json"


def _item_names(items: list[dict]) -> str:
    return " | ".join(f"item {item['index'] + 1}: {item['line'].strip()[:120]}"
                      for item in items)


def pregrade_refusals(
    bead: dict, now: datetime, env: dict | None = None
) -> list[tuple[str, str]]:
    """Section 6 pregrade conditions, as (code, detail) refusals."""
    bead_id = bead.get("id") or ""
    try:
        path = pregrade_path(bead_id, env)
    except ValueError as exc:
        return [("PREGRADE_MISSING", str(exc))]
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return [("PREGRADE_MISSING", f"no pregrade record at {path}; run the "
                 "non-author pregrade for this bead first")]
    except (OSError, UnicodeError, ValueError) as exc:
        return [("PREGRADE_MISSING", f"pregrade record {path} unreadable: {exc}")]
    if not isinstance(record, dict) or record.get("schema") != PREGRADE_SCHEMA:
        return [("PREGRADE_MISSING", f"pregrade record {path} is not {PREGRADE_SCHEMA}")]
    if record.get("bead") != bead_id:
        return [("PREGRADE_MISSING",
                 f"pregrade record {path} is for {record.get('bead')!r}, not {bead_id}")]
    out: list[tuple[str, str]] = []
    digest = ac_sha256(bead.get("acceptance_criteria"))
    if record.get("ac_sha256") != digest:
        out.append(("PREGRADE_AC_CHANGED",
                    f"acceptance text changed since the pregrade "
                    f"(record {str(record.get('ac_sha256'))[:12]}, now {digest[:12]})"))
    verdict = record.get("verdict")
    if verdict not in ADMITTING_VERDICTS:
        out.append(("PREGRADE_NOT_PASSING",
                    f"pregrade verdict {verdict!r}; in_review needs PASS or WAITING"))
    at = parse_ts(record.get("at"))
    if at is None or now - at > PREGRADE_MAX_AGE or at - now > PREGRADE_MAX_SKEW:
        out.append(("PREGRADE_STALE",
                    f"pregrade at {record.get('at')!r} is not within 24 h of "
                    f"{now.strftime('%Y-%m-%dT%H:%M:%SZ')}"))
    grader = record.get("grader")
    grader = grader.strip() if isinstance(grader, str) else None
    authors = {a.strip() for a in (record.get("author"), bead.get("assignee")) if isinstance(a, str) and a.strip()}
    # An empty author set would make any grader a non-author (GateReview finding 1): the author must be known.
    if not grader or not authors or grader in authors:
        out.append(("PREGRADE_SELF",
                    f"grader {grader!r} is the author or the author is unknown "
                    f"({', '.join(sorted(authors)) or 'no author on the record or bead'}); "
                    "a non-author must pregrade a bead with a known author"))
    return out


def in_review_admission(
    bead: dict, now: datetime | None = None, env: dict | None = None,
    repo: str | None = None,
) -> dict:
    """Section 6: {enforced, pregrade_required, refusals: [(code, detail)], notice, hint}.

    `hint` is the repo's sanitized pregrade hint, set only when a PREGRADE_*
    code is among the refusals.

    `bead` carries id, created_at, assignee and the acceptance_criteria
    the bead will hold after the transition; `repo` is the tracker repo
    whose ``.omp/pregrade.json`` opts in to the pregrade requirement.
    """
    now = now or datetime.now(timezone.utc)
    if not is_enforced(bead.get("created_at")):
        return {"enforced": False, "pregrade_required": False, "refusals": [], "hint": None,
                "notice": f"AC_PHASE_LEGACY {bead.get('id')} created "
                          f"{bead.get('created_at')} before {AC_PHASE_CUTOVER}: "
                          "phase and pregrade gates not enforced"}
    items = parse(bead.get("acceptance_criteria"))
    refusals = tag_refusals(bead.get("acceptance_criteria"))
    unticked = [item for item in items
                if item["phase"] in ("build", "landed") and not item["checked"]]
    if unticked:
        refusals.append(("AC_UNTICKED_BUILD_LANDED",
                         f"{_item_names(unticked)}; tick build/landed items once proven"))
    required, invalid, hint = pregrade_config(repo)
    if invalid:
        refusals.append(("PREGRADE_CONFIG_INVALID",
                         f'{invalid}; fix it or remove it ({{"required": true}} opts in)'))
    if required:
        refusals.extend(pregrade_refusals(bead, now, env))
    pregrade_refused = any(code.startswith("PREGRADE_") for code, _ in refusals)
    return {"enforced": True, "pregrade_required": required,
            "refusals": refusals, "notice": None,
            "hint": hint if pregrade_refused else None}
