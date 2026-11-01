#!/usr/bin/env python3
"""wallclock_check.py -- WALLCLOCK1 (ompkit-qf9fk): tests whose pass rides on elapsed wall time.

Tonight's release verdicts failed only under load (32 cores at load 20-36): a 2 s CASS spawn bound, a 3 s stub
probe, a 5 s rch probe, bun's 5 s default, a 10 s claim-graph budget and a 120 s file cap. Each was a fixed small
wall-clock bound around child processes. This checker flags those shapes in test files:

  small-deadline   deadline_s / timeout_s below 10 s          (kitlib run, python helpers)
  small-timeout-ms timeout / timeoutMs below 10000 ms          (Bun.spawn, spawnSync, bun test options)
  small-timeout-s  timeout= below 10 s                         (python subprocess / socket)
  elapsed-assert   an elapsed/duration/took value asserted with toBeLessThan

A line carrying `wallclock: p99=<measured> headroom=<factor>` is annotated and never flagged.

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

SUFFIXES = (".ts", ".js", ".mjs", ".sh", ".py")
LOAD_SAFE_S = 10.0
ANNOTATION = "wallclock: p99="
DEADLINE = re.compile(r"\b(?:deadline_s|timeout_s)[ \t]*[:=][ \t]*([0-9]{1,6}(?:[.][0-9]{1,3})?)\b")
TIMEOUT_MS = re.compile(r"\btimeout(?:Ms)?[ \t]*:[ \t]*([0-9][0-9_]{0,9})\b")
TIMEOUT_S = re.compile(r"\btimeout[ \t]*=[ \t]*([0-9]{1,6}(?:[.][0-9]{1,3})?)\b")
ELAPSED = re.compile(r"\b(?:elapsed|duration|took)[A-Za-z_]{0,20}\b", re.I)
LESS_THAN = re.compile(r"[.]toBeLessThan(?:OrEqual)?[(]")


def findings(path: str, text: str):
    if not path.startswith("tests/") or not path.endswith(SUFFIXES):
        return
    for number, line in enumerate(text.splitlines(), 1):
        if ANNOTATION in line or len(line) > 4000:
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
    print("wallclock-check: REFUSED: %d new test line(s) pass only within a small fixed wall-clock bound; under "
          "fleet load they fail without a code change. Judge the mechanism, give the child a load-safe bound "
          "(>= %d s), or annotate the line with `wallclock: p99=<measured> headroom=<factor>`:" % (len(new), LOAD_SAFE_S),
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
