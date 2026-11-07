#!/usr/bin/env python3
"""release-card-check: refuse missing, incomplete or wave cards (RELCARD1), unpowered experiments (RELPREREG1),
and mechanism evidence promoted to a field-effect claim (RELRUBRIC3).

ompkit-fp72.120.16.254, Joshua J-2026-11-05-03: every release carries a gap lane and 1 to 3 optimization ideas,
at least one applied and measured. The card is docs/releases/v<version>.md, read from the exact source commit with
``git cat-file`` (never the working tree). The grammar is documented in docs/release-rubric.md, "Card grammar".

ompkit-fp72.120.16.258, Joshua J-2026-11-05-05 (RELRUBRIC2): from card version 0.2.94 on, every applied idea needs a
``### Prereg <id>`` block and a ``### Result <id>`` block of paired readings in section 2; the checker recomputes the
required n, retains every pair with its load, computes the paired-t CI and accepts only a SHIPPED verdict. Cards before 0.2.94 were
cut under RELCARD1 alone and are judged by it unchanged.

ompkit-fp72.120.16.301 (RELRUBRIC3): from card version 0.2.95, a deterministic single pair or an explicit fixture
or mutant arm is MECHANISM evidence and can earn only MECHANISM VERIFIED, never SHIPPED/applied as an effect.
Published cards through v0.2.94 retain their original grammar and verdicts; v0.2.95 is not yet released.

Usage: release-card-check.py --repo DIR --rev SHA --version X.Y.Z
Exit 0 prints one RELEASE_CARD_OK line. Exit 1 prints one refusal line: RELEASE_CARD_MISSING, RELEASE_WAVE,
RELEASE_CARD_INCOMPLETE section <n> (<title>), RELEASE_PREREG_MISSING, RELEASE_UNDERPOWERED, RELEASE_INCONCLUSIVE,
RELEASE_NO_EFFECT, RELEASE_REGRESSED or RELEASE_EVIDENCE_CLASS. Exit 2 is a usage or git error.
"""
from __future__ import annotations

import argparse
import math
import os
import re
import sys
from statistics import NormalDist
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
# RELPREREG1: the first card version judged under the preregistration grammar (v0.2.92 and v0.2.93 were cut before it).
PREREG_FROM = (0, 2, 94)
# RELRUBRIC3: published cards through v0.2.94 retain their grammar; the pending v0.2.95 cut uses evidence classes.
EVIDENCE_FROM = (0, 2, 95)
MECHANISM_VERIFIED = re.compile(r"mechanism verified\b", re.IGNORECASE)
MECHANISM_ARM = re.compile(r"\b(?:fixtures?|mutants?)\b", re.IGNORECASE)
EFFECT_CLAIM = re.compile(r"\b(?:shipped|applied)\b", re.IGNORECASE)
SHIPPED_VERDICT = re.compile(r"(?:verdict:\s*)?shipped\b", re.IGNORECASE)
PREREG_FIELDS = ("endpoint", "direction", "producer", "unit", "mde", "mde_source", "sigma_d", "sigma_source", "alpha",
                 "power", "n_pairs", "stopping", "control")
BLOCK = re.compile(r"### +(Prereg|Result) +(\S+)")
FIELD = re.compile(r"([a-z][a-z0-9_]{0,31}):(?: +(.*))?")
COMMENT = re.compile(r"\s+#\s.*$")
NUMBER = re.compile(r"[~≈]? ?([-+−]?[0-9][0-9,]{0,24}(?:\.[0-9]{1,24})?)")
IDEA_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")


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


def number(text: str) -> Optional[float]:
    """The leading number of a cell or field: `~`/`≈` and a Unicode minus allowed, thousands commas dropped."""
    match = NUMBER.match(plain(text))
    return float(match[1].replace("−", "-").replace(",", "")) if match else None


