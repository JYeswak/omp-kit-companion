#!/usr/bin/env python3
"""release-card-check: refuse a release whose card is missing, incomplete or a wave (RELCARD1).

ompkit-fp72.120.16.254, Joshua J-2026-11-05-03: every release carries a gap lane and 1 to 3 optimization ideas,
at least one applied and measured. The card is docs/releases/v<version>.md, read from the exact source commit with
``git cat-file`` (never the working tree). The grammar is documented in docs/release-rubric.md, "Card grammar".

Usage: release-card-check.py --repo DIR --rev SHA --version X.Y.Z
Exit 0 prints one RELEASE_CARD_OK line. Exit 1 prints one refusal line: RELEASE_CARD_MISSING,
RELEASE_WAVE, or RELEASE_CARD_INCOMPLETE section <n> (<title>). Exit 2 is a usage or git error.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from typing import Dict, List, Optional, Tuple

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from pysafe import run_bounded  # noqa: E402  (cancel-safe spawn: own process group, stdin DEVNULL, hard deadline)

RUBRIC = "docs/release-rubric.md"
# Card section number -> the title its heading must start with (rubric sections 1-4).
SECTIONS = {1: "Gap lane", 2: "Optimization lane", 3: "Measures", 4: "Error budget"}
# A gap row ships when its State cell starts with one of these words; an idea is applied when its Decision does.
SHIPPED = re.compile(r"(?:closed|landed)\b")
APPLIED = re.compile(r"applied\b")
# The first cell of a measures row names its DORA metric with one of these prefixes.
DORA_PREFIXES = ("change lead time", "deployment frequency", "published releases", "failed deployment recovery",
                 "change fail rate", "deployment rework rate")
# A measured change: a number (optionally with a unit word) before the arrow and a number after it. ASCII digits;
# bounded runs and single optional spaces keep each search attempt constant; only the first DECISION_SCAN characters
# of a cell are read.
MEASURED = re.compile(r"[0-9][0-9.,]{0,24}%?(?: ?[A-Za-z%]{1,16})? ?(?:→|->) ?[~≈]?[-+−]?[0-9]")
DECISION_SCAN = 2000
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
HEADING = re.compile(r"## +([0-9]{1,2})\. +(.*)")
CARD_CAP = 1 << 20


class Refusal(Exception):
    pass


def git(repo: str, *args: str) -> Tuple[int, bytes, bytes]:
    result = run_bounded(["git", "-C", repo, *args], timeout=30, cap_bytes=CARD_CAP + 1)
    if result.outcome != "OK":
        raise RuntimeError(f"git {args[0]} timed out after 30s; process group killed")
    return result.returncode or 0, result.stdout, result.stderr


def sections(text: str) -> Dict[int, Tuple[str, List[str]]]:
    """Each `## <n>. <title>` heading starts section n; it runs to the next `## ` heading."""
    found: Dict[int, Tuple[str, List[str]]] = {}
    current: Optional[List[str]] = None
    for line in text.splitlines():
        if line.startswith("## "):
            match = HEADING.fullmatch(line.strip())
            current = None
            if match and int(match[1]) not in found:
                current = []
                found[int(match[1])] = (match[2].strip(), current)
        elif current is not None:
            current.append(line)
    return found


def cells(line: str) -> List[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def first_table(lines: List[str]) -> Tuple[List[str], List[List[str]]]:
    """The section's first pipe table: header cells and data rows (the |---| row is skipped)."""
    block: List[str] = []
    for line in lines:
        if line.lstrip().startswith("|"):
            block.append(line)
        elif block:
            break
    separator = block[1].strip() if len(block) >= 2 else ""
    if "---" not in separator or separator.strip("|:- "):
        return [], []
    return cells(block[0]), [cells(line) for line in block[2:]]


def column(header: List[str], name: str) -> Optional[int]:
    for index, cell in enumerate(header):
        if plain(cell).lower().startswith(name.lower()):
            return index
    return None


def plain(cell: str) -> str:
    return cell.replace("*", "").replace("`", "").strip()


def section(found: Dict[int, Tuple[str, List[str]]], number: int) -> Optional[List[str]]:
    entry = found.get(number)
    if entry is None or not entry[0].lower().startswith(SECTIONS[number].lower()):
        return None
    return entry[1]


