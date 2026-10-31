#!/usr/bin/env python3
"""pysafe_check: AST checker for Python code that can hang or read without bound.

ompkit-xa5s.34 (J-2026-10-18-28). Parser: CPython's own ``ast.parse`` for the
running interpreter (>= 3.9), module mode, complete input only (a syntax error
is the typed ``parse-error`` finding, never a silent pass). Comments come from
``tokenize`` so a ``# pysafe:`` inside a string is never a suppression. The
source is parsed, never executed.
Staged/range modes also extract complete literal Python programs from shell
commands/heredocs and recognized TypeScript runner calls; failures to resolve
a Python payload are parse-error findings at the host source location.

Rules (each is a finding at ``path:line:col``):

  subprocess-no-timeout     subprocess.run/call/check_call/check_output without
                            timeout=, getoutput/getstatusoutput, os.system,
                            os.popen, or .communicate() without a timeout.
  subprocess-orphan         subprocess.run/call/check_call/check_output WITH a
                            timeout: on expiry only the direct child is killed;
                            its descendants (git hooks, test runners) keep
                            running, holding pipes, locks and CPU. Measured
                            2026-10-19 on CPython 3.9: run() returns at the
                            timeout and leaves the grandchild alive; the
                            documented communicate(timeout) -> kill() ->
                            communicate() pattern blocks until the grandchild
                            exits. Use pysafe.run_bounded (process-group kill).
  subprocess-stdin-inherit  subprocess.run/call/check_call/check_output/Popen
                            with neither stdin= nor input= (the child inherits
                            fd 0, possibly a writerless pipe).
  net-no-timeout            urlopen, http.client connections, socket
                            create_connection, smtplib/ftplib, requests calls
                            without a timeout; socket.socket() in a scope that
                            never calls settimeout (and no setdefaulttimeout).
  wait-no-timeout           .join() .get() .acquire() .wait() .result() .select()
                            with no timeout, select.select() with three
                            arguments, os.wait(), os.waitpid(pid, 0),
                            concurrent.futures.wait/as_completed, signal.pause().
  stdin-no-tty-guard        input(), sys.stdin reads/iteration, stdin passed to a
                            reader, os.read(0, n), fileinput.input(), in a scope
                            with no isatty() check (or pysafe.read_stdin).
  unbounded-read            .read()/.readlines()/.readall() with no size on a
                            subprocess pipe (x.stdout/x.stderr), an HTTP
                            response (urlopen, getresponse), a socket makefile
                            or an os.popen stream.
  unbounded-loop            ``while True`` whose body has no exit (break, return,
                            raise, sys.exit), or whose exits are not tied to a
                            deadline or bound (a comparison involving
                            time.monotonic/time/perf_counter or a name whose
                            words include deadline, timeout, budget, remaining,
                            attempt(s), tries, retries, limit, max, ...).
  suppression-no-reason     a ``# pysafe`` comment without a reason of at least
                            two words and 10 characters.
  suppression-unused        a well-formed suppression on a line no finding
                            touches (keeps suppressions honest after a fix).
  parse-error / too-large   the file cannot be judged.

Suppression: ``# pysafe: <reason>`` or ``# pysafe(rule-a,rule-b): <reason>``
on any physical line of the flagged node (for a loop, its ``while`` header).
Suppressions themselves are never suppressible.

Limits (declared, not hidden): name resolution follows import aliases only
(no shadowing or data flow); calls passing ``**kwargs`` are not judged for
missing keywords; receivers of .join()/.get()/etc. are judged by call shape,
not type; stdin guards and socket timeouts are judged per enclosing function,
not per control-flow path. Files over 4 MiB are ``too-large``.

Modes:
  pysafe_check.py PATH...                  judge files/dirs, every finding
  pysafe_check.py --tree LABEL PATH ...    same, grouped under LABEL
  pysafe_check.py --list LABEL FILE ...    paths read from FILE, one per line
  pysafe_check.py --staged [--repo DIR]    pre-commit ratchet: staged .py/.sh/.ts
                                           against HEAD (GIT_INDEX_FILE honoured)
  pysafe_check.py --head REV [--base REV]  CI ratchet over changed .py/.sh/.ts
Ratchet: a finding is new when its (rule, enclosing scope, source text)
fingerprint occurs more often in the new blob than in the old one; untouched
pre-existing findings do not block, new ones always do.
--format text|json|md. Exit 0 clean, 1 findings, 2 usage/infrastructure.
"""
from __future__ import annotations

