"""Inline Python lexical islands, not a general shell/TypeScript parser.

Shell uses CPython shlex POSIX words and the existing core heredoc recognizer.
TS uses the core lexer plus static imported kitlib/child_process argv calls and
Bun spawn calls. Payloads are never executed; known dynamic Python arguments
are errors. Offsets are original Unicode codepoints; Python UTF-8 columns are
converted before lookup. The caller supplies the host-size and process bounds.
"""
from __future__ import annotations

from array import array
from dataclasses import dataclass, field

import kitlib_ratchet_core as core
from pysafe_inline_literals import Mapped, decode_js_literal, shell_words


@dataclass
class Extraction:
    payloads: list[Mapped] = field(default_factory=list)
    errors: list[tuple[int, str]] = field(default_factory=list)


def _trim(code: str, start: int, end: int) -> tuple[int, int]:
    while start < end and code[start].isspace():
        start += 1
    while end > start and code[end - 1].isspace():
        end -= 1
    return start, end


def _pairs(code: str) -> dict[int, int]:
    opening = {"(": ")", "[": "]", "{": "}"}
    closing = {value: key for key, value in opening.items()}
    stack: list[tuple[int, str]] = []
    result: dict[int, int] = {}
    for index, char in enumerate(code):
        if char in opening:
            stack.append((index, char))
        elif char in closing and stack and stack[-1][1] == closing[char]:
            start, _ = stack.pop()
            result[start], result[index] = index, start
    return result


def _parts(code: str, start: int, end: int, pairs: dict[int, int]) -> list[tuple[int, int]]:
    start, end = _trim(code, start, end)
    result: list[tuple[int, int]] = []
    part = index = start
    while index < end:
        if code[index] in "([{\"'`" and index in pairs and pairs[index] < end:
            index = pairs[index] + 1
            continue
        if code[index] == ",":
            result.append(_trim(code, part, index))
            part = index + 1
        index += 1
    if part < end:
        result.append(_trim(code, part, end))
    return result




def _python(name: str) -> bool:
    base = name.rsplit("/", 1)[-1]
    if base == "python":
        return True
    suffix = base[len("python"):]
    return base.startswith("python") and bool(suffix) and all(part.isdigit() for part in suffix.split("."))


def _before(code: str, end: int) -> int:
    while end > 0 and code[end - 1].isspace():
        end -= 1
    return end


def _bindings(source: Mapped, code: str, strings: list[core.StringLiteral],
              pairs: dict[int, int]) -> tuple[dict[str, str], dict[str, set[str]]]:
    runners: dict[str, str] = {}
    namespaces = {"Bun": {"spawn", "spawnSync"}}
    for start, _, end, interpolated in strings:
        before = _before(code, start)
        if before < 4 or code[before - 4:before] != "from":
            continue
        previous = _before(code, before - 4)
        body: str | None = None
        namespace: str | None = None
        if previous and code[previous - 1] == "}" and previous - 1 in pairs:
            opening = pairs[previous - 1]
            keyword = _before(code, opening)
            body = code[opening + 1:previous - 1]
        else:
            first = previous
            while first > 0 and (code[first - 1].isalnum() or code[first - 1] in "_$"):
                first -= 1
            namespace = code[first:previous]
            alias_end = _before(code, first)
            star_end = _before(code, alias_end - 2)
            if code[alias_end - 2:alias_end] != "as" or not star_end or code[star_end - 1] != "*":
                continue
            keyword = _before(code, star_end - 1)
        if keyword < 6 or code[keyword - 6:keyword] != "import":
            continue
        try:
            module = decode_js_literal(source, start, end, interpolated).text
        except ValueError:
            continue
        allowed = {"run", "runSync"} if module.endswith(("/kitlib/run.ts", "/kitlib/run.js", "/kitlib/run")) else {"spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"} if module in {"child_process", "node:child_process"} else set()
        if body is not None:
            for binding in body.split(","):
                words = binding.split()
                if words and words[0] in allowed and (len(words) == 1 or len(words) == 3 and words[1] == "as"):
                    runners[words[-1]] = words[0]
        elif namespace and allowed:
            namespaces[namespace] = allowed
    return runners, namespaces


