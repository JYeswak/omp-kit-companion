#!/usr/bin/env python3
"""Check that every row of omp-kit-native's situation table names a runnable native verb and a measured misuse.

Failure mode it catches: a teaching row that cites a verb the kit does not ship (2026-10-19: an order
named `omp-kit scratch mine`, which does not exist), a flag the verb's --help does not print, a row
with no measured misuse, or a required situation missing from the table.

Per row of the `| Situation | Native verb | Replaces (measured) |` table in SKILL.md:
  - the first backticked command in column 2 resolves: `omp-kit <verb> [<sub>]` is in
    `omp-kit capabilities --json`; a `*.py` script exists at its path; OMP tools are in OMP_TOOLS;
  - every `--flag` in that command appears in the verb's --help (or usage) output;
  - column 3 cites a measured rate (`/seat-h`) or an observed count from the evidence table.
Required situations: REQUIRED below, matched case-insensitively against column 1.

Usage: check_rows.py [SKILL.md]     exit 0 all rows pass, 1 any row fails, 2 usage
       check_rows.py --selftest     planted negatives must fail, the clean fixture must pass
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
OMP_TOOLS = {"task"}  # OMP harness tools named in rows; not kit verbs
REQUIRED = ("waiting", "verif", "publish", "ci state", "scratch", "goal", "send", "doctor", "mission", "plan",
            "receipt", "missing native verb")
CMD_RE = re.compile(r"`([^`]+)`")
FLAG_RE = re.compile(r"(?<![\w-])(--[a-z][\w-]*)")
MEASURED_RE = re.compile(r"(\d+(?:\.\d+)?/seat-h|\b\d+ observed\b|\b0 observed\b)")


def table_rows(text):
    rows, inside = [], False
    for line in text.splitlines():
        if line.startswith("| Situation | Native verb | Replaces (measured) |"):
            inside = True
            continue
        if inside:
            if not line.startswith("|"):
                break
            if set(line.replace("|", "").strip()) <= {"-", " "}:
                continue
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            rows.append(dict(zip(("sit", "verb", "misuse"), cells)) if len(cells) == 3
                        else {"sit": line, "verb": "", "misuse": ""})
    return rows


def run_help(argv):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=60)
        return p.stdout + p.stderr
    except Exception as ex:
        return f"ERROR {ex}"


def kit_inventory():
    out = run_help(["omp-kit", "capabilities", "--json"])
    try:
        cmds = json.loads(out)["data"]["commands"]
    except Exception:
        return None
    return {c["name"]: {s.get("name") or s.get("argument") for s in c.get("subcommands") or []} for c in cmds}


def resolve(cmd, inv, helper=run_help):
    """-> (ok, reason). Checks the verb exists and every --flag is in its help."""
    words = cmd.split()
    if not words:
        return False, "empty command"
    if words[0] in OMP_TOOLS:
        return True, "omp tool"
    if words[0] == "omp-kit":
        if inv is None:
            return False, "omp-kit capabilities unavailable"
        if len(words) < 2 or words[1] not in inv:
            return False, f"omp-kit verb {words[1:2]} not in capabilities"
        argv = ["omp-kit", words[1]]
        if inv[words[1]]:
            if len(words) < 3 or words[2] not in inv[words[1]]:
                return False, f"omp-kit {words[1]} subcommand {words[2:3]} not in capabilities"
            argv.append(words[2])
        help_text = helper(argv + ["--help"])
    else:
        script = next((w for w in words if w.endswith(".py")), None)
        if not script:
            return False, "not an omp-kit verb, kit script or OMP tool"
        path = os.path.expanduser(script)
        if not os.path.isfile(path):
            return False, f"script {script} not found"
        after = words[words.index(script) + 1:words.index(script) + 2]
        sub = after if after and re.fullmatch(r"[a-z][\w-]*", after[0]) else []
        help_text = helper(["python3", path, *sub, "--help"])
    missing = [f for f in FLAG_RE.findall(cmd) if f not in help_text]
    return (not missing, f"flags not in --help: {missing}" if missing else "ok")


def check(text, inv, helper=run_help):
    errors = []
    rows = table_rows(text)
    if not rows:
        return ["no situation table"]
    for r in rows:
        cmds = CMD_RE.findall(r["verb"])
        if not cmds:
            errors.append(f"{r['sit']!r}: no backticked native verb")
            continue
        ok, why = resolve(cmds[0], inv, helper)
        if not ok:
            errors.append(f"{r['sit']!r}: {why}")
        if not MEASURED_RE.search(r["misuse"]):
            errors.append(f"{r['sit']!r}: no measured misuse (/seat-h or N observed)")
    sits = " ".join(r["sit"].lower() for r in rows)
    errors += [f"required situation missing: {k}" for k in REQUIRED if k not in sits]
    return errors


def selftest():
    inv = {"ci": {"status"}, "scratch": {"plan", "release"}, "send": set()}

    def helper(argv):
        return "--json --max --repo --push --agent --bin"

    head = "| Situation | Native verb | Replaces (measured) |\n|---|---|---|\n"
    tail = "".join(f"| {k} x | `omp-kit send s p m` | 1.0/seat-h |\n" for k in REQUIRED)
    clean = head + "| CI x | `omp-kit ci status --json` | gh polling 0.93/seat-h |\n" + tail
    cases = [
        ("clean fixture passes", clean, True),
        ("nonexistent subcommand fails", head + "| scratch x | `omp-kit scratch mine` | 1/seat-h |\n" + tail, False),
        ("unknown verb fails", head + "| x | `omp-kit bogus` | 1/seat-h |\n" + tail, False),
        ("flag absent from --help fails", head + "| x | `omp-kit ci status --forever` | 1/seat-h |\n" + tail, False),
        ("row without measured misuse fails", head + "| x | `omp-kit ci status` | gh polling |\n" + tail, False),
        ("missing required situation fails", head + tail.replace("| receipt x |", "| other x |"), False),
        ("missing script fails", head + "| x | `python3 ~/nonexistent/idle.py --max 600` | 1/seat-h |\n" + tail, False),
    ]
    ok = True
    for name, text, want in cases:
        got = not check(text, inv, helper)
        ok &= got == want
        print(("PASS " if got == want else "FAIL ") + name)
    return 0 if ok else 1


def main(argv):
    if argv[:1] == ["--selftest"]:
        return selftest()
    if len(argv) > 1 or (argv and argv[0].startswith("-")):
        print(__doc__.split("Usage:")[1], file=sys.stderr)
        return 2
    path = pathlib.Path(argv[0]) if argv else HERE.parent / "SKILL.md"
    if not path.is_file():
        print(f"FAIL {path} missing")
        return 1
    errors = check(path.read_text(), kit_inventory())
    for e in errors:
        print("FAIL " + e)
    print("OK" if not errors else f"{len(errors)} failing")
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