def _beta_fraction(a: float, b: float, x: float) -> float:
    """Continued fraction of the regularized incomplete beta (modified Lentz)."""
    tiny = 1e-300
    c, d = 1.0, 1.0 - (a + b) * x / (a + 1.0)
    d = 1.0 / (d if abs(d) > tiny else tiny)
    result = d
    for m in range(1, 400):
        for numerator in (m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m)),
                          -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1))):
            d = 1.0 + numerator * d
            d = 1.0 / (d if abs(d) > tiny else tiny)
            c = 1.0 + numerator / c
            c = c if abs(c) > tiny else tiny
            result *= c * d
        if abs(c * d - 1.0) < 1e-15:
            break
    return result


def _incomplete_beta(a: float, b: float, x: float) -> float:
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    front = math.exp(math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log1p(-x))
    if x < (a + 1.0) / (a + b + 2.0):
        return front * _beta_fraction(a, b, x) / a
    return 1.0 - front * _beta_fraction(b, a, 1.0 - x) / b


def t_quantile(p: float, df: int) -> float:
    """Student-t quantile for 0.5 < p < 1 (stdlib only): bisect the upper tail 0.5 * I_{df/(df+t^2)}(df/2, 1/2)."""
    tail = 1.0 - p
    upper = lambda t: 0.5 * _incomplete_beta(df / 2.0, 0.5, df / (df + t * t))  # noqa: E731
    low, high = 0.0, 1.0
    while upper(high) > tail:
        low, high = high, high * 2.0
    for _ in range(200):
        middle = (low + high) / 2.0
        if upper(middle) > tail:
            low = middle
        else:
            high = middle
    return high


def required_pairs(mde: float, sigma: float, alpha: float, power: float) -> int:
    """n = ceil(sigma_d^2 (z_{1-a/2} + z_power)^2 / mde^2 + z_{1-a/2}^2 / 2); a deterministic endpoint needs 1."""
    if sigma == 0:
        return 1
    z_alpha, z_power = NormalDist().inv_cdf(1 - alpha / 2), NormalDist().inv_cdf(power)
    return max(2, math.ceil(sigma ** 2 * (z_alpha + z_power) ** 2 / mde ** 2 + z_alpha ** 2 / 2 - 1e-9))


def blocks(lines: List[str]) -> Dict[Tuple[str, str], List[str]]:
    """Each `### Prereg <id>` / `### Result <id>` heading in section 2 starts a block; it runs to the next `### `."""
    found: Dict[Tuple[str, str], List[str]] = {}
    current: Optional[List[str]] = None
    for line in lines:
        if line.startswith("### "):
            match = BLOCK.fullmatch(line.strip())
            current = None
            if match:
                if (match[1], match[2]) in found:
                    raise incomplete(2, f"two '### {match[1]} {match[2]}' blocks")
                current = found[(match[1], match[2])] = []
        elif current is not None:
            current.append(line)
    return found


def fields(lines: List[str], known: Tuple[str, ...]) -> Dict[str, str]:
    """`key: value` lines (fences and `  # comments` ignored); a line that starts no known key continues the last."""
    found: Dict[str, str] = {}
    last: Optional[str] = None
    for raw in lines:
        line = COMMENT.sub("", raw.strip())
        if not line or line.startswith("```") or line.startswith("|"):
            continue
        match = FIELD.fullmatch(line)
        if match and match[1] in known and match[1] not in found:
            last = match[1]
            found[last] = (match[2] or "").strip()
        elif last is not None:
            found[last] = (found[last] + " " + line).strip()
    return found


