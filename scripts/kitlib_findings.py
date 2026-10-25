"""kitlib_findings: the FINDING line grammar for Python hook members and the parser the runner and
`omp-kit preflight` share (GATEDIAG1, ompkit-fp72.135.3.16; plan section 23.3).

A member prints every finding it can see, then exits 0; a non-zero exit means it could not judge.
Line: FINDING<TAB>gate<TAB>code<TAB>detail<TAB>remedy<TAB>fix  (fix is "-" when there is no ready argv).
"""
from __future__ import annotations

import json
import sys
from typing import Iterable, List, Optional

PREFIX = "FINDING"


def _clean(value: object) -> str:
    return str(value).replace("\t", " ").replace("\r", " ").replace("\n", " ")


def finding(gate: str, code: str, detail: str, remedy: str, fix: Optional[List[str]] = None, blocking: bool = True) -> dict:
    return {"gate": _clean(gate), "code": _clean(code), "detail": _clean(detail), "remedy": _clean(remedy),
            "fix": [str(f) for f in fix] if fix else None, "blocking": bool(blocking)}


def format_line(f: dict) -> str:
    fix = " ".join(f["fix"]) if f.get("fix") else "-"
    return "\t".join([PREFIX, f["gate"], f["code"], f["detail"], f["remedy"], _clean(fix)])


def print_findings(findings: Iterable[dict], out=sys.stdout) -> int:
    n = 0
    for f in findings:
        out.write(format_line(f) + "\n")
        n += 1
    out.flush()
    return n


def parse_lines(text: str, blocking: bool = True) -> List[dict]:
    """Every well-formed FINDING line; other lines are ignored (members print nothing else on stdout)."""
    out: List[dict] = []
    for line in text.splitlines():
        if not line.startswith(PREFIX + "\t"):
            continue
        parts = line.split("\t")
        if len(parts) < 6:
            continue
        fix = parts[5].strip()
        out.append({"gate": parts[1], "code": parts[2], "detail": parts[3], "remedy": parts[4],
                    "fix": None if fix in ("", "-") else fix.split(" "), "blocking": blocking})
    return out


def envelope(act: str, target: Optional[str], snapshot: str, findings: List[dict]) -> dict:
    return {"ok": not any(f.get("blocking", True) for f in findings), "act": act, "target": target,
            "snapshot": snapshot, "findings": findings}


def render(env: dict, as_json: bool = False) -> str:
    if as_json:
        return json.dumps(env, sort_keys=True)
    if env["ok"]:
        return f"{env['act']}: ok ({env['snapshot']})"
    lines = [f"{env['act']} REFUSED: {len(env['findings'])} finding(s); fix every one, then retry once ({env['snapshot']}):"]
    for f in env["findings"]:
        lines.append(f"  {f['gate']} {f['code']}: {f['detail']}")
        lines.append(f"    remedy: {f['remedy']}")
        if f.get("fix"):
            lines.append(f"    fix: {' '.join(f['fix'])}")
    return "\n".join(lines)


def selftest() -> int:
    fails = []

    def check(name, cond):
        print(("ok   " if cond else "FAIL ") + name)
        if not cond:
            fails.append(name)

    f = finding("stale-worktree", "STALE_WORKTREE", "reverts\tabc (x)\n", "declare", ["git", "commit", "--amend"])
    line = format_line(f)
    check("tabs and newlines inside fields become spaces", "\t" not in f["detail"] and line.count("\t") == 5)
    parsed = parse_lines("noise\n" + line + "\nFINDING\tg\tc\td\tr\t-\n" + "FINDING\tshort\n")
    check("parse: well-formed lines only, fix split or None", len(parsed) == 2 and parsed[0]["fix"] == ["git", "commit", "--amend"] and parsed[1]["fix"] is None)
    env = envelope("commit", "main", "tree:abc", parsed)
    check("envelope not ok while a blocking finding exists", env["ok"] is False and "REFUSED: 2 finding(s)" in render(env))
    check("planted: an empty findings list is ok and renders one line", envelope("commit", None, "tree:x", [])["ok"] is True and render(envelope("commit", None, "tree:x", [])) == "commit: ok (tree:x)")
    print(f"kitlib_findings selftest: {'PASS' if not fails else 'FAIL'} ({len(fails)} failures)")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else 2)
