#!/usr/bin/env python3
"""kitlib_ratchet: refuse new hand-rolled copies of kitlib primitives (KITLIB-RATCHET).

ompkit-qwqh1 (J-2026-10-22-07/09, plan item KL28): everything builds on
kitlib, and a mechanism kitlib settles must not be hand-rolled again. One
ratchet covers every kitlib primitive; each primitive is one rule. The
engine (selection, pragmas, git ratchet, CLI) is scripts/kitlib_ratchet_core.py,
shared with scripts/tempsafe_check.py.

Judged files: .py .ts .tsx .js .mjs .cjs .sh .bash, and extensionless files
whose shebang names sh, bash, dash or python. One finding per rule and line,
naming every construct found on it.

Rule ``raw-spawn``: a process spawned outside kitlib has no deadline, no
process-group cancel and no output cap unless the call site rebuilds them.
Spawn through ``kitlib_run.run`` (scripts/kitlib_run.py) or ``run()``
(src/kitlib/run.ts).

  Python  calls resolving (import aliases followed) to subprocess.run, call,
          check_call, check_output, Popen, getoutput, getstatusoutput;
          os.system, os.popen, os.spawn*, os.posix_spawn*, os.exec*; and
          asyncio(.subprocess).create_subprocess_*.
  TS/JS   Bun.spawn / Bun.spawnSync references, and spawn, spawnSync, exec,
          execSync, execFile, execFileSync and fork from "child_process" or
          "node:child_process": named imports (aliases followed) called by
          their local name, namespace or default imports (import * as cp,
          import cp, const cp = require(...), await import(...)) used as
          cp.<function>, destructured require/import bindings, and
          require("child_process").<function> chains. Comments and string
          bodies are blanked first (the lexer tempsafe uses).
  Shell   a call-site ``timeout`` / ``gtimeout`` (bare or by absolute path) in
          command position followed by its options, a duration (digits with an
          optional s/m/h/d suffix, or a $ expansion) and a command; inside an
          unquoted-delimiter heredoc body only $(timeout / `timeout count.

Also: ``suppression-no-reason``, ``suppression-unused``, ``parse-error`` and
``too-large``, as in every kitlib ratchet. Suppression: a comment (``#`` or
``//`` or ``/*``) whose text starts ``kitlib: <reason>`` on the flagged line,
with a reason of two or more words and 10+ characters.

Limits (declared, not hidden): Python follows import aliases only, with no
data flow: a bare reference such as ``r = subprocess.run`` is not judged, nor
is the later ``r(...)``. TS/JS bindings are matched textually per line: a binding
re-exported, passed through another module, or a namespace whose member
access spans lines is not seen; a local method named like an imported
child_process function in the same file is taken for a call; Bun.$ shell
templates, execa and zx are not judged; ``const { spawn } = Bun`` is not seen.
Shell: an env-assignment prefix (``VAR=x timeout 5 cmd``) is not command
position, and embedded programs (python3 -c, heredoc scripts) are not judged
as their language.

Exempt (kitlib itself, the process primitive it wraps, and this ratchet with
its tests and fixtures): see EXEMPT.

Modes:
  kitlib_ratchet.py PATH...                  judge files/dirs, every finding
  kitlib_ratchet.py --tree LABEL PATH ...    same, grouped under LABEL
  kitlib_ratchet.py --staged [--repo DIR]    pre-commit ratchet: staged files
                                             against HEAD (GIT_INDEX_FILE honoured)
  kitlib_ratchet.py --head REV [--base REV]  range ratchet (pre-push, CI)
Ratchet: a finding is new when its (rule, line text without comments)
fingerprint occurs more often in the new blob than in the old one (a rename
keeps the old blob as baseline); only the surplus is reported, as the last
occurrences. Untouched pre-existing sites do not block, new ones always do.
--format text|json. Exit 0 clean, 1 findings, 2 usage/infrastructure.
"""
from __future__ import annotations

import ast
import os
import re
import sys
from typing import Callable, Dict, List, Optional, Set, Tuple

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import kitlib_ratchet_core as core  # noqa: E402  (imports only pysafe, never pysafe_check)

PRAGMA = "kitlib"
RAW_SPAWN = "raw-spawn"