import argparse
import ast
import io
import json
import os
import sys
import tokenize
from collections import Counter
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import pysafe  # noqa: E402

MAX_FILE_BYTES = 4 * 1024 * 1024
GIT_TIMEOUT_S = 30.0
GIT_CAP_BYTES = 64 * 1024 * 1024
SNIPPET_CHARS = 160

RULES = {
    "subprocess-no-timeout": "blocking subprocess call without a timeout",
    "subprocess-orphan": "on timeout only the direct child is killed; descendants survive; use pysafe.run_bounded",
    "subprocess-stdin-inherit": "child inherits stdin; pass stdin=subprocess.DEVNULL or input=",
    "net-no-timeout": "network call without a timeout",
    "wait-no-timeout": "blocking wait without a timeout",
    "stdin-no-tty-guard": "reads stdin with no isatty() guard (or pysafe.read_stdin)",
    "unbounded-read": "unbounded read of a pipe, socket or response; pass a size cap",
    "unbounded-loop": "while True with no deadline-bound exit",
    "suppression-no-reason": "pysafe suppression needs a reason (two or more words, 10+ characters)",
    "suppression-unused": "pysafe suppression matches no finding on its lines",
    "parse-error": "file does not parse; it cannot be judged",
    "too-large": "file exceeds the 4 MiB judging limit",
}
UNSUPPRESSIBLE = {"suppression-no-reason", "suppression-unused", "parse-error", "too-large"}

SP_BLOCKING = {"subprocess.run", "subprocess.call", "subprocess.check_call", "subprocess.check_output"}
SP_NO_TIMEOUT_EVER = {"subprocess.getoutput", "subprocess.getstatusoutput", "os.system", "os.popen"}
SP_STDIN = SP_BLOCKING | {"subprocess.Popen"}
NET_KW_ONLY = {
    "http.client.HTTPSConnection", "smtplib.SMTP", "smtplib.SMTP_SSL", "ftplib.FTP", "ftplib.FTP_TLS",
    "requests.get", "requests.post", "requests.put", "requests.delete", "requests.head",
    "requests.patch", "requests.options", "requests.request",
}
NET_POSITIONAL = {"urllib.request.urlopen": 3, "http.client.HTTPConnection": 3, "socket.create_connection": 2}
CLOCKS = {"time.monotonic", "time.time", "time.perf_counter", "time.monotonic_ns", "time.time_ns", "time.perf_counter_ns"}
EXITS = {"sys.exit", "os._exit", "exit", "quit", "os.abort"}
BOUND_WORDS = {
    "deadline", "timeout", "budget", "remaining", "expires", "expire", "expiry", "attempt", "attempts",
    "tries", "retries", "retry", "limit", "max", "until", "elapsed", "ttl", "cap",
}
RESPONSE_SOURCES = {"urllib.request.urlopen", "os.popen"}
RESPONSE_METHODS = {"getresponse", "makefile"}
STDIN_NAMES = {"sys.stdin", "sys.stdin.buffer"}


@dataclass
class Finding:
    path: str
    line: int
    col: int
    rule: str
    detail: str
    scope: str
    snippet: str
    end_line: int
    suppressed: Optional[str] = None

    def key(self) -> Tuple[str, str, str]:
        return (self.rule, self.scope, self.snippet)

    def as_json(self) -> dict:
        return {"path": self.path, "line": self.line, "col": self.col, "rule": self.rule,
                "detail": self.detail, "scope": self.scope, "snippet": self.snippet,
                "suppressed": self.suppressed}


@dataclass
class Suppression:
    line: int
    rules: Optional[Set[str]]
    reason: str
    used: bool = False


@dataclass
class FileReport:
    path: str
    findings: List[Finding] = field(default_factory=list)

    def active(self) -> List[Finding]:
        return [f for f in self.findings if f.suppressed is None]


def _words(identifier: str) -> Set[str]:
    return {part for part in identifier.lower().split("_") if part}


def _unparse(node: ast.AST) -> str:
    text = " ".join(ast.unparse(node).split())
    return text if len(text) <= SNIPPET_CHARS else text[:SNIPPET_CHARS] + "..."


