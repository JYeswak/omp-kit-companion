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


PIDGUARD1 additionally refuses destructive process.kill / os.kill / os.killpg
and shell kill targets unless they are literal integers with magnitude > 1
or inline safePid / kitlib_proc.safe_pid calls. Shell callers use kitlib_signal.
Signal 0 probes are excluded. Existing sites are fingerprint-grandfathered
and counted in scripts/kitlib-ratchet-signal-baseline.json, leaving the installed
schema-1 raw-spawn inventory unchanged. First introduction seeds only from
immutable base source. Regenerate this inventory with --write-baseline
--signal-baseline. This is lexical/AST sink
checking, not whole-program data-flow or authority/incarnation validation.
Also: ``suppression-no-reason``, ``suppression-unused``, ``parse-error`` and
``too-large``, as in every kitlib ratchet. Pragma: a comment (``#`` or
``//`` or ``/*``) whose text starts ``kitlib: <reason>`` on the flagged line,
with a reason of two or more words and 10+ characters. In a repo with the
committed allowlist (scripts/kitlib-ratchet-baseline.json) a pragma only
documents a site the allowlist already counts: it never admits a new one,
so pre-commit and pre-push refuse the same new site whether pragma'd or not.
In a repo without one, the git ratchet alone judges and a pragma suppresses.

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
  kitlib_ratchet.py --write-baseline [--repo DIR] [--output PATH|-]
                                             write the allowlist from the tracked tree
  kitlib_ratchet.py --check-baseline [--repo DIR]
                                             tracked tree within the committed allowlist
  kitlib_ratchet.py --verify-reversal-message MSGFILE [--repo DIR]
                                             commit-msg gate: exact named-X
                                             reversal and per-path verdicts
Ratchet: a finding is new when its (rule, line text without comments)
fingerprint occurs more often in the new blob than in the old one (a rename
keeps the old blob as baseline); only the surplus is reported, as the last
occurrences. Untouched pre-existing sites do not block, new ones always do.
Allowlist (scripts/kitlib-ratchet-baseline.json, schema 1: per site rule,
path -> count, plus totals): on top of the git ratchet, a judged changed path
with more sites of a rule (pragma'd ones counted) than allowlisted reports the
surplus; an allowlist that raises a count or adds an entry against the base
side is ``allowlist-raised`` (a rename may carry its old path's count);
lowering or removing entries passes, and a lowered path is re-judged so the
count must really have fallen. A base side with no allowlist seeds it; once
the base side has one, deleting it is ``allowlist-deleted`` (the zero state
is empty counts, which --write-baseline writes when no site remains).
--format text|json. Exit 0 clean, 1 findings, 2 usage/infrastructure.
"""
from __future__ import annotations

import argparse
import ast
import json
import os
import re
import shlex
import sys
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Sequence, Set, Tuple

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import kitlib_ratchet_core as core  # noqa: E402  (imports only pysafe, never pysafe_check)

PRAGMA = "kitlib"
RAW_SPAWN = "raw-spawn"
UNSAFE_SIGNAL = "unsafe-signal-pid"
ALLOWLIST_RAISED = "allowlist-raised"
ALLOWLIST_INVALID = "allowlist-invalid"
ALLOWLIST_DELETED = "allowlist-deleted"
# The committed per-repo allowlist: site counts per rule per path.
BASELINE = "scripts/kitlib-ratchet-baseline.json"
SIGNAL_BASELINE = "scripts/kitlib-ratchet-signal-baseline.json"
BASELINE_SCHEMA = 1
ORIGIN_QUERY_TIMEOUT_S = 10.0


RULES = {
    RAW_SPAWN: "process spawned outside kitlib (no deadline, no process-group cancel, no output cap)",
    UNSAFE_SIGNAL: "destructive signal target is not a literal pid > 1 or an inline kitlib pid guard",
    ALLOWLIST_RAISED: "committed kitlib allowlist raises a count or adds an entry; the allowlist only shrinks",
    ALLOWLIST_INVALID: f"invalid kitlib allowlist (schema {BASELINE_SCHEMA}, positive counts)",
    ALLOWLIST_DELETED: "committed kitlib allowlist is deleted; once committed it stays, shrinking to empty counts",
    **core.meta_rules(PRAGMA),
}
# The rules whose sites the allowlist counts (one site per rule and line).
SITE_RULES = (RAW_SPAWN, UNSAFE_SIGNAL)
# (rule, language) -> the kitlib replacement a finding names.
HINT = {
    (RAW_SPAWN, "py"): "use kitlib_run.run(argv, deadline_s=...) from scripts/kitlib_run.py",
    (RAW_SPAWN, "ts"): "use run(argv, { deadline_s }) from src/kitlib/run.ts",
    (RAW_SPAWN, "sh"): "bound the command with python3 -B scripts/pysafe.py run --timeout N -- CMD "
                       "(the process primitive kitlib_run wraps), never a call-site timeout",
    (UNSAFE_SIGNAL, "py"): "use os.kill(safe_pid(value), signal) from scripts/kitlib_proc.py",
    (UNSAFE_SIGNAL, "ts"): "use process.kill(safePid(value), signal) from src/kitlib/proc.ts",
    (UNSAFE_SIGNAL, "sh"): "use kitlib_signal SIGNAL PID [group] from scripts/kitlib-proc.sh",
}
# Kitlib's own implementations, pysafe.py (the process primitive kitlib_run
# wraps), and this ratchet with its tests and fixtures. An entry ending in "/"
# exempts a directory; a "*" in the last segment is a glob within its directory.
EXEMPT = (
    "src/kitlib/",
    "scripts/kitlib_*.py",
    "scripts/kitlib-tmp.sh",
    "scripts/kitlib-proc.sh",
    "scripts/pysafe.py",
    "tests/scripts/kitlib_ratchet_test.py",
    "tests/cli/check-staged-kitlib.test.sh",
    "tests/cli/check-staged-kitlib-reversal.test.sh",
    "tests/cli/check-staged-kitlib-replay.test.sh",
    "tests/cli/check-staged-kitlib.lib.sh",
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


# --- PIDGUARD1: inline validation, not speculative variable/data-flow inference.
# Python uses its AST/import aliases; JS uses the shared comment/string lexer
# and balanced argument spans. Shell uses the shared command-position lexer
# then shlex words. Aliased JS sinks and embedded interpreter programs remain
# outside this lexical ratchet, as they do for raw-spawn.
def _literal_pid(value: str) -> bool:
    value = value.strip()
    if value.startswith("-"):
        value = value[1:]
    return 0 < len(value) <= 10 and value.isascii() and value.isdecimal() and 1 < int(value) <= 2147483647


def _py_safe_target(node: ast.AST, aliases: Dict[str, str]) -> bool:
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        node = node.operand
    if isinstance(node, ast.Constant):
        return type(node.value) is int and 1 < node.value <= 2147483647
    return (isinstance(node, ast.Call) and
            core.resolve(node.func, aliases) == "kitlib_proc.safe_pid" and len(node.args) == 1)


def _py_signal(parsed: core.PySource, hits: core.Hits) -> None:
    for node in ast.walk(parsed.tree):
        if not isinstance(node, ast.Call) or core.resolve(node.func, parsed.aliases) not in ("os.kill", "os.killpg"):
            continue
        if len(node.args) >= 2 and isinstance(node.args[1], ast.Constant) and type(node.args[1].value) is int and node.args[1].value == 0:
            continue
        if not node.args or not _py_safe_target(node.args[0], parsed.aliases):
            hits.add(UNSAFE_SIGNAL, node.lineno, node.col_offset + 1, "os.kill/killpg")


def _js_arguments(code: str, start: int) -> Optional[List[Tuple[int, int]]]:
    """Top-level argument slices, using the already lexed JS representation."""
    stack = []
    begin = start + 1
    args = []
    for offset in range(begin, len(code)):
        char = code[offset]
        if char in "([{":
            stack.append(char)
        elif char in ")]}":
            if not stack:
                if char == ")":
                    args.append((begin, offset))
                    return args
                return None
            if {"(": ")", "[": "]", "{": "}"}[stack.pop()] != char:
                return None
        elif char == "," and not stack:
            args.append((begin, offset))
            begin = offset + 1
    return None


def _js_pid_guards(js: JsSource) -> Set[str]:
    """Recognise static imports of the shared helper, not lookalike local functions."""
    names: Set[str] = set()
    for offset, literal, _, _ in js.strings:
        module = literal.removesuffix(".ts").removesuffix(".js")
        if not literal.startswith(".") or not module.endswith("/kitlib/proc"):
            continue
        before = js.code[max(0, offset - 4096):offset].rstrip()
        if not before.endswith("from"):
            continue
        keywords = list(JS_KEYWORD_RE.finditer(before))
        if not keywords or keywords[-1].group(1) != "import":
            continue
        clause = before[keywords[-1].end():-4].strip()
        if clause.startswith("type"):
            continue
        if clause.startswith("*"):
            words = clause.split()
            if len(words) == 3 and words[1] == "as" and JS_IDENT_RE.fullmatch(words[2]):
                names.add(words[2] + ".safePid")
        elif clause.startswith("{") and clause.endswith("}"):
            for spec in clause[1:-1].split(","):
                words = spec.split()
                if words == ["safePid"]:
                    names.add("safePid")
                elif len(words) == 3 and words[:2] == ["safePid", "as"] and JS_IDENT_RE.fullmatch(words[2]):
                    names.add(words[2])
    return names


def _js_safe_target(value: str, guards: Set[str]) -> bool:
    value = value.strip()
    if _literal_pid(value):
        return True
    if value.startswith("-"):
        value = value[1:].strip()
    callee, opening, tail = value.partition("(")
    if not opening or callee.strip() not in guards:
        return False
    rest = opening + tail
    args = _js_arguments(rest, 0)
    return args is not None and len(args) == 1 and args[0][1] == len(rest) - 1


JS_SIGNAL_RE = re.compile(r"\bprocess\s*\.\s*kill\s*\(")
SH_SIGNAL_RE = re.compile(r"\bkill(?![A-Za-z0-9_.=-])")


def _js_signal(js: JsSource, hits: core.Hits) -> None:
    guards = _js_pid_guards(js)
    for match in JS_SIGNAL_RE.finditer(js.code):
        args = _js_arguments(js.code, match.end() - 1)
        if args is not None and len(args) >= 2:
            signal = js.bare[slice(*args[1])].strip()
            if signal in ("0", "'0'", '"0"'):
                continue
        if args is None or not _js_safe_target(js.code[slice(*args[0])], guards):
            line, col = js.where(match.start())
            hits.add(UNSAFE_SIGNAL, line, col, "process.kill")


def _sh_signal(code: str, number: int, hits: core.Hits, heredoc: bool = False) -> None:
    for start, end in core.sh_command_words(code, SH_SIGNAL_RE):
        if not core.sh_command_position(code, start):
            continue
        if heredoc and not code[:start].endswith(("$(", "`")):
            continue
        if code[end:].lstrip().startswith("("):  # shell function definition, not a signal
            continue
        try:
            lexer = shlex.shlex(code[end:], posix=True, punctuation_chars=";&|<>")
            lexer.whitespace_split = True
            words = list(lexer)
        except ValueError:
            hits.add(UNSAFE_SIGNAL, number, start + 1, "kill (unparsed)")
            continue
        signal = "TERM"
        if words and words[0] in ("-s", "--signal", "-n"):
            if len(words) < 2:
                continue
            signal, words = words[1], words[2:]
        elif words and words[0].startswith("--signal="):
            signal, words = words[0].partition("=")[2], words[1:]
        elif words and words[0].startswith("-") and words[0] != "--":
            signal, words = words[0][1:], words[1:]
        if signal == "0":
            continue
        if words and words[0] == "--":
            words = words[1:]
        targets = []
        for word in words:
            if word and word[0] in ";&|<>":
                break
            targets.append(word)
        if any(not _literal_pid(word) for word in targets):
            hits.add(UNSAFE_SIGNAL, number, start + 1, "kill")


def _sh_signal_heredoc(code: str, number: int, hits: core.Hits) -> None:
    _sh_signal(code, number, hits, heredoc=True)


# --- rule registry: add a primitive's rule by appending its functions ----
PY_RULES: List[Callable[[core.PySource, core.Hits], None]] = [_py_raw_spawn, _py_signal]
JS_RULES: List[Callable[[JsSource, core.Hits], None]] = [_js_raw_spawn, _js_signal]
SH_CODE_RULES: List[core.ShCodeFn] = [_sh_raw_spawn_code, _sh_signal]
SH_HEREDOC_RULES: List[core.ShCodeFn] = [_sh_raw_spawn_heredoc, _sh_signal_heredoc]


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


# --- the committed allowlist ----------------------------------------------
Allowlist = Dict[str, Dict[str, int]]


def parse_allowlist(raw: bytes, rules: Sequence[str] = (RAW_SPAWN,)) -> Allowlist:
    """The counts of a committed allowlist; ValueError when it is not one."""
    data = json.loads(raw.decode("utf-8"))
    if not isinstance(data, dict) or data.get("schema") != BASELINE_SCHEMA or not isinstance(data.get("counts"), dict):
        raise ValueError(f"want an object with schema {BASELINE_SCHEMA} and counts")
    counts: Allowlist = {}
    for rule, paths in data["counts"].items():
        if rule not in rules or not isinstance(paths, dict):
            raise ValueError(f"counts.{rule}: not a site rule mapping paths to counts")
        for path, count in paths.items():
            if isinstance(count, bool) or not isinstance(count, int) or count < 1:
                raise ValueError(f"counts.{rule}.{path}: want a positive integer")
        counts[rule] = dict(paths)
    if UNSAFE_SIGNAL in rules and UNSAFE_SIGNAL not in counts:
        raise ValueError("unsafe-signal-pid mapping is required")
    if data.get("totals") != {rule: sum(paths.values()) for rule, paths in counts.items()}:
        raise ValueError("totals do not sum the counts")
    return counts


def render_totals(counts: Allowlist, rules: Sequence[str] = (RAW_SPAWN,)) -> Dict[str, int]:
    return {rule: sum(counts.get(rule, {}).values()) for rule in rules}


def render_allowlist(counts: Allowlist, rules: Sequence[str] = (RAW_SPAWN,)) -> str:
    payload = {
        "schema": BASELINE_SCHEMA,
        "about": "kitlib_ratchet allowlist (ompkit-qwqh1): pre-existing sites per rule per path. "
                 "It only shrinks: a commit or push that raises a count or adds an entry is refused. "
                 "Regenerate with: python3 scripts/kitlib_ratchet.py --write-baseline"
                 + (" --signal-baseline" if UNSAFE_SIGNAL in rules else ""),
        "totals": render_totals(counts, rules),
        "counts": {rule: dict(sorted(counts.get(rule, {}).items())) for rule in rules},
    }
    return json.dumps(payload, indent=1, sort_keys=True) + "\n"


def _spec(rev: Optional[str], path: str) -> str:
    return (":" if rev is None else rev + ":") + path


def _blob(repo: str, spec: str) -> Optional[bytes]:
    """The blob at ``spec``, or None when it does not exist."""
    probe = core.pysafe.run_bounded(["git", "-C", repo, "cat-file", "-e", spec], core.GIT_TIMEOUT_S, cap_bytes=4096)
    if probe.outcome != core.pysafe.OK:
        raise core.GitError(f"git cat-file -e {spec}: TIMEOUT after {core.GIT_TIMEOUT_S:g}s")
    return core._git(repo, "cat-file", "blob", spec) if probe.returncode == 0 else None

def _valid_object_id(value: str, *, full: bool = False) -> bool:
    lengths = (40, 64) if full else range(7, 65)
    return len(value) in lengths and all(char in "0123456789abcdefABCDEF" for char in value)


def fresh_published_origin_sha(repo: str) -> str:
    """Bind origin/main to the server's current ref without changing local refs."""
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    result = core.pysafe.run_bounded(
        ["git", "-C", repo, "ls-remote", "--heads", "--exit-code", "origin", "refs/heads/main"],
        ORIGIN_QUERY_TIMEOUT_S,
        cap_bytes=4096,
        env=env,
    )
    if result.outcome != core.pysafe.OK:
        raise core.GitError(f"git ls-remote origin/main: TIMEOUT after {ORIGIN_QUERY_TIMEOUT_S:g}s")
    if result.stdout_truncated:
        raise core.GitError("git ls-remote origin/main: response over 4096 bytes")
    if result.returncode != 0:
        raise core.GitError("git ls-remote origin/main: published ref unavailable")
    rows = [line.split() for line in result.stdout.splitlines() if line]
    if len(rows) != 1 or len(rows[0]) != 2 or rows[0][1] != b"refs/heads/main":
        raise core.GitError("git ls-remote origin/main: expected exactly one published ref")
    try:
        published = rows[0][0].decode("ascii")
        tracked = core._git(repo, "rev-parse", "--verify",
                            "refs/remotes/origin/main^{commit}").decode("ascii").strip()
    except UnicodeDecodeError as exc:
        raise core.GitError("origin/main returned a non-ASCII object id") from exc
    if not _valid_object_id(published, full=True) or not _valid_object_id(tracked, full=True):
        raise core.GitError("origin/main did not resolve to a full commit id")
    if published.lower() != tracked.lower():
        raise core.GitError("origin/main tracking ref is stale: published and tracked commit ids differ")
    return published.lower()


def _nul_paths(raw: bytes) -> Set[str]:
    try:
        return {path.decode("utf-8") for path in raw.split(b"\0") if path}
    except UnicodeDecodeError as exc:
        raise core.GitError("Git path list contains a non-UTF-8 path") from exc


def _index_entry_matches_tree(repo: str, tree: str, path: str) -> bool:
    result = core.pysafe.run_bounded(
        ["git", "-C", repo, "--literal-pathspecs", "diff", "--cached", "--quiet",
         "--no-ext-diff", "--no-textconv", "--no-renames", tree, "--", path],
        core.GIT_TIMEOUT_S,
        cap_bytes=4096,
    )
    if result.outcome != core.pysafe.OK:
        raise core.GitError(f"git diff --cached {tree} -- {path}: TIMEOUT after {core.GIT_TIMEOUT_S:g}s")
    if result.returncode == 0:
        return True
    if result.returncode == 1:
        return False
    raise core.GitError(f"git diff --cached {tree} -- {path}: exit {result.returncode}")


def _origin_sha_from_admission(admission: str) -> Optional[str]:
    marker = "origin/main@"
    _, found, remainder = admission.partition(marker)
    if not found:
        return None
    oid, separator, _ = remainder.partition(":")
    return oid if separator and _valid_object_id(oid, full=True) else None


def _admitted_origin_by_path(reports: Sequence[core.FileReport]) -> Dict[str, str]:
    admitted: Dict[str, str] = {}
    for report in reports:
        for message in report.admissions:
            oid = _origin_sha_from_admission(message)
            if oid is not None:
                admitted[report.path] = oid
    return admitted


def _reversal_verdict(payload: dict) -> None:
    sys.stdout.write("kitlib-reversal: " + json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n")



def _judged(path: str) -> bool:
    ext = os.path.splitext(os.path.basename(path))[1]
    return not ext or ext in core.EXTENSIONS


def _sites(report: core.FileReport, rule: str) -> List[core.Finding]:
    """Every site of ``rule``, a pragma'd one included: a pragma never removes a site from the count."""
    return [f for f in report.findings if f.rule == rule]


@dataclass(frozen=True)
class KitlibRuleSet(core.RuleSet):
    """The engine's git ratchet, then the committed allowlist (BASELINE) on top.

    With an allowlist at the base or the new side: an allowlist that raises a
    count or adds an entry (a rename may carry its old path's count) is
    ``allowlist-raised``; deleting one the base side has is
    ``allowlist-deleted`` (the zero state is an allowlist with empty counts);
    a judged path with more sites of a rule than its allowlisted count reports
    the surplus as that rule's finding, a ``kitlib:``-pragma'd site included.
    A repo with no allowlist on either side keeps the git ratchet alone."""

    def _diff(self, repo: str, base: Optional[str], head: Optional[str]) -> bytes:
        if head is None:
            if base is not None:
                return core._git(repo, "diff", "--cached", "--name-status", "-z", "-M", "--diff-filter=AMRT", base)
            return core._git(repo, "diff", "--cached", "--name-status", "-z", "--diff-filter=AMRT")
        if base is not None:
            return core._git(repo, "diff", "--name-status", "-z", "-M", "--diff-filter=AMRT", base, head)
        return core._git(repo, "diff-tree", "--root", "-r", "--no-commit-id", "--name-status", "-z", "-M",
                         "--diff-filter=AMRT", head)

    def _origin_equal_staged_paths(
        self, repo: str, base: Optional[str], head: Optional[str], candidate_paths: Set[str]
    ) -> Dict[str, str]:
        """Bind only incumbent raw-spawn paths whose complete index entry equals published origin/main."""
        if head is not None or base is None or not candidate_paths:
            return {}

        remote = core.pysafe.run_bounded(
            ["git", "-C", repo, "config", "--get", "remote.origin.url"],
            core.GIT_TIMEOUT_S,
            cap_bytes=4096,
        )
        if remote.outcome != core.pysafe.OK:
            raise core.GitError(f"git config remote.origin.url: TIMEOUT after {core.GIT_TIMEOUT_S:g}s")
        if remote.returncode == 1:
            return {}
        if remote.returncode != 0:
            raise core.GitError(f"git config remote.origin.url: exit {remote.returncode}")
        origin = fresh_published_origin_sha(repo)
        return {
            path: origin for path in sorted(candidate_paths)
            if _index_entry_matches_tree(repo, origin, path)
        }

    @staticmethod
    def _apply_origin_admissions(
        reports: List[core.FileReport], origin_equal: Dict[str, str]
    ) -> List[core.FileReport]:
        if not origin_equal:
            return reports
        by_path = {report.path: report for report in reports}
        for path, origin in sorted(origin_equal.items()):
            report = by_path.get(path)
            if report is None:
                continue
            eligible = any(f.rule == RAW_SPAWN and f.suppressed is None for f in report.findings)
            if not eligible:
                continue
            report.findings = [
                finding for finding in report.findings
                if finding.rule != RAW_SPAWN or finding.suppressed is not None
            ]
            report.admissions.append(
                f"incumbent raw-spawn entry matches exact staged path at origin/main@{origin}: {path}"
            )
        return reports

    def _apply_published_origin_admissions(
        self, repo: str, base: Optional[str], head: Optional[str], reports: List[core.FileReport]
    ) -> List[core.FileReport]:
        candidates = {
            report.path for report in reports
            if any(f.rule == RAW_SPAWN and f.suppressed is None for f in report.findings)
        }
        origin_equal = self._origin_equal_staged_paths(repo, base, head, candidates)
        return self._apply_origin_admissions(reports, origin_equal)

    def ratchet(self, repo: str, base: Optional[str], head: Optional[str]) -> List[core.FileReport]:
        reports = super().ratchet(repo, base, head)
        self._ratchet_allowlist(repo, base, head, reports, BASELINE, (RAW_SPAWN,))
        self._ratchet_allowlist(repo, base, head, reports, SIGNAL_BASELINE, (UNSAFE_SIGNAL,))
        return self._apply_published_origin_admissions(repo, base, head, reports)

    def _ratchet_allowlist(self, repo: str, base: Optional[str], head: Optional[str],
                          reports: List[core.FileReport], baseline: str, rules: Sequence[str]) -> None:
        new_raw = _blob(repo, _spec(head, baseline))
        old_raw = _blob(repo, _spec(base, baseline)) if base is not None else None
        if new_raw is None and old_raw is None:
            sys.stderr.write(f"{self.prog}: no {baseline}; judged against git history only\n")
            return
        listing = core.FileReport(baseline)
        old: Optional[Allowlist] = None
        if old_raw is not None:
            try:
                old = parse_allowlist(old_raw, rules)
            except ValueError:
                old = None  # a broken base allowlist is replaced, never extended against
        new: Allowlist = {}
        if new_raw is None:
            listing.findings.append(core.Finding(baseline, 1, 1, ALLOWLIST_DELETED, RULES[ALLOWLIST_DELETED],
                                                 "deleted; write an empty one with --write-baseline"))
        else:
            try:
                new = parse_allowlist(new_raw, rules)
            except ValueError as exc:
                listing.findings.append(core.Finding(baseline, 1, 1, ALLOWLIST_INVALID, RULES[ALLOWLIST_INVALID],
                                                     core.collapse(str(exc))))
                new = old or {}
        pairs = self.changed(self._diff(repo, base, head))
        renamed = {path: old_path for old_path, path in pairs if old_path is not None and old_path != path}
        # First introduction of the signal inventory is bounded by immutable
        # base source, never the candidate file. The raw-spawn schema stays
        # byte-compatible with checkers installed before PIDGUARD1.
        if baseline == SIGNAL_BASELINE and old_raw is None and new_raw is not None and base is not None:
            seeded: Dict[str, int] = {}
            for path in new.get(UNSAFE_SIGNAL, {}):
                if not path or not _judged(path):
                    continue
                source = _blob(repo, _spec(base, path))
                lang = core.language(path, (source or b"")[:256])
                if source is not None and lang is not None:
                    count = len(_sites(self.check_source(source, path, lang), UNSAFE_SIGNAL))
                    if count:
                        seeded[path] = count
            old = {UNSAFE_SIGNAL: seeded}
        if old is not None:
            for rule in rules:
                before, after = old.get(rule, {}), new.get(rule, {})
                for path, count in sorted(after.items()):
                    prev = before.get(path)
                    if prev is None and path in renamed and renamed[path] not in after:
                        prev = before.get(renamed[path])
                    if prev is None or count > prev:
                        listing.findings.append(core.Finding(baseline, 1, 1, ALLOWLIST_RAISED,
                                                             RULES[ALLOWLIST_RAISED],
                                                             f"{rule} {path}: {prev or 0} -> {count}"))
        targets = {path for _, path in pairs}
        for rule, paths in (old or {}).items():
            targets.update(path for path, count in paths.items()
                           if new.get(rule, {}).get(path, 0) < count and not self.is_exempt(path))
        by_path = {report.path: report for report in reports}
        for path in sorted(targets):
            if not _judged(path):
                continue
            source = _blob(repo, _spec(head, path))
            lang = None if source is None else core.language(path, source[:256])
            if source is None or lang is None:
                continue
            full = self.check_source(source, path, lang)
            for rule in rules:
                sites = _sites(full, rule)
                allowed = new.get(rule, {}).get(path, 0)
                report = by_path.get(path)
                reported = {f.line for f in report.active() if f.rule == rule} if report else set()
                surplus = len(sites) - allowed - len(reported)
                if surplus <= 0:
                    continue
                if report is None:
                    report = by_path[path] = core.FileReport(path)
                    reports.append(report)
                for finding in [f for f in sites if f.line not in reported][-surplus:]:
                    pragma = f"; its {self.pragma}: pragma documents an allowlisted site and admits no new one" \
                        if finding.suppressed is not None else ""
                    finding.detail += f" ({len(sites)} sites, {allowed} allowlisted in {baseline}{pragma})"
                    finding.suppressed = None
                    report.findings.append(finding)
                report.findings.sort(key=lambda f: (f.line, f.col, f.rule))
        if listing.findings:
            reports.append(listing)

    def verify_reversal_message(self, repo: str, message_path: str) -> int:
        try:
            trailer_lines = core._git(repo, "interpret-trailers", "--parse", message_path).decode("utf-8").splitlines()
            reverts = []
            for line in trailer_lines:
                key, separator, value = line.partition(":")
                if separator and key.strip().casefold() == "revert":
                    reverts.append(value.strip())
            base = core._base_rev(repo, argparse.Namespace(base=None, staged=True, head=None))
            reports = self.ratchet(repo, base, None)
        except (UnicodeDecodeError, OSError, ValueError, core.GitError) as exc:
            _reversal_verdict({"verdict": "REFUSED", "reason": str(exc).replace("\n", " ")})
            return 2

        admitted = _admitted_origin_by_path(reports)
        active: Dict[str, List[str]] = {}
        for report in reports:
            rules = sorted({finding.rule for finding in report.active()})
            if rules:
                active[report.path] = rules

        # The exact named-X proof below authorizes only a published-origin raw-spawn admission.
        # A Revert trailer on an ordinary commit (a root, partial or multi-commit rewrite that member 49
        # judges) uses no admission, so it gets the ordinary verdict: refuse active findings, else pass.
        if not reverts or not admitted:
            if admitted:
                _reversal_verdict({
                    "verdict": "REFUSED",
                    "reason": "missing Revert trailer for published-origin raw-spawn admission",
                    "paths": [
                        {"path": path, "verdict": "REFUSED", "origin_main": origin,
                         "reason": "missing Revert trailer"}
                        for path, origin in sorted(admitted.items())
                    ],
                })
                return 1
            if active:
                _reversal_verdict({
                    "verdict": "REFUSED",
                    "reason": "native kitlib ratchet has staged findings",
                    "paths": [
                        {"path": path, "verdict": "REFUSED", "rules": rules}
                        for path, rules in sorted(active.items())
                    ],
                })
                return 1
            return 0

        if len(reverts) != 1:
            _reversal_verdict({"verdict": "REFUSED", "reason": "expected exactly one Revert trailer"})
            return 1
        token = reverts[0]
        if not _valid_object_id(token):
            _reversal_verdict({"verdict": "REFUSED", "reason": "Revert trailer does not name a hexadecimal commit id"})
            return 1
        try:
            named_x = core._git(repo, "rev-parse", "--verify", f"{token}^{{commit}}").decode("ascii").strip()
            if not _valid_object_id(named_x, full=True):
                raise core.GitError("resolved Revert commit id is not a full object id")
            parents = core._git(repo, "rev-list", "--parents", "-n", "1", named_x).decode("ascii").split()
        except (UnicodeDecodeError, core.GitError) as exc:
            _reversal_verdict({"verdict": "REFUSED", "reason": f"Revert trailer does not resolve to one commit: {exc}"})
            return 1
        if len(parents) != 2 or parents[0].lower() != named_x.lower():
            _reversal_verdict({
                "verdict": "REFUSED",
                "reason": "named X must have exactly one parent",
                "revert": named_x,
                "parents": parents[1:],
            })
            return 1
        parent = parents[1]
        ancestor = core.pysafe.run_bounded(
            ["git", "-C", repo, "merge-base", "--is-ancestor", named_x, "HEAD"],
            core.GIT_TIMEOUT_S,
            cap_bytes=4096,
        )
        if ancestor.outcome != core.pysafe.OK:
            _reversal_verdict({"verdict": "REFUSED", "reason": "cannot verify named X is in HEAD history"})
            return 2
        if ancestor.returncode == 1:
            _reversal_verdict({"verdict": "REFUSED", "reason": "named X is not in HEAD history", "revert": named_x})
            return 1
        if ancestor.returncode != 0:
            _reversal_verdict({"verdict": "REFUSED", "reason": "cannot verify named X is in HEAD history"})
            return 2
        try:
            expected = _nul_paths(core._git(
                repo, "diff-tree", "--no-commit-id", "-r", "--name-only", "-z", "--no-renames", parent, named_x
            ))
            staged = _nul_paths(core._git(
                repo, "diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD"
            ))
        except core.GitError as exc:
            _reversal_verdict({"verdict": "REFUSED", "reason": str(exc).replace("\n", " ")})
            return 2
        if not expected:
            _reversal_verdict({"verdict": "REFUSED", "reason": "named X has no changed paths to reverse",
                               "revert": named_x, "parent": parent})
            return 1
        if expected != staged:
            _reversal_verdict({
                "verdict": "REFUSED",
                "reason": "staged paths do not equal X changed paths",
                "revert": named_x,
                "parent": parent,
                "paths": [
                    {"path": path, "verdict": "REFUSED", "in_x": path in expected, "staged": path in staged}
                    for path in sorted(expected | staged)
                ],
            })
            return 1
        try:
            parent_matches = {
                path: _index_entry_matches_tree(repo, parent, path) for path in sorted(expected)
            }
        except core.GitError as exc:
            _reversal_verdict({"verdict": "REFUSED", "reason": str(exc).replace("\n", " ")})
            return 2
        if not all(parent_matches.values()):
            _reversal_verdict({
                "verdict": "REFUSED",
                "reason": "staged entry does not match X parent",
                "revert": named_x,
                "parent": parent,
                "paths": [
                    {"path": path, "verdict": "PASS" if matches else "REFUSED",
                     "x_parent_entry": "PASS" if matches else "REFUSED"}
                    for path, matches in sorted(parent_matches.items())
                ],
            })
            return 1
        if active:
            _reversal_verdict({
                "verdict": "REFUSED",
                "reason": "native kitlib ratchet has staged findings",
                "revert": named_x,
                "parent": parent,
                "paths": [
                    {"path": path, "verdict": "REFUSED", "rules": active.get(path, [])}
                    for path in sorted(expected)
                ],
            })
            return 1
        origin_shas = set(admitted.values())
        if len(origin_shas) > 1:
            _reversal_verdict({"verdict": "REFUSED", "reason": "origin admission has inconsistent commit bindings"})
            return 2
        origin = next(iter(origin_shas), None)
        _reversal_verdict({
            "verdict": "PASS",
            "revert": named_x,
            "parent": parent,
            "origin_main": origin,
            "paths": [
                {"path": path, "verdict": "PASS", "x_parent_entry": "PASS",
                 "raw_spawn_admitted": path in admitted, "origin_main": admitted.get(path)}
                for path in sorted(expected)
            ],
        })
        return 0


    def tree_reports(self, repo: str) -> List[core.FileReport]:
        """Every tracked, judged, non-exempt work-tree file of ``repo``, under its repo-relative path."""
        reports: List[core.FileReport] = []
        for raw in core._git(repo, "ls-files", "-z").split(b"\0"):
            path = raw.decode()
            full = os.path.join(repo, path)
            if not path or self.is_exempt(path) or not _judged(path) or os.path.islink(full) \
                    or not os.path.isfile(full):
                continue
            with open(full, "rb") as handle:
                source = handle.read(core.MAX_FILE_BYTES + 1)
            lang = core.language(path, source[:256])
            if lang is not None:
                reports.append(self.check_source(source, path, lang))
        return reports

    def tree_counts(self, repo: str) -> Allowlist:
        counts: Allowlist = {rule: {} for rule in SITE_RULES}
        for report in self.tree_reports(repo):
            for rule in SITE_RULES:
                found = len(_sites(report, rule))
                if found:
                    counts[rule][report.path] = found
        return counts

    def main(self, argv: Optional[Sequence[str]] = None) -> int:
        argv = list(sys.argv[1:] if argv is None else argv)
        if "--verify-reversal-message" in argv:
            parser = argparse.ArgumentParser(prog=self.prog + ".py")
            parser.add_argument("--verify-reversal-message", required=True, metavar="MSGFILE")
            parser.add_argument("--repo", default=".")
            args = parser.parse_args(argv)
            return self.verify_reversal_message(args.repo, args.verify_reversal_message)
        if "--write-baseline" not in argv and "--check-baseline" not in argv:
            return super().main(argv)
        parser = argparse.ArgumentParser(prog=self.prog + ".py", description=self.description)
        mode = parser.add_mutually_exclusive_group(required=True)
        mode.add_argument("--write-baseline", action="store_true")
        mode.add_argument("--check-baseline", action="store_true")
        parser.add_argument("--repo", default=".")
        parser.add_argument("--signal-baseline", action="store_true",
                            help="write/check the separate PIDGUARD1 inventory; preserve the legacy raw-spawn schema")
        parser.add_argument("--output", help=f"write the allowlist here ('-' for stdout), not REPO/{BASELINE}")
        args = parser.parse_args(argv)
        baseline = SIGNAL_BASELINE if args.signal_baseline else BASELINE
        rules = (UNSAFE_SIGNAL,) if args.signal_baseline else (RAW_SPAWN,)
        try:
            if args.write_baseline:
                text = render_allowlist(self.tree_counts(args.repo), rules)
                if args.output == "-":
                    sys.stdout.write(text)
                else:
                    with open(args.output or os.path.join(args.repo, baseline), "w", encoding="utf-8") as handle:
                        handle.write(text)
                return 0
            if args.output:
                parser.error("--output goes with --write-baseline")
            inventories = [(baseline, rules)]
            if not args.signal_baseline and os.path.isfile(os.path.join(args.repo, SIGNAL_BASELINE)):
                inventories.append((SIGNAL_BASELINE, (UNSAFE_SIGNAL,)))
            allowed: Allowlist = {}
            checked_rules = []
            inventory_paths = {}
            for name, inventory_rules in inventories:
                with open(os.path.join(args.repo, name), "rb") as handle:
                    allowed.update(parse_allowlist(handle.read(), inventory_rules))
                checked_rules.extend(inventory_rules)
                inventory_paths.update((rule, name) for rule in inventory_rules)
            reports = self.tree_reports(args.repo)
        except (OSError, ValueError, core.GitError) as exc:
            sys.stderr.write(f"{self.prog}: {exc}\n")
            return 2
        over = 0
        for report in reports:
            for rule in checked_rules:
                sites = _sites(report, rule)
                limit = allowed.get(rule, {}).get(report.path, 0)
                for finding in sites[limit:]:
                    over += 1
                    sys.stdout.write(f"{finding.path}:{finding.line}:{finding.col}: {rule}: {finding.detail} "
                                     f"({len(sites)} sites, {limit} allowlisted in {inventory_paths[rule]}): {finding.snippet}\n")
                if len(sites) < limit:
                    sys.stderr.write(f"{self.prog}: {report.path}: {rule} allowlists {limit}, {len(sites)} remain; "
                                     "lower it with --write-baseline\n")
        return 1 if over else 0


RULESET = KitlibRuleSet(
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