RULES = {
    RAW_SPAWN: "process spawned outside kitlib (no deadline, no process-group cancel, no output cap)",
    **core.meta_rules(PRAGMA),
}
# (rule, language) -> the kitlib replacement a finding names.
HINT = {
    (RAW_SPAWN, "py"): "use kitlib_run.run(argv, deadline_s=...) from scripts/kitlib_run.py",
    (RAW_SPAWN, "ts"): "use run(argv, { deadline_s }) from src/kitlib/run.ts",
    (RAW_SPAWN, "sh"): "bound the command with python3 -B scripts/pysafe.py run --timeout N -- CMD "
                       "(the process primitive kitlib_run wraps), never a call-site timeout",
}
# Kitlib's own implementations, pysafe.py (the process primitive kitlib_run
# wraps), and this ratchet with its tests and fixtures. An entry ending in "/"
# exempts a directory; a "*" in the last segment is a glob within its directory.
EXEMPT = (
    "src/kitlib/",
    "scripts/kitlib_*.py",
    "scripts/kitlib-tmp.sh",
    "scripts/pysafe.py",
    "tests/scripts/kitlib_ratchet_test.py",
    "tests/cli/check-staged-kitlib.test.sh",
    "tests/fixtures/kitlib-ratchet/",
)

# --- raw-spawn -----------------------------------------------------------
PY_SPAWN = {"subprocess." + name for name in ("run", "call", "check_call", "check_output", "Popen",
                                              "getoutput", "getstatusoutput")} | {"os.system", "os.popen"}
PY_SPAWN_PREFIXES = ("os.spawn", "os.posix_spawn", "os.exec")
PY_ASYNC_PREFIXES = ("asyncio.create_subprocess_", "asyncio.subprocess.create_subprocess_")
CP_MODULES = {"child_process", "node:child_process"}
CP_FUNCS = ("spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork")
JS_BUN_SPAWN_RE = re.compile(r"\bBun[ \t]*\.[ \t]*(spawn(?:Sync)?)(?![A-Za-z0-9_$])")
JS_KEYWORD_RE = re.compile(r"(?<![A-Za-z0-9_$.])(import|export)(?![A-Za-z0-9_$])")
JS_IDENT_RE = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
JS_TRAILING_IDENT_RE = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*\Z")
JS_REQUIRE_MEMBER_RE = re.compile(r"[ \t]*\)[ \t]*\.[ \t]*([A-Za-z_$][A-Za-z0-9_$]*)")
SH_TIMEOUT_RE = re.compile(r"\bg?timeout(?![A-Za-z0-9_.=-])")
SH_DURATION_RE = re.compile(r"[0-9]+(?:\.[0-9]+)?[smhd]?")
SH_TIMEOUT_ARG_OPTIONS = {"-s", "-k", "--signal", "--kill-after"}


def _py_spawn(name: Optional[str]) -> bool:
    if name is None:
        return False
    if name in PY_SPAWN:
        return True
    if name.startswith(PY_SPAWN_PREFIXES) and name.count(".") == 1:
        return True
    return name.startswith(PY_ASYNC_PREFIXES)


def _py_raw_spawn(parsed: core.PySource, hits: core.Hits) -> None:
    for node in ast.walk(parsed.tree):
        if isinstance(node, ast.Call):
            name = core.resolve(node.func, parsed.aliases)
            if _py_spawn(name):
                hits.add(RAW_SPAWN, node.lineno, node.col_offset + 1, str(name))


