#!/usr/bin/env python3
"""wallclock_check.py -- WALLCLOCK1 (ompkit-qf9fk): tests whose pass rides on elapsed wall time.

Tonight's release verdicts failed only under load (32 cores at load 20-36): a 2 s CASS spawn bound, a 3 s stub
probe, a 5 s rch probe, bun's 5 s default, a 10 s claim-graph budget and a 120 s file cap. Each was a fixed small
wall-clock bound around child processes. This checker flags those shapes in test files:

  small-deadline   deadline_s / timeout_s below 10 s          (kitlib run, python helpers)
  small-timeout-ms timeout / timeoutMs below 10000 ms          (Bun.spawn, spawnSync, bun test options)
  small-timeout-s  timeout= below 10 s                         (python subprocess / socket)
  elapsed-assert   an elapsed/duration/took value asserted with toBeLessThan

FIXTUREDEADLINE1 (ompkit-fp72.120.16.125) additionally refuses literal JS/TS
deadline_s/timeout_s/timeoutMs/timeout options and Bun case/lifecycle timeout
arguments at any size. Use fixtureDeadlineS(existing_floor), or runFixture
with floor_s. Existing occurrences are grandfathered by the same shrink-only
ratchet. A real product deadline needs an inline comment beginning
`product-deadline: <reason>` (at least two words and ten characters).
The JS subset uses the existing kitlib lexer; aliases, computed expressions,
tagged test factories and Python/shell fixture bounds are not covered by this
new rule. Those languages retain their existing small-bound checks.

The original small-bound and elapsed checks still require a complete
`wallclock: p99=<number>(ms|s) headroom=<number>x` annotation (positive p99,
headroom >=2x). That annotation alone never exempts a literal fixture bound.

  --base REV --head REV   judge test files changed between REV and REV; a finding is new when its (path, rule, line
                          text) occurs more often at head than at base, so untouched offenders never block. Exit 1
                          with each new finding named.
  --inventory [--rev REV] every finding in test files at REV (default HEAD), one JSON object per line. Exit 0.
"""
import argparse
import json
import os
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from kitlib_run import run  # noqa: E402
import kitlib_ratchet_core as core  # noqa: E402

SUFFIXES = (".ts", ".js", ".mjs", ".sh", ".py")
LOAD_SAFE_S = 10.0
MIN_HEADROOM = 2.0
ANNOTATION = re.compile(
    r"\bwallclock:[ \t]{0,4}p99=([0-9]{1,6}(?:[.][0-9]{1,3})?)(?:ms|s)[ \t]{1,4}headroom=([0-9]{1,4}(?:[.][0-9]{1,2})?)x\b")
DEADLINE = re.compile(r"\b(?:deadline_s|timeout_s)[ \t]*[:=][ \t]*([0-9]{1,6}(?:[.][0-9]{1,3})?)\b")
TIMEOUT_MS = re.compile(r"\btimeout(?:Ms)?[ \t]*:[ \t]*([0-9][0-9_]{0,9})\b")
TIMEOUT_S = re.compile(r"\btimeout[ \t]*=[ \t]*([0-9]{1,6}(?:[.][0-9]{1,3})?)\b")
ELAPSED = re.compile(r"\b(?:elapsed|duration|took)[A-Za-z_]{0,20}\b", re.I)
LESS_THAN = re.compile(r"[.]toBeLessThan(?:OrEqual)?[(]")
PRODUCT_DEADLINE = re.compile(r"^\s*product-deadline:\s*(\S.*)$")
LITERAL = r"[0-9][0-9_]*(?:\.[0-9_]+)?"
FIXTURE_BOUND = re.compile(
    rf"\b(?:deadline_s|timeout_s|timeoutMs|timeout)\s*[:=]\s*({LITERAL})(?![\w.])")
CASE_CALL = re.compile(r"\b(?:(?:test|it)(?:\.(?:only|skip|todo|concurrent|serial))?"
                       r"|beforeAll|afterAll|beforeEach|afterEach|setDefaultTimeout)\s*\(")


