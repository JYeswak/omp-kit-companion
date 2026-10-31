"""Mapped lexical-island literals; native shlex owns shell token recognition.

Mappings retain original Unicode codepoint offsets. Payload AST UTF-8 byte
columns are converted before locating host diagnostics; values are never run.
"""
from __future__ import annotations

import io
import shlex
from array import array
from dataclasses import dataclass


@dataclass
class Mapped:
    text: str
    offsets: array

    def slice(self, start: int, end: int) -> Mapped:
        return Mapped(self.text[start:end], self.offsets[start:end])

    def point(self, line: int, column: int) -> int:
        lines = self.text.splitlines(keepends=True)
        start = sum(len(part) for part in lines[:max(0, line - 1)])
        value = lines[line - 1] if 0 < line <= len(lines) else ""
        chars = len(value.encode("utf-8")[:max(0, column - 1)].decode("utf-8", "ignore"))
        index = min(start + chars, max(0, len(self.offsets) - 1))
        return self.offsets[index] if self.offsets else 0


def decode_js_literal(source: Mapped, start: int, end: int, interpolated: bool) -> Mapped:
    if interpolated or end >= len(source.text) or source.text[end] != source.text[start]:
        raise ValueError("dynamic or unterminated executable Python argument")
    text, positions = [], array("I")
    escapes = {"n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}
    index = start + 1
    while index < end:
        offset = index
        char = source.text[index]
        index += 1
        if char == "\\":
            if index >= end:
                raise ValueError("incomplete executable literal escape")
            char = source.text[index]
            index += 1
            if char in "\r\n":
                if char == "\r" and index < end and source.text[index] == "\n":
                    index += 1
                continue
            if char in escapes:
                char = escapes[char]
            elif char in "xu":
                count = 2 if char == "x" else 4
                raw = source.text[index:index + count]
                if len(raw) != count or any(c not in "0123456789abcdefABCDEF" for c in raw):
                    raise ValueError("unsupported executable literal escape")
                char = chr(int(raw, 16))
                index += count
            elif char not in "\\\"'`$":
                raise ValueError("unsupported executable literal escape")
        text.append(char)
        positions.append(source.offsets[offset])
    return Mapped("".join(text), positions)


def _shell_word(source: Mapped, start: int, end: int, expected: str) -> tuple[Mapped | None, bool]:
    text, positions = [], array("I")
    quote = ""
    quoted = False
    index = start
    while index < end:
        char, offset = source.text[index], index
        index += 1
        # shlex may consume one following punctuation character as lookahead.
        if not quote and char in ";&|<>()":
            break
        if quote != "'" and char in "$`":
            return None, False
        if not quote and char.isspace():
            continue
        if char in "'\"" and (not quote or quote == char):
            quoted = True
            quote = char if not quote else ""
            continue
        if char == "\\" and quote != "'" and index < end:
            following = source.text[index]
            if quote != '"' or following in '$`"\\\n':
                quoted = True
                char = following
                index += 1
                if char == "\n":
                    continue
        text.append(char)
        positions.append(source.offsets[offset])
    decoded = "".join(text)
    return (Mapped(decoded, positions) if decoded == expected else None), not quoted


def shell_words(source: Mapped) -> list[tuple[str, Mapped | None, bool]]:
    stream = io.StringIO(source.text)
    lexer = shlex.shlex(stream, posix=True, punctuation_chars=";&|<>()")
    lexer.whitespace_split = True
    result: list[tuple[str, Mapped | None, bool]] = []
    start = 0
    for _ in range(len(source.text) * 2 + 1):
        value = lexer.get_token()
        if value is None:
            return result
        end = stream.tell()
        mapped, unquoted = _shell_word(source, start, end, value)
        result.append((value, mapped, unquoted))
        start = end
    raise ValueError("shell token-work limit exceeded")