def prereg_verdict(idea: str, found: Dict[Tuple[str, str], List[str]], applied_count: int,
                   evidence_classes: bool = False, decision: str = "") -> str:
    """Judge one experiment under its card's versioned evidence grammar."""
    where = f"idea {idea}" if evidence_classes else f"applied idea {idea}"
    if ("Prereg", idea) not in found:
        raise Refusal(f"RELEASE_PREREG_MISSING: {where} has no '### Prereg {idea}' block in section 2 ({RUBRIC} "
                      "Card grammar)")
    prereg = fields(found[("Prereg", idea)], PREREG_FIELDS)
    missing = [name for name in PREREG_FIELDS if not prereg.get(name)]
    if missing:
        raise Refusal(f"RELEASE_PREREG_MISSING: '### Prereg {idea}' lacks field(s): {', '.join(missing)} ({RUBRIC} "
                      "Card grammar)")
    values = {name: number(prereg[name]) for name in ("mde", "sigma_d", "alpha", "power", "n_pairs")}
    direction = prereg["direction"].split()[0].lower()
    invalid = [name for name, ok in (
        ("direction", direction in ("lower", "higher")),
        ("mde", values["mde"] is not None and values["mde"] > 0),
        ("sigma_d", values["sigma_d"] is not None and values["sigma_d"] >= 0),
        ("alpha", values["alpha"] is not None and 0 < values["alpha"] < 1),
        ("power", values["power"] is not None and 0 < values["power"] < 1),
        ("n_pairs", values["n_pairs"] is not None and values["n_pairs"] >= 1 and values["n_pairs"].is_integer()),
    ) if not ok]
    if invalid:
        raise Refusal(f"RELEASE_PREREG_MISSING: '### Prereg {idea}' has invalid field(s): {', '.join(invalid)} "
                      f"(direction lower|higher, mde > 0, sigma_d >= 0, 0 < alpha, power < 1, integer n_pairs >= 1; "
                      f"{RUBRIC} Card grammar)")
    mde, sigma, alpha, power = (float(values[name]) for name in ("mde", "sigma_d", "alpha", "power"))  # type: ignore
    n_pairs = int(values["n_pairs"])  # type: ignore[arg-type]
    unit = prereg["unit"].split()[0]
    needed = required_pairs(mde, sigma, alpha, power)
    if n_pairs < needed:
        raise Refusal(f"RELEASE_UNDERPOWERED: '### Prereg {idea}' preregisters n_pairs {n_pairs}, but mde {mde:g}, "
                      f"sigma_d {sigma:g}, alpha {alpha:g} and power {power:g} require {needed}")
    if ("Result", idea) not in found:
        raise Refusal(f"RELEASE_UNDERPOWERED: {where} has no '### Result {idea}' block: 0 valid pairs of the "
                      f"{n_pairs} preregistered")
    result = found[("Result", idea)]
    ncpu = number(fields(result, ("ncpu",)).get("ncpu", ""))
    header, rows = first_table(result)
    columns = [column(header, name) for name in ("before", "after", "load1_before", "load1_after")]
    if ncpu is None or ncpu <= 0 or None in columns:
        raise incomplete(2, f"'### Result {idea}' needs an 'ncpu: N' line and a table with before, after, "
                         "load1_before and load1_after columns")
    differences: List[float] = []
    for index, row in enumerate(rows, 1):
        readings = [number(row[at]) if at is not None and len(row) > at else None for at in columns]
        if None in readings:
            raise incomplete(2, f"'### Result {idea}' row {index} has a non-numeric reading")
        before, after, load_before, load_after = (float(value) for value in readings)  # type: ignore[arg-type]
        differences.append(before - after if direction == "lower" else after - before)
    valid = len(differences)
    if valid < n_pairs:
        raise Refusal(f"RELEASE_UNDERPOWERED: {where} has {valid} pairs of the {n_pairs} preregistered")
    if valid > n_pairs:
        raise Refusal(f"RELEASE_INCONCLUSIVE: {where} has {valid} valid pairs, more than the {n_pairs} preregistered; "
                      "fixed-n stopping admits no extra runs")
    mean = sum(differences) / valid
    spread = math.sqrt(sum((d - mean) ** 2 for d in differences) / (valid - 1)) if valid > 1 else 0.0
    if sigma == 0 and spread > 0:
        raise Refusal(f"RELEASE_INCONCLUSIVE: {where} preregistered a deterministic endpoint (sigma_d 0) but its "
                      f"paired differences vary (s_d {spread:.4g} {unit}); preregister sigma_d and recompute n")
    mechanism = evidence_classes and (
        (valid == 1 and sigma == 0) or
        MECHANISM_ARM.search("\n".join([prereg[name] for name in ("endpoint", "producer", "sigma_source")] + result))
        is not None)
    if mechanism:
        if EFFECT_CLAIM.search(decision) or any(SHIPPED_VERDICT.match(plain(line)) for line in result):
            raise Refusal(f"RELEASE_EVIDENCE_CLASS: {where} is MECHANISM, not FIELD EFFECT; SHIPPED/applied effect "
                          "claims require FIELD EFFECT; state MECHANISM VERIFIED")
    elif evidence_classes and MECHANISM_VERIFIED.match(decision):
        raise Refusal(f"RELEASE_EVIDENCE_CLASS: {where} has no deterministic single pair or fixture/mutant arm "
                      "for MECHANISM VERIFIED; document the FIELD EFFECT design and use applied, effect")
    # Bonferroni across the card's applied ideas (conservative; equals Holm's first step).
    level = alpha / applied_count
    half = t_quantile(1 - level / 2, valid - 1) * spread / math.sqrt(valid) if spread > 0 else 0.0
    low, high = mean - half, mean + half
    reading = (f"n={valid}, mean d {mean:.4g} {unit}, {100 * (1 - level):.4g}% CI {low:.4g}..{high:.4g} {unit}, "
               f"mde {mde:g} {unit}")
    if mechanism:
        reading = f"n={valid}, mean d {mean:.4g} {unit}, s_d {spread:.4g} {unit}, mde {mde:g} {unit}"
    if sigma == 0:
        shipped = mean >= mde  # deterministic: no sampling noise, so the full mde is owed
    else:
        shipped = low > 0 and mean >= mde / 2
    if shipped:
        if mechanism:
            return f"{idea} MECHANISM VERIFIED ({reading})"
        return f"{idea} SHIPPED ({reading})" + (" [FIELD EFFECT]" if evidence_classes else "")
    if high < 0:
        raise Refusal(f"RELEASE_REGRESSED: {where}: the CI lies wholly below 0 ({reading})")
    if low > -mde and high < mde:
        raise Refusal(f"RELEASE_NO_EFFECT: {where}: the CI lies within ±mde ({reading}); file it as no effect, not "
                      "applied")
    raise Refusal(f"RELEASE_INCONCLUSIVE: {where}: the CI straddles the SHIPPED and NO EFFECT bounds ({reading}); "
                  "carry it as next with n recomputed from the observed s_d")