def incomplete(number: int, why: str) -> Refusal:
    return Refusal(f"RELEASE_CARD_INCOMPLETE section {number} ({SECTIONS[number]}): {why} ({RUBRIC} §{number})")


def judge(card: str, text: str) -> str:
    found = sections(text)
    gap_lines, idea_lines = section(found, 1), section(found, 2)
    shipped: List[str] = []
    if gap_lines is not None:
        header, rows = first_table(gap_lines)
        state = column(header, "State")
        if state is not None:
            shipped = [row[0] for row in rows if len(row) > state and SHIPPED.match(plain(row[state]).lower())]
    ideas: List[List[str]] = []
    applied: List[str] = []
    decision = None
    if idea_lines is not None:
        header, ideas = first_table(idea_lines)
        decision = column(header, "Decision")
        if decision is not None:
            applied = [plain(row[1] if len(row) > 1 else row[0])[:80] for row in ideas if len(row) > decision
                       and APPLIED.match(plain(row[decision]).lower())
                       and MEASURED.search(row[decision][:DECISION_SCAN])]
    if not shipped and not applied:
        raise Refusal(f"RELEASE_WAVE: {card} shows no closed or landed gap bead and no applied idea with a measured "
                      f"change; version bumps, notes-only promotions and re-cuts are waves ({RUBRIC} Wave test)")
    if gap_lines is None:
        raise incomplete(1, "no '## 1. Gap lane' section")
    if not shipped:
        raise incomplete(1, "no gap-lane row has State closed or landed")
    if idea_lines is None:
        raise incomplete(2, "no '## 2. Optimization lane' section")
    if decision is None:
        raise incomplete(2, "the optimization table has no Decision column")
    if not 1 <= len(ideas) <= 3:
        raise incomplete(2, f"the optimization table lists {len(ideas)} ideas; it needs 1 to 3")
    if not applied:
        raise incomplete(2, "no idea's Decision starts with applied and records a measured change X → Y")
    measure_lines = section(found, 3)
    if measure_lines is None:
        raise incomplete(3, "no '## 3. Measures' section")
    header, rows = first_table(measure_lines)
    before = column(header, "Before")
    if before is None:
        raise incomplete(3, "the measures table has no Before column")
    dora = [row for row in rows if plain(row[0]).lower().startswith(DORA_PREFIXES)]
    if not dora:
        raise incomplete(3, "the measures table has no DORA row")
    empty = [plain(row[0]) for row in dora if len(row) <= before or not plain(row[before])]
    if empty:
        raise incomplete(3, "the Before column is empty for DORA row(s): " + "; ".join(empty))
    budget = section(found, 4)
    if budget is None or not any(line.strip() for line in budget):
        raise incomplete(4, "no '## 4. Error budget' section with a reading")
    return (f"RELEASE_CARD_OK {card}: {len(shipped)} gap row(s) closed or landed; {len(ideas)} idea(s), "
            f"applied: {applied[0]}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Refuse a release with no complete two-lane release card.")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--rev", required=True)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    if not VERSION.fullmatch(args.version):
        print("release-card-check: --version must be X.Y.Z", file=sys.stderr)
        return 2
    rc, out, err = git(args.repo, "rev-parse", "--verify", "--quiet", args.rev + "^{commit}")
    if rc != 0:
        print(f"release-card-check: {args.rev} is not a commit in {args.repo} {err.decode(errors='replace').strip()}",
              file=sys.stderr)
        return 2
    sha = out.decode().strip()
    card = f"docs/releases/v{args.version}.md"
    rc, out, err = git(args.repo, "cat-file", "blob", f"{sha}:{card}")
    try:
        if rc != 0:
            raise Refusal(f"RELEASE_CARD_MISSING: source {sha} has no {card}; write the card against {RUBRIC} "
                          "and commit it before the cut")
        if len(out) > CARD_CAP:
            raise Refusal(f"RELEASE_CARD_INCOMPLETE: {card} at {sha} exceeds {CARD_CAP} bytes")
        print(judge(f"{card} at {sha}", out.decode("utf-8", errors="replace")))
        return 0
    except Refusal as refusal:
        print(str(refusal))
        return 1


if __name__ == "__main__":
    sys.exit(main())