_NOT_LITERAL = object()


def _literal(node: Optional[ast.AST]) -> object:
    """The constant value of a literal argument (``-1`` is a UnaryOp), else a sentinel."""
    if node is None:
        return _NOT_LITERAL
    try:
        return ast.literal_eval(node)
    except (ValueError, TypeError, SyntaxError, RecursionError):
        return _NOT_LITERAL



def _suppressions(source: bytes, path: str) -> Tuple[Dict[int, List[Suppression]], List[Finding]]:
    table: Dict[int, List[Suppression]] = {}
    bad: List[Finding] = []
    for token in tokenize.tokenize(io.BytesIO(source).readline):
        if token.type != tokenize.COMMENT:
            continue
        text = token.string[1:].strip()
        if not text.startswith("pysafe"):
            continue
        rest = text[len("pysafe"):]
        if rest and rest[0] not in "(: \t":
            continue  # e.g. "pysafe_check.py ..." prose, not a pragma
        line, col = token.start
        rules: Optional[Set[str]] = None
        if rest.startswith("("):
            close = rest.find(")")
            if close < 0:
                rest = ""
            else:
                rules = {item.strip() for item in rest[1:close].split(",") if item.strip()}
                rest = rest[close + 1:]
        reason = rest[1:].strip() if rest.startswith(":") else ""
        unknown = sorted((rules or set()) - set(RULES))
        if len(reason) < 10 or len(reason.split()) < 2 or unknown or rules == set():
            detail = "unknown rule(s): " + ", ".join(unknown) if unknown else RULES["suppression-no-reason"]
            bad.append(Finding(path, line, col, "suppression-no-reason", detail, "<comment>",
                               token.string.strip()[:SNIPPET_CHARS], line))
            continue
        table.setdefault(line, []).append(Suppression(line, rules, reason))
    return table, bad