def judge(card: str, text: str, prereg: bool = False, evidence_classes: bool = False) -> str:
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
    applied_ids: List[str] = []
    applied_decisions: List[str] = []
    decision = None
    if idea_lines is not None:
        header, ideas = first_table(idea_lines)
        decision = column(header, "Decision")
        if decision is not None:
            for row in ideas:
                wording = plain(row[decision]) if len(row) > decision else ""
                if (APPLIED.match(wording.lower()) or
                        (evidence_classes and (MECHANISM_VERIFIED.match(wording) or SHIPPED_VERDICT.match(wording)))) and (
                        prereg or MEASURED.search(wording[:DECISION_SCAN])):
                    name = plain(row[1] if len(row) > 1 else row[0])
                    applied.append(name[:80])
                    match = IDEA_ID.match(name)
                    applied_ids.append(match[0] if match else "")
                    applied_decisions.append(wording)
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
        raise incomplete(2, "no idea's Decision starts with applied" + (
            ", SHIPPED or MECHANISM VERIFIED" if evidence_classes else
            ("" if prereg else " and records a measured change X → Y")))
    verdicts = ""
    if prereg:
        found_blocks = blocks(idea_lines)
        verdicts = "; " + "; ".join(
            prereg_verdict(idea, found_blocks, len(applied_ids), evidence_classes, wording)
            for idea, wording in zip(applied_ids, applied_decisions))
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
            f"{'evidence' if evidence_classes else 'applied'}: {applied[0]}{verdicts}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Refuse a release with no complete two-lane release card.")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--rev", required=True)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    version = VERSION.fullmatch(args.version)
    if not version:
        print("release-card-check: --version must be X.Y.Z", file=sys.stderr)
        return 2
    card_version = tuple(int(part) for part in version.groups())
    prereg = card_version >= PREREG_FROM
    evidence_classes = card_version >= EVIDENCE_FROM
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
        print(judge(f"{card} at {sha}", out.decode("utf-8", errors="replace"), prereg, evidence_classes))
        return 0
    except Refusal as refusal:
        print(str(refusal))
        return 1


if __name__ == "__main__":
    sys.exit(main())