def fixture_bounds(text: str):
    """Lex JS first: documentation strings/comments are not executable deadlines.

    Recognise direct numeric options and final numeric arguments of Bun case/
    lifecycle calls, including multiline callbacks. Names aliased by the caller
    and computed numeric expressions are outside this literal-site ratchet.
    """
    if len(text) > core.MAX_FILE_BYTES:
        yield 1, "fixture-source-too-large", "test source exceeds the 4 MiB lexical budget"
        return
    code, _, _, comments = core.lex_js(text)
    where = core.js_locator(text)
    lines = text.splitlines()
    product = set()
    for offset, body in comments:
        match = PRODUCT_DEADLINE.match(body)
        if match and len(match.group(1)) >= 10 and len(match.group(1).split()) >= 2:
            product.add(where(offset)[0])
    offsets = set()
    case_openers = {match.end() - 1 for match in CASE_CALL.finditer(code)}
    for match in FIXTURE_BOUND.finditer(code):
        # Zero is also a real literal deadline (often disabling a timeout).
        offsets.add(match.start(1))
    stack = []
    for offset, char in enumerate(code):
        if char in "([{":
            stack.append([char, offset, [], char == "(" and offset in case_openers])
        elif char == "," and stack and stack[-1][0] == "(":
            stack[-1][2].append(offset)
        elif char in ")]}" and stack:
            opener, start, commas, case = stack.pop()
            if {"(": ")", "[": "]", "{": "}"}[opener] != char:
                continue
            if case:
                end = offset
                if commas and not code[commas[-1] + 1:end].strip():
                    end = commas.pop()
                arg_start = commas[-1] + 1 if commas else start + 1
                arg = code[arg_start:end]
                if re.fullmatch(rf"\s*{LITERAL}\s*", arg):
                    offsets.add(arg_start + len(arg) - len(arg.lstrip()))
    for offset in sorted(offsets):
        number, _ = where(offset)
        if number not in product:
            yield number, "literal-fixture-deadline", lines[number - 1].strip()


def annotated(line: str) -> bool:
    """True only for a complete annotation: a measured p99 above 0 and headroom of at least MIN_HEADROOM."""
    match = ANNOTATION.search(line)
    return match is not None and float(match.group(1)) > 0 and float(match.group(2)) >= MIN_HEADROOM


def findings(path: str, text: str):
    if not path.startswith("tests/") or not path.endswith(SUFFIXES):
        return
    if path.endswith((".ts", ".js", ".mjs")):
        yield from fixture_bounds(text)
    for number, line in enumerate(text.splitlines(), 1):
        if annotated(line):
            continue
        stripped = line.strip()
        for match in DEADLINE.finditer(line):
            if 0 < float(match.group(1)) < LOAD_SAFE_S:
                yield number, "small-deadline", stripped
        for match in TIMEOUT_MS.finditer(line):
            value = int(match.group(1).replace("_", "") or "0")
            if 0 < value < LOAD_SAFE_S * 1000:
                yield number, "small-timeout-ms", stripped
        for match in TIMEOUT_S.finditer(line):
            if 0 < float(match.group(1)) < LOAD_SAFE_S:
                yield number, "small-timeout-s", stripped
        if LESS_THAN.search(line) and ELAPSED.search(line):
            yield number, "elapsed-assert", stripped


def git(repo: str, *args: str) -> str:
    result = run(["git", "-C", repo, *args], deadline_s=60, max_output_bytes=64 * 1024 * 1024)
    if result.timed_out or result.truncated or result.rc != 0:
        raise SystemExit("wallclock-check: git %s failed (rc=%s)" % (" ".join(args[:2]), result.rc))
    return result.stdout.decode("utf-8", "replace")


def show(repo: str, rev: str, path: str) -> str:
    result = run(["git", "-C", repo, "show", "%s:%s" % (rev, path)], deadline_s=60, max_output_bytes=64 * 1024 * 1024)
    return result.stdout.decode("utf-8", "replace") if result.rc == 0 and not result.truncated else ""


def judge(repo: str, base: str, head: str) -> int:
    changed = [p for p in git(repo, "diff", "--name-only", "--diff-filter=AM", base, head).splitlines()
               if p.startswith("tests/") and p.endswith(SUFFIXES)]
    new = []
    for path in changed:
        before = Counter((rule, text) for _, rule, text in findings(path, show(repo, base, path)))
        for number, rule, text in findings(path, show(repo, head, path)):
            if before[(rule, text)] > 0:
                before[(rule, text)] -= 1
                continue
            new.append("%s:%d: %s: %s" % (path, number, rule, text[:200]))
    if not new:
        return 0
    print("wallclock-check: REFUSED: %d new timing finding(s). Fixture deadlines must use fixtureDeadlineS() "
          "(or runFixture floor_s); a literal real product deadline needs an inline "
          "`product-deadline: <reason>` comment. Elapsed assertions still require measured "
          "`wallclock: p99=<measured> headroom=<factor>` evidence:" % len(new),
          file=sys.stderr)
    for line in new:
        print(line, file=sys.stderr)
    return 1


def inventory(repo: str, rev: str) -> int:
    for path in git(repo, "ls-tree", "-r", "--name-only", rev, "--", "tests").splitlines():
        for number, rule, text in findings(path, show(repo, rev, path)):
            print(json.dumps({"path": path, "line": number, "rule": rule, "text": text[:200]}))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--repo", default=".")
    parser.add_argument("--base")
    parser.add_argument("--head")
    parser.add_argument("--inventory", action="store_true")
    parser.add_argument("--rev", default="HEAD")
    args = parser.parse_args()
    if args.inventory:
        return inventory(args.repo, args.rev)
    if not (args.base and args.head):
        parser.error("--base and --head are required unless --inventory")
    return judge(args.repo, args.base, args.head)


if __name__ == "__main__":
    sys.exit(main())