class _Checker(ast.NodeVisitor):
    def __init__(self, path: str, tree: ast.Module) -> None:
        self.path = path
        self.findings: List[Finding] = []
        self.aliases: Dict[str, str] = {}
        self.scopes: List[str] = []
        self.scope_nodes: List[ast.AST] = [tree]
        self.setdefaulttimeout = False
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.asname:
                        self.aliases[alias.asname] = alias.name
                    else:
                        head = alias.name.split(".")[0]
                        self.aliases[head] = head
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                for alias in node.names:
                    self.aliases[alias.asname or alias.name] = node.module + "." + alias.name
        self.defined = {node.name for node in ast.walk(tree)
                        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and self.resolve(node.func) == "socket.setdefaulttimeout":
                self.setdefaulttimeout = True
        self._scope_cache: Dict[int, dict] = {}

    # --- name resolution -------------------------------------------------
    def resolve(self, node: ast.AST) -> Optional[str]:
        if isinstance(node, ast.Name):
            if node.id in self.aliases:
                return self.aliases[node.id]
            if node.id in ("input", "exit", "quit", "open") and node.id not in self.defined:
                return node.id
            return None
        if isinstance(node, ast.Attribute):
            base = self.resolve(node.value)
            return base + "." + node.attr if base else None
        return None

    # --- scope facts -----------------------------------------------------
    def _scope_body(self, scope: ast.AST) -> Iterable[ast.AST]:
        stack = list(ast.iter_child_nodes(scope))
        while stack:
            node = stack.pop()
            yield node
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                continue
            stack.extend(ast.iter_child_nodes(node))

    def _facts(self) -> dict:
        scope = self.scope_nodes[-1]
        cached = self._scope_cache.get(id(scope))
        if cached is not None:
            return cached
        facts = {"isatty": False, "settimeout": False, "streams": set()}
        for node in self._scope_body(scope):
            if isinstance(node, ast.Call):
                name = self.resolve(node.func)
                if isinstance(node.func, ast.Attribute) and node.func.attr in ("isatty", "settimeout"):
                    facts[node.func.attr] = True
                if name and name.endswith("read_stdin") and "pysafe" in name:
                    facts["isatty"] = True
            targets: List[ast.AST] = []
            value: Optional[ast.AST] = None
            if isinstance(node, ast.Assign):
                targets, value = node.targets, node.value
            elif isinstance(node, ast.withitem) and node.optional_vars is not None:
                targets, value = [node.optional_vars], node.context_expr
            if value is not None and self._is_stream_source(value):
                for target in targets:
                    if isinstance(target, ast.Name):
                        facts["streams"].add(target.id)
        self._scope_cache[id(scope)] = facts
        return facts

    def _is_stream_source(self, node: ast.AST) -> bool:
        if isinstance(node, ast.Attribute) and node.attr in ("stdout", "stderr"):
            return self.resolve(node) not in ("sys.stdout", "sys.stderr")
        if isinstance(node, ast.Call):
            name = self.resolve(node.func)
            if name in RESPONSE_SOURCES:
                return True
            if isinstance(node.func, ast.Attribute) and node.func.attr in RESPONSE_METHODS:
                return True
        return False

    # --- reporting -------------------------------------------------------
    def add(self, node: ast.AST, rule: str, detail: str = "", end: Optional[int] = None) -> None:
        if isinstance(node, ast.While):
            snippet = "while " + _unparse(node.test)
            end_line = node.test.end_lineno or node.lineno
        else:
            snippet = _unparse(node)
            end_line = end or getattr(node, "end_lineno", None) or node.lineno
        scope = ".".join(self.scopes) or "<module>"
        self.findings.append(Finding(self.path, node.lineno, node.col_offset + 1, rule,
                                     detail or RULES[rule], scope, snippet, end_line))

    # --- traversal -------------------------------------------------------
    def _visit_scope(self, node: ast.AST, name: str) -> None:
        self.scopes.append(name)
        self.scope_nodes.append(node)
        self.generic_visit(node)
        self.scope_nodes.pop()
        self.scopes.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._visit_scope(node, node.name)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._visit_scope(node, node.name)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.scopes.append(node.name)
        self.generic_visit(node)
        self.scopes.pop()

    def visit_For(self, node: ast.For) -> None:
        if self.resolve(node.iter) in STDIN_NAMES and not self._facts()["isatty"]:
            self.add(node.iter, "stdin-no-tty-guard", "iterates sys.stdin with no isatty() guard")
        self.generic_visit(node)

    def visit_While(self, node: ast.While) -> None:
        if isinstance(node.test, ast.Constant) and node.test.value:
            exits, bounded = self._loop_exits(node)
            if not exits:
                self.add(node, "unbounded-loop", "while True with no exit (break/return/raise/sys.exit)")
            elif not bounded:
                self.add(node, "unbounded-loop", "while True exits are not tied to a deadline or bound")
        self.generic_visit(node)

    def _loop_exits(self, loop: ast.While) -> Tuple[bool, bool]:
        exits = False
        bounded = False
        stack: List[Tuple[ast.AST, bool]] = [(child, False) for child in loop.body + loop.orelse]
        while stack:
            node, nested_loop = stack.pop()
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                continue
            if isinstance(node, ast.Break) and not nested_loop:
                exits = True
            elif isinstance(node, (ast.Return, ast.Raise)):
                exits = True
            elif isinstance(node, ast.Call) and self.resolve(node.func) in EXITS:
                exits = True
            elif isinstance(node, ast.Compare) and self._bound_compare(node):
                bounded = True
            inner = nested_loop or isinstance(node, (ast.For, ast.AsyncFor, ast.While))
            stack.extend((child, inner) for child in ast.iter_child_nodes(node))
        return exits, bounded

    def _bound_compare(self, node: ast.Compare) -> bool:
        for sub in ast.walk(node):
            if isinstance(sub, ast.Call) and self.resolve(sub.func) in CLOCKS:
                return True
            if isinstance(sub, ast.Name) and _words(sub.id) & BOUND_WORDS:
                return True
            if isinstance(sub, ast.Attribute) and _words(sub.attr) & BOUND_WORDS:
                return True
        return False

    def visit_Call(self, node: ast.Call) -> None:
        name = self.resolve(node.func)
        keywords = {kw.arg for kw in node.keywords if kw.arg is not None}
        splat = any(kw.arg is None for kw in node.keywords)
        method = node.func.attr if isinstance(node.func, ast.Attribute) else None
        npos = len(node.args)
        if name:
            self._check_named(node, name, keywords, splat, npos)
        if method and not splat:
            self._check_method(node, method, name, keywords, npos)
        self.generic_visit(node)

    def _kw(self, node: ast.Call, key: str) -> Optional[ast.AST]:
        for kw in node.keywords:
            if kw.arg == key:
                return kw.value
        return None

    def _check_named(self, node: ast.Call, name: str, keywords: Set[str], splat: bool, npos: int) -> None:
        if name in SP_NO_TIMEOUT_EVER:
            self.add(node, "subprocess-no-timeout", f"{name} cannot be bounded; use pysafe.run_bounded")
        if name in SP_BLOCKING and not splat:
            if "timeout" not in keywords:
                self.add(node, "subprocess-no-timeout", f"{name} without timeout=")
            else:
                self.add(node, "subprocess-orphan")
        if name in SP_STDIN and not splat and not keywords & {"stdin", "input"}:
            self.add(node, "subprocess-stdin-inherit", f"{name} without stdin= or input=")
        if not splat and "timeout" not in keywords:
            if name in NET_KW_ONLY:
                self.add(node, "net-no-timeout", f"{name} without timeout=")
            elif name in NET_POSITIONAL and npos < NET_POSITIONAL[name]:
                self.add(node, "net-no-timeout", f"{name} without timeout")
        if name == "socket.socket":
            facts = self._facts()
            if not facts["settimeout"] and not self.setdefaulttimeout:
                self.add(node, "net-no-timeout", "socket.socket() in a scope that never calls settimeout()")
        if name == "select.select" and npos == 3 and "timeout" not in keywords:
            self.add(node, "wait-no-timeout", "select.select() without a timeout")
        if name == "os.wait" or name == "signal.pause":
            self.add(node, "wait-no-timeout", f"{name}() blocks without a timeout")
        if name == "os.waitpid" and npos == 2 and isinstance(node.args[1], ast.Constant) and node.args[1].value == 0:
            self.add(node, "wait-no-timeout", "os.waitpid(pid, 0) blocks without a timeout")
        if name in ("concurrent.futures.wait", "concurrent.futures.as_completed") and npos < 2 and "timeout" not in keywords and not splat:
            self.add(node, "wait-no-timeout", f"{name} without timeout=")
        stdin_read = (
            name == "input"
            or name == "fileinput.input"
            or (name is not None and name.rsplit(".", 1)[0] in STDIN_NAMES
                and name.rsplit(".", 1)[1] in ("read", "readline", "readlines"))
            or any(self.resolve(arg) in STDIN_NAMES for arg in node.args)
            or (name == "os.read" and npos >= 1 and isinstance(node.args[0], ast.Constant) and node.args[0].value == 0)
        )
        if stdin_read and not self._facts()["isatty"]:
            self.add(node, "stdin-no-tty-guard")

    def _check_method(self, node: ast.Call, method: str, name: Optional[str], keywords: Set[str], npos: int) -> None:
        if "timeout" in keywords:
            return
        first = node.args[0] if node.args else None
        if method == "communicate" and npos < 2:
            self.add(node, "subprocess-no-timeout", ".communicate() without timeout=")
        elif method in ("join", "wait", "result", "select") and npos == 0:
            if name not in ("os.wait", "os.path.join"):
                self.add(node, "wait-no-timeout", f".{method}() without a timeout")
        elif method == "get" and (npos == 0 or (npos == 1 and isinstance(first, ast.Constant) and first.value is True)):
            block = self._kw(node, "block")
            if npos == 0 and (block is None and node.keywords):
                return  # get(key=...) style mapping lookups
            if not (isinstance(block, ast.Constant) and block.value is False):
                self.add(node, "wait-no-timeout", ".get() blocks without a timeout")
        elif method == "acquire" and npos <= 1:
            blocking = first if first is not None else self._kw(node, "blocking")
            if not (isinstance(blocking, ast.Constant) and blocking.value is False):
                self.add(node, "wait-no-timeout", ".acquire() blocks without a timeout")
        elif method in ("read", "readlines", "readall"):
            unsized = npos == 0 or (npos == 1 and _literal(first) in (-1, None))
            if method == "readall" or unsized:
                receiver = node.func.value  # type: ignore[attr-defined]
                if self.resolve(receiver) in STDIN_NAMES:
                    return  # judged by stdin-no-tty-guard
                if self._is_stream_receiver(receiver):
                    self.add(node, "unbounded-read", f".{method}() with no size cap on a stream")

    def _is_stream_receiver(self, receiver: ast.AST) -> bool:
        if self._is_stream_source(receiver):
            return True
        if isinstance(receiver, ast.Name):
            return receiver.id in self._facts()["streams"]
        return False


def check_source(source: bytes, path: str) -> FileReport:
    report = FileReport(path)
    if len(source) > MAX_FILE_BYTES:
        report.findings.append(Finding(path, 1, 1, "too-large", RULES["too-large"], "<file>", f"{len(source)} bytes", 1))
        return report
    try:
        tree = ast.parse(source, filename=path)
        table, bad = _suppressions(source, path)
    except (SyntaxError, ValueError, RecursionError, tokenize.TokenError) as exc:
        line = getattr(exc, "lineno", None) or 1
        report.findings.append(Finding(path, line, 1, "parse-error", f"{type(exc).__name__}: {exc}", "<file>",
                                       type(exc).__name__, line))
        return report
    checker = _Checker(path, tree)
    checker.visit(tree)
    for finding in checker.findings:
        for line in range(finding.line, finding.end_line + 1):
            for entry in table.get(line, ()):
                if entry.rules is None or finding.rule in entry.rules:
                    entry.used = True
                    finding.suppressed = entry.reason
            if finding.suppressed is not None:
                break
    report.findings.extend(checker.findings)
    report.findings.extend(bad)
    for line in sorted(table):
        for entry in table[line]:
            if not entry.used:
                report.findings.append(Finding(path, line, 1, "suppression-unused", RULES["suppression-unused"],
                                               "<comment>", entry.reason[:SNIPPET_CHARS], line))
    report.findings.sort(key=lambda f: (f.line, f.col, f.rule))
    return report


def check_host_source(source: bytes, path: str) -> FileReport:
    """Judge complete Python programs selected by the host's execution syntax."""
    if path.endswith(".py") or len(source) > MAX_FILE_BYTES:
        return check_source(source, path)
    import pysafe_inline
    import kitlib_ratchet_core as core
    report = FileReport(path)
    try:
        extraction = pysafe_inline.extract(source, path)
        text = source.decode("utf-8", "strict")
    except (UnicodeError, ValueError, RecursionError) as error:
        report.findings.append(Finding(path, 1, 1, "parse-error", str(error), "<inline>", type(error).__name__, 1))
        return report
    where = core.js_locator(text)
    for offset, detail in extraction.errors:
        line, col = where(offset)
        snippet = text.splitlines()[line - 1][:SNIPPET_CHARS] if text else ""
        report.findings.append(Finding(path, line, col, "parse-error", detail, "<inline>", snippet, line))
    if extraction.errors:
        return report
    for payload in extraction.payloads:
        try:
            parsed = check_source(payload.text.encode("utf-8"), path)
        except UnicodeError as error:
            report.findings.append(Finding(path, 1, 1, "parse-error", str(error), "<inline>", "invalid payload encoding", 1))
            continue
        for finding in parsed.findings:
            end_line, _ = where(payload.point(finding.end_line, 1))
            finding.line, finding.col = where(payload.point(finding.line, finding.col))
            finding.end_line = end_line
            report.findings.append(finding)
    report.findings.sort(key=lambda finding: (finding.line, finding.col, finding.rule))
    return report


def check_file(path: str) -> FileReport:
    with open(path, "rb") as handle:
        source = handle.read(MAX_FILE_BYTES + 1)
    return check_host_source(source, path)


def iter_python_files(path: str) -> Iterable[str]:
    if os.path.isfile(path):
        yield path
        return
    for root, dirs, files in os.walk(path):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in ("__pycache__", "node_modules", "venv"))
        for name in sorted(files):
            if name.endswith(".py"):
                yield os.path.join(root, name)