class JsSource:
    """One lexed TS/JS file, shared by every TS/JS rule."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.code, self.bare, self.strings, self.comments = core.lex_js(text)
        self.where = core.js_locator(text)
        self.code_lines = self.code.split("\n")


def _js_specifiers(inner: str, separator: str, funcs: Dict[str, str], namespaces: Set[str]) -> None:
    """Bindings from ``{ a, b as c, type d }`` (separator "as") or ``{ a, b: c, d = x }`` (":")."""
    for part in inner.split(","):
        spec = part.split("=", 1)[0].strip()
        if not spec or spec.startswith("type ") or spec.startswith("..."):
            continue
        if separator == "as":
            words = spec.split()
            name, alias = (words[0], words[2]) if len(words) == 3 and words[1] == "as" else (words[0], words[0])
        else:
            name, _, alias = spec.partition(":")
            name, alias = name.strip(), (alias.strip() or name.strip())
        if not JS_IDENT_RE.fullmatch(alias):
            continue
        if name in CP_FUNCS:
            funcs[alias] = name
        elif name == "default":
            namespaces.add(alias)


def _js_import_clause(clause: str, funcs: Dict[str, str], namespaces: Set[str]) -> None:
    clause = clause.strip()
    if clause.startswith("type ") or clause.startswith("type{"):
        return
    head, brace, rest = clause.partition("{")
    if brace:
        _js_specifiers(rest.split("}", 1)[0], "as", funcs, namespaces)
    head = head.strip().rstrip(",").strip()
    if head.startswith("*"):
        words = head[1:].split()
        if len(words) == 2 and words[0] == "as" and JS_IDENT_RE.fullmatch(words[1]):
            namespaces.add(words[1])
    elif JS_IDENT_RE.fullmatch(head):
        namespaces.add(head)


def _js_cp_bindings(js: JsSource, hits: core.Hits) -> Tuple[Dict[str, str], Set[str]]:
    """Local names bound to child_process: (alias -> function, namespace names).
    A ``require("child_process").fn`` chain is a hit on its own."""
    funcs: Dict[str, str] = {}
    namespaces: Set[str] = set()
    code = js.code
    for offset, literal, end, _ in js.strings:
        if literal not in CP_MODULES or code[offset:offset + 1] not in ("'", '"'):
            continue
        before = code[max(0, offset - 4096):offset].rstrip()
        if before.endswith("from") and (len(before) == 4 or not (before[-5].isalnum() or before[-5] in "_$")):
            keywords = list(JS_KEYWORD_RE.finditer(before))
            if keywords and keywords[-1].group(1) == "import":
                _js_import_clause(before[keywords[-1].end():-4], funcs, namespaces)
            continue
        if not before.endswith("("):
            continue
        callee = JS_TRAILING_IDENT_RE.search(before[:-1].rstrip())
        if callee is None or callee.group() not in ("require", "import"):
            continue
        chain = JS_REQUIRE_MEMBER_RE.match(code, end + 1)
        if chain and chain.group(1) in CP_FUNCS:
            line, col = js.where(chain.start(1))
            hits.add(RAW_SPAWN, line, col, "child_process." + chain.group(1))
        lhs = before[:-1].rstrip()[:callee.start()].rstrip()
        if lhs.endswith("await"):
            lhs = lhs[:-5].rstrip()
        if not lhs.endswith("=") or lhs.endswith(("==", "!=", "<=", ">=", "=>")):
            continue
        lhs = lhs[:-1].rstrip()
        if lhs.endswith("}"):
            opening = lhs.rfind("{")
            if opening >= 0:
                _js_specifiers(lhs[opening + 1:-1], ":", funcs, namespaces)
        else:
            name = JS_TRAILING_IDENT_RE.search(lhs)
            if name:
                namespaces.add(name.group())
    return funcs, namespaces


def _js_raw_spawn(js: JsSource, hits: core.Hits) -> None:
    for number, line in enumerate(js.code_lines, 1):
        for match in JS_BUN_SPAWN_RE.finditer(line):
            hits.add(RAW_SPAWN, number, match.start() + 1, "Bun." + match.group(1))
    if not any(literal in CP_MODULES for _, literal, _, _ in js.strings):
        return
    funcs, namespaces = _js_cp_bindings(js, hits)
    patterns: List[Tuple["re.Pattern[str]", Callable[["re.Match[str]"], str]]] = []
    if funcs:
        names = "|".join(re.escape(alias) for alias in sorted(funcs, key=len, reverse=True))
        patterns.append((re.compile(r"(?<![A-Za-z0-9_$.])(" + names + r")[ \t]*\("),
                         lambda m: "child_process." + funcs[m.group(1)]))
    if namespaces:
        names = "|".join(re.escape(name) for name in sorted(namespaces, key=len, reverse=True))
        patterns.append((re.compile(r"(?<![A-Za-z0-9_$.])(?:" + names + r")[ \t]*\.[ \t]*("
                                    + "|".join(CP_FUNCS) + r")(?![A-Za-z0-9_$])"),
                         lambda m: "child_process." + m.group(1)))
    for number, line in enumerate(js.code_lines, 1):
        for pattern, construct in patterns:
            for match in pattern.finditer(line):
                if line[:match.start()].rstrip().endswith("function"):
                    continue
                hits.add(RAW_SPAWN, number, match.start() + 1, construct(match))


def _sh_timeout_call(code: str, end: int) -> bool:
    """``timeout [options] DURATION COMMAND`` after the word ending at ``end``."""
    if code[end:end + 1] not in (" ", "\t"):
        return False
    words = code[end:].split()
    index = 0
    while index < len(words) and words[index].startswith("-"):
        word = words[index]
        index += 1
        if word == "--":
            break
        if word in SH_TIMEOUT_ARG_OPTIONS:
            index += 1
    if index + 1 >= len(words):
        return False
    duration = words[index].strip("\"'")
    if not (duration.startswith("$") or SH_DURATION_RE.fullmatch(duration)):
        return False
    return words[index + 1][0] not in ";|&)"


def _sh_raw_spawn_code(code: str, number: int, hits: core.Hits) -> None:
    for start, end in core.sh_command_words(code, SH_TIMEOUT_RE):
        if core.sh_command_position(code, start) and _sh_timeout_call(code, end):
            hits.add(RAW_SPAWN, number, start + 1, "timeout N")


def _sh_raw_spawn_heredoc(line: str, number: int, hits: core.Hits) -> None:
    for start, end in core.sh_command_words(line, SH_TIMEOUT_RE):
        if line[:start].endswith(("$(", "`")) and _sh_timeout_call(line, end):
            hits.add(RAW_SPAWN, number, start + 1, "timeout N")


# --- rule registry: add a primitive's rule by appending its functions ----
PY_RULES: List[Callable[[core.PySource, core.Hits], None]] = [_py_raw_spawn]
JS_RULES: List[Callable[[JsSource, core.Hits], None]] = [_js_raw_spawn]
SH_CODE_RULES: List[core.ShCodeFn] = [_sh_raw_spawn_code]
SH_HEREDOC_RULES: List[core.ShCodeFn] = [_sh_raw_spawn_heredoc]


def _scan_py(source: bytes, path: str) -> core.Scan:
    parsed = core.py_source(source, path)
    hits = core.Hits()
    for rule in PY_RULES:
        rule(parsed, hits)
    return core.Scan(hits, parsed.texts(hits.lines()), parsed.pragmas)


def _scan_ts(source: bytes, path: str) -> core.Scan:
    js = JsSource(source.decode("utf-8", "replace"))
    hits = core.Hits()
    for rule in JS_RULES:
        rule(js, hits)
    return core.js_scan(js.text, hits, js.bare, js.comments, js.where)


def _sh_code(code: str, number: int, hits: core.Hits) -> None:
    for rule in SH_CODE_RULES:
        rule(code, number, hits)


def _sh_heredoc(line: str, number: int, hits: core.Hits) -> None:
    for rule in SH_HEREDOC_RULES:
        rule(line, number, hits)


def _scan_sh(source: bytes, path: str) -> core.Scan:
    return core.scan_sh(source.decode("utf-8", "replace"), _sh_code, _sh_heredoc)


def _detail(rule: str, lang: str, constructs: List[str]) -> str:
    return f"{RULES[rule].split(' (', 1)[0]} ({', '.join(constructs)}); {HINT[(rule, lang)]}"


RULESET = core.RuleSet(
    prog="kitlib_ratchet",
    description=__doc__.split("\n\n")[0],
    pragma=PRAGMA,
    rules=RULES,
    exempt=EXEMPT,
    scanners={"py": _scan_py, "ts": _scan_ts, "sh": _scan_sh},
    detail=_detail,
)
MAX_FILE_BYTES = core.MAX_FILE_BYTES
language = core.language
is_exempt = RULESET.is_exempt
check_source = RULESET.check_source
check_file = RULESET.check_file
ratchet = RULESET.ratchet
main = RULESET.main


if __name__ == "__main__":
    core.pysafe.run_main(main)