class _Extractor:
    def __init__(self, text: str) -> None:
        self.result = Extraction()
        self.remaining = max(1, len(text)) * 4

    def error(self, source: Mapped, detail: str) -> None:
        self.result.errors.append((source.offsets[0] if source.offsets else 0, detail))

    def argv(self, values: list[tuple[str, Mapped | None]], site: Mapped, depth: int) -> bool:
        if not values:
            return False
        while values and ("=" in values[0][0] or values[0][0] in {"command", "exec", "env"}):
            values = values[1:]
        if not values:
            return False
        executable = values[0][0].rsplit("/", 1)[-1]
        args = values[1:]
        if executable in {"sh", "bash", "zsh"}:
            for index, (value, _) in enumerate(args):
                if value in {"-c", "-lc"} and index + 1 < len(args):
                    payload = args[index + 1][1]
                    if payload is None:
                        self.error(site, "dynamic executable shell argument")
                    else:
                        self.shell(payload, depth + 1)
                    break
            return False
        if not _python(executable):
            return False
        index = 0
        while index < len(args):
            value, mapped = args[index]
            if mapped is None:
                self.error(site, "dynamic Python argument before execution mode is known")
                return False
            if value.startswith("-c"):
                payload = args[index + 1][1] if value == "-c" and index + 1 < len(args) else mapped.slice(2, len(mapped.text)) if mapped is not None and value != "-c" else None
                if payload is None:
                    self.error(site, "dynamic or missing executable Python argument")
                else:
                    self.result.payloads.append(payload)
                return False
            if value.startswith("-m") or value in {"-h", "--help", "-V", "--version"}:
                return False
            if value == "-":
                return True
            if value in {"-X", "-W"}:
                if index + 1 >= len(args) or args[index + 1][1] is None:
                    self.error(site, "dynamic or missing Python option argument")
                    return False
                index += 2
                continue
            if not value.startswith("-"):
                return False
            index += 1
        return True

    def shell(self, source: Mapped, depth: int = 0) -> None:
        self.remaining -= len(source.text)
        if depth > 32 or self.remaining < 0:
            self.error(source, "inline extraction work or nesting limit exceeded")
            return
        lines = source.text.splitlines(keepends=True)
        starts = [0]
        for line in lines:
            starts.append(starts[-1] + len(line))
        number = 0
        while number < len(lines):
            header = number
            quote = ""
            documents: list[tuple[str, bool, bool]] = []
            while number < len(lines):
                code, _, quote, opened = core.sh_line(lines[number], quote)
                documents.extend(opened)
                number += 1
                if not quote and not code.rstrip().endswith("\\"):
                    break
            command = source.slice(starts[header], starts[number])
            reads_stdin = False
            segments: list[list[tuple[str, Mapped | None]]] = [[]]
            try:
                for value, mapped, unquoted in shell_words(command):
                    if value in {";", "&&", "||", "|", "&", "(", ")"}:
                        segments.append([])
                    elif not segments[-1] and unquoted and value in {"if", "elif", "while", "until", "then", "else", "do", "!", "{"}:
                        continue
                    else:
                        segments[-1].append((value, mapped))
                for segment in segments:
                    redirect = next((i for i, token in enumerate(segment) if token[0].startswith("<<")), len(segment))
                    reads_stdin = self.argv(segment[:redirect], command, depth) or reads_stdin
            except ValueError as error:
                if "python" in command.text:
                    self.error(command, str(error))
            for doc_index, (delimiter, strip_tabs, quoted) in enumerate(documents):
                body_text: list[str] = []
                offsets = array("I")
                while number < len(lines):
                    line = lines[number]
                    compared = line.lstrip("\t") if strip_tabs else line
                    if compared.rstrip("\r\n") == delimiter:
                        number += 1
                        break
                    removed = len(line) - len(compared)
                    body_text.append(compared)
                    offsets.extend(source.offsets[starts[number] + removed:starts[number + 1]])
                    number += 1
                else:
                    if reads_stdin:
                        self.error(command, "unterminated executable Python heredoc")
                    break
                if reads_stdin and doc_index == len(documents) - 1:
                    body = Mapped("".join(body_text), offsets)
                    if len([segment for segment in segments if segment]) != 1:
                        self.error(command, "ambiguous Python heredoc command ownership")
                    elif not quoted and any(char in body.text for char in "$`"):
                        self.error(command, "dynamic executable Python heredoc")
                    else:
                        self.result.payloads.append(body)

    def typescript(self, source: Mapped) -> None:
        code, _, strings, _ = core.lex_js(source.text)
        pairs = _pairs(code)
        literals = {start: (end, interpolated) for start, _, end, interpolated in strings}
        runners, namespaces = _bindings(source, code, strings, pairs)
        index = 0
        while index < len(code):
            if not (code[index].isalpha() or code[index] in "_$"):
                index += 1
                continue
            begin = index
            name, index = core.js_identifier(code, index)
            dot = _before(code, begin) - 1
            first = dot
            if dot >= 0 and code[dot] == ".":
                while first > 0 and (code[first - 1].isalnum() or code[first - 1] in "_$"):
                    first -= 1
            namespace = code[first:dot] if dot >= 0 and code[dot] == "." else ""
            member = dot >= 0 and code[dot] == "."
            operation = name if member and name in namespaces.get(namespace, ()) else runners.get(name) if not member else None
            opening = index
            while opening < len(code) and code[opening].isspace():
                opening += 1
            if operation is None or opening not in pairs or code[opening] != "(":
                continue
            arguments = _parts(code, opening + 1, pairs[opening], pairs)
            if not arguments:
                continue
            spans = arguments
            first, last = arguments[0]
            if code[first:first + 1] == "[" and pairs.get(first) == last - 1:
                spans = _parts(code, first + 1, last - 1, pairs)
            elif operation in {"exec", "execSync"}:
                spans = arguments[:1]
            elif len(arguments) > 1:
                second, end = arguments[1]
                if code[second:second + 1] == "[" and pairs.get(second) == end - 1:
                    spans = [arguments[0], *_parts(code, second + 1, end - 1, pairs)]
            values: list[tuple[str, Mapped | None]] = []
            for first, last in spans:
                literal = literals.get(first)
                value: Mapped | None = None
                if literal is not None and literal[0] + 1 == last:
                    try:
                        value = decode_js_literal(source, first, literal[0], literal[1])
                    except ValueError:
                        # The owning argv decision refuses unavailable Python payloads,
                        # but an unrelated dynamic git/etc. argument is not Python.
                        value = None
                values.append((value.text if value else "", value))
            site = source.slice(begin, pairs[opening] + 1)
            if operation in {"exec", "execSync"}:
                if values[0][1] is None:
                    self.error(site, "dynamic executable shell argument")
                else:
                    self.shell(values[0][1])
            else:
                self.argv(values, site, 0)


def extract(source: bytes, path: str) -> Extraction:
    text = source.decode("utf-8", "strict")
    mapped = Mapped(text, array("I", range(len(text))))
    extractor = _Extractor(text)
    if path.endswith(".sh"):
        extractor.shell(mapped)
    else:
        extractor.typescript(mapped)
    return extractor.result