# --- git ratchet ---------------------------------------------------------
class GitError(Exception):
    pass


def _git(repo: str, *args: str) -> bytes:
    result = pysafe.run_bounded(["git", "-C", repo, *args], GIT_TIMEOUT_S, cap_bytes=GIT_CAP_BYTES)
    if result.outcome != pysafe.OK:
        raise GitError(f"git {' '.join(args)}: TIMEOUT after {GIT_TIMEOUT_S:g}s")
    if result.stdout_truncated:
        raise GitError(f"git {' '.join(args)}: output over {GIT_CAP_BYTES} bytes")
    if result.returncode != 0:
        raise GitError(f"git {' '.join(args)}: exit {result.returncode}: {result.text('stderr').strip()}")
    return result.stdout


def _changed(raw: bytes) -> List[Tuple[Optional[str], str]]:
    """Parse ``--name-status -z -M`` into (old_path, new_path) pairs for A/M/R .py files."""
    items = raw.split(b"\0")
    pairs: List[Tuple[Optional[str], str]] = []
    index = 0
    while index < len(items) and items[index]:
        status = items[index].decode()
        if status.startswith("R") or status.startswith("C"):
            old, new = items[index + 1].decode(), items[index + 2].decode()
            index += 3
            pairs.append((old if status.startswith("R") else None, new))
            continue
        path = items[index + 1].decode()
        index += 2
        if status in ("A", "M", "T"):
            pairs.append((path if status != "A" else None, path))
    return [(old, new) for old, new in pairs if new.endswith((".py", ".sh", ".ts"))]


def _blob(repo: str, spec: str) -> bytes:
    return _git(repo, "cat-file", "blob", spec)


def ratchet(repo: str, base: Optional[str], head: Optional[str]) -> List[FileReport]:
    """head=None judges the index (staged) against base (HEAD)."""
    if head is None:
        if base is not None:
            raw = _git(repo, "diff", "--cached", "--name-status", "-z", "-M", "--diff-filter=AMRT", base)
        else:
            raw = _git(repo, "diff", "--cached", "--name-status", "-z", "--diff-filter=AMRT")
    elif base is not None:
        raw = _git(repo, "diff", "--name-status", "-z", "-M", "--diff-filter=AMRT", base, head)
    else:
        raw = _git(repo, "diff-tree", "--root", "-r", "--no-commit-id", "--name-status", "-z", "-M",
                   "--diff-filter=AMRT", head)
    reports: List[FileReport] = []
    for old, new in _changed(raw):
        new_source = _blob(repo, (":" if head is None else head + ":") + new)
        after = check_host_source(new_source, new)
        before_keys: Counter = Counter()
        if old is not None and base is not None:
            before_keys = Counter(f.key() for f in check_host_source(_blob(repo, f"{base}:{old}"), old).active())
        after_active = after.active()
        after_keys = Counter(f.key() for f in after_active)
        new_keys = {key: after_keys[key] - before_keys.get(key, 0) for key in after_keys}
        report = FileReport(new)
        for finding in after_active:
            extra = new_keys.get(finding.key(), 0)
            if extra > 0:
                if after_keys[finding.key()] > extra:
                    finding.detail += f" ({extra} new of {after_keys[finding.key()]} identical)"
                report.findings.append(finding)
        reports.append(report)
    return reports


# --- output --------------------------------------------------------------
def _display(path: str) -> str:
    home = os.path.expanduser("~")
    return "~" + path[len(home):] if path.startswith(home + os.sep) else path


def emit_text(groups: Sequence[Tuple[str, List[FileReport]]], out) -> None:
    for _, reports in groups:
        for report in reports:
            for f in report.active():
                out.write(f"{_display(f.path)}:{f.line}:{f.col}: {f.rule}: {f.detail}: {f.snippet}\n")


def emit_json(groups: Sequence[Tuple[str, List[FileReport]]], out) -> None:
    payload = {"rules": RULES, "groups": [
        {"label": label, "files": [{"path": _display(r.path), "findings": [f.as_json() for f in r.findings]}
                                   for r in reports]}
        for label, reports in groups]}
    json.dump(payload, out, indent=1, sort_keys=True)
    out.write("\n")


def emit_md(groups: Sequence[Tuple[str, List[FileReport]]], out) -> None:
    rules = list(RULES)
    grand: Counter = Counter()
    grand_suppressed = 0
    grand_files = 0
    summary: List[Tuple[str, int, int, Counter, int]] = []
    sections: List[str] = []
    for label, reports in groups:
        totals: Counter = Counter()
        suppressed = 0
        rows = []
        for report in reports:
            counts = Counter(f.rule for f in report.active())
            sup = len(report.findings) - len(report.active())
            totals.update(counts)
            suppressed += sup
            if counts or sup:
                cells = ", ".join(f"{rule} {counts[rule]}" for rule in rules if counts[rule])
                rows.append(f"| `{_display(report.path)}` | {sum(counts.values())} | {cells or '-'} | {sup} |")
        clean = len(reports) - len(rows)
        sections.append(f"## {label}\n\n{len(reports)} files judged, {clean} with no findings.\n\n"
                        "| file | findings | by rule | suppressed |\n|---|---:|---|---:|\n" + "\n".join(rows) + "\n")
        summary.append((label, len(reports), sum(totals.values()), totals, suppressed))
        grand.update(totals)
        grand_suppressed += suppressed
        grand_files += len(reports)
    out.write("## Totals by tree and rule\n\n| rule | " + " | ".join(label for label, *_ in summary) + " | all |\n")
    out.write("|---|" + "---:|" * (len(summary) + 1) + "\n")
    for rule in rules:
        out.write(f"| {rule} | " + " | ".join(str(t[rule]) for *_, t, _s in summary) + f" | {grand[rule]} |\n")
    out.write("| **findings** | " + " | ".join(str(n) for _l, _f, n, _t, _s in summary) + f" | {sum(grand.values())} |\n")
    out.write("| suppressed | " + " | ".join(str(s) for *_, s in summary) + f" | {grand_suppressed} |\n")
    out.write("| files judged | " + " | ".join(str(f) for _l, f, *_ in summary) + f" | {grand_files} |\n\n")
    out.write("\n".join(sections))


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="pysafe_check.py", description=__doc__.split("\n\n")[0])
    parser.add_argument("paths", nargs="*")
    parser.add_argument("--tree", nargs=2, action="append", default=[], metavar=("LABEL", "PATH"))
    parser.add_argument("--list", nargs=2, action="append", default=[], metavar=("LABEL", "FILE"))
    parser.add_argument("--staged", action="store_true")
    parser.add_argument("--base")
    parser.add_argument("--head")
    parser.add_argument("--repo", default=".")
    parser.add_argument("--format", choices=("text", "json", "md"), default="text")
    args = parser.parse_args(argv)
    groups: List[Tuple[str, List[FileReport]]] = []
    if args.staged or args.head:
        if args.paths or args.tree or args.list or (args.staged and args.head):
            parser.error("--staged/--head take no paths and exclude each other")
        repo = args.repo
        try:
            base = args.base
            if args.staged and base is None:
                probe = pysafe.run_bounded(["git", "-C", repo, "rev-parse", "-q", "--verify", "HEAD^{commit}"],
                                           GIT_TIMEOUT_S, cap_bytes=4096)
                if probe.outcome != pysafe.OK:
                    raise GitError("git rev-parse HEAD: TIMEOUT")
                base = "HEAD" if probe.returncode == 0 else None
            if args.head and base is None:
                parent = pysafe.run_bounded(["git", "-C", repo, "rev-parse", "-q", "--verify", args.head + "^"],
                                            GIT_TIMEOUT_S, cap_bytes=4096)
                if parent.outcome == pysafe.OK and parent.returncode == 0:
                    base = parent.text().strip()
            groups.append(("changed", ratchet(repo, base, None if args.staged else args.head)))
        except GitError as exc:
            sys.stderr.write(f"pysafe_check: {exc}\n")
            return 2
    else:
        entries: List[Tuple[str, str]] = [(p, p) for p in args.paths] + [tuple(t) for t in args.tree]
        for label, listfile in args.list:
            with open(listfile, "r", encoding="utf-8") as handle:
                entries.extend((label, line.strip()) for line in handle.read(MAX_FILE_BYTES).splitlines() if line.strip())
        if not entries:
            parser.error("give PATH arguments, --tree, --list, --staged or --head")
        by_label: Dict[str, List[FileReport]] = {}
        for label, path in entries:
            if not os.path.exists(path):
                sys.stderr.write(f"pysafe_check: no such path: {path}\n")
                return 2
            bucket = by_label.setdefault(label, [])
            bucket.extend(check_file(p) for p in iter_python_files(path))
        groups = list(by_label.items())
    {"text": emit_text, "json": emit_json, "md": emit_md}[args.format](groups, sys.stdout)
    return 1 if any(r.active() for _, reports in groups for r in reports) else 0


if __name__ == "__main__":
    pysafe.run_main(main)
