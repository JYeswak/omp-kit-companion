#!/usr/bin/env python3
"""Generate portable CC event and credential tables from their canonical JSON sources.

    python3 scripts/generate-cc-schema.py EVENTS_JSON CREDENTIALS_JSON [--check]

Python is an authoring/build dependency only. Installed CC producers use the embedded tables and Bun/JSC.
The native Python regex parser owns recognition; unsupported AST/flags refuse rather than dropping rules.
Only numbered captures are consumed by the credential policy; named captures keep their numbered slots.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any

try:
    parser = importlib.import_module("re._parser")
    constants = importlib.import_module("re._constants")
except ModuleNotFoundError:  # CPython 3.9 exposes the same native grammar through these modules.
    parser = importlib.import_module("sre_parse")
    constants = importlib.import_module("sre_constants")

FIELD_KEYS = {"type", "required", "nullable", "enum", "enum_ref", "minimum", "maximum",
              "min_length", "max_length", "code", "items", "fields"}
FIELD_TYPES = {"string", "integer", "number", "boolean", "array", "object"}
TYPE_FLAGS = constants.SRE_FLAG_ASCII | constants.SRE_FLAG_UNICODE | constants.SRE_FLAG_LOCALE
SUPPORTED_FLAGS = constants.SRE_FLAG_ASCII | constants.SRE_FLAG_UNICODE
ROOT = Path(__file__).resolve().parents[1]


def ranges(points: list[int]) -> list[list[int]]:
    out: list[list[int]] = []
    for point in points:
        if out and point == out[-1][1] + 1:
            out[-1][1] = point
        else:
            out.append([point, point])
    return out


def literal(point: int) -> str:
    return "\\u{" + format(point, "x") + "}"


def class_body(intervals: list[list[int]]) -> str:
    return "".join(literal(lo) if lo == hi else literal(lo) + "-" + literal(hi) for lo, hi in intervals)


class RegexRenderer:
    """Render the catalog's supported native AST fragment into ECMAScript Unicode regexes."""
    def __init__(self) -> None:
        self.spaces = class_body(ranges([point for point in range(0x110000) if chr(point).isspace()]))
        self.expressions = 0

    def scoped_flags(self, flags: int, add: int, remove: int) -> int:
        if add & TYPE_FLAGS:
            flags &= ~TYPE_FLAGS
        flags = (flags | add) & ~remove
        if flags & ~SUPPORTED_FLAGS:
            raise ValueError("REGEX_FLAGS_UNSUPPORTED")
        return flags

    def charset(self, items: Any, flags: int) -> str:
        negate = ""
        pieces: list[str] = []
        for op, value in items:
            name = str(op)
            if name == "NEGATE":
                negate = "^"
            elif name == "LITERAL":
                pieces.append(literal(value))
            elif name == "RANGE":
                pieces.append(literal(value[0]) + "-" + literal(value[1]))
            elif name == "CATEGORY" and str(value) == "CATEGORY_SPACE":
                pieces.append("\\u{9}-\\u{d}\\u{20}" if flags & constants.SRE_FLAG_ASCII else self.spaces)
            else:
                raise ValueError("REGEX_CHARSET_UNSUPPORTED:" + name)
        return "[" + negate + "".join(pieces) + "]"

    def anchor(self, kind: Any, flags: int) -> str:
        name = str(kind)
        if name in ("AT_BEGINNING", "AT_BEGINNING_STRING"):
            return "^"
        if name == "AT_END_STRING":
            return "(?![\\s\\S])"
        if name == "AT_END":
            return "(?=\\n?(?![\\s\\S]))"
        if not flags & constants.SRE_FLAG_ASCII:
            raise ValueError("REGEX_UNICODE_BOUNDARY_UNSUPPORTED")
        if name == "AT_BOUNDARY":
            return "\\b"
        if name == "AT_NON_BOUNDARY":
            # Python 3.9 \B excludes an empty input; JavaScript's \B does not.
            return "(?:(?=[\\s\\S])|(?<=[\\s\\S]))\\B"
        raise ValueError("REGEX_ANCHOR_UNSUPPORTED:" + name)

    def nodes(self, nodes: Any, flags: int) -> str:
        self.scoped_flags(flags, 0, 0)
        out: list[str] = []
        for op, arg in nodes:
            name = str(op)
            if name == "LITERAL":
                out.append(literal(arg))
            elif name == "NOT_LITERAL":
                out.append("[^" + literal(arg) + "]")
            elif name == "IN":
                out.append(self.charset(arg, flags))
            elif name == "ANY":
                out.append("[^\\n]")  # Python dot excludes LF only, unlike JavaScript dot.
            elif name == "AT":
                out.append(self.anchor(arg, flags))
            elif name == "SUBPATTERN":
                group, add, remove, sub = arg
                out.append(("(" if group is not None else "(?:") +
                           self.nodes(sub, self.scoped_flags(flags, add, remove)) + ")")
            elif name == "BRANCH":
                out.append("(?:" + "|".join(self.nodes(branch, flags) for branch in arg[1]) + ")")
            elif name in ("MAX_REPEAT", "MIN_REPEAT"):
                lo, hi, sub = arg
                upper = "" if hi == constants.MAXREPEAT else str(hi)
                out.append("(?:" + self.nodes(sub, flags) + "){" + str(lo) + "," + upper + "}" +
                           ("?" if name == "MIN_REPEAT" else ""))
            elif name in ("ASSERT", "ASSERT_NOT"):
                direction, sub = arg
                prefix = "(?" + ("<" if direction < 0 else "") + ("=" if name == "ASSERT" else "!")
                out.append(prefix + self.nodes(sub, flags) + ")")
            else:
                raise ValueError("REGEX_OPCODE_UNSUPPORTED:" + name)
        return "".join(out)

    def compile(self, source: str) -> dict[str, str]:
        re.compile(source)  # Full native validation includes fixed-width lookbehind and group validity.
        tree = parser.parse(source)
        result = self.nodes(tree, tree.state.flags)
        self.expressions += 1
        return {"pattern": result, "flags": "u"}


def check_fields(fields: dict[str, dict[str, Any]]) -> None:
    for spec in fields.values():
        if set(spec) - FIELD_KEYS or spec.get("type") not in FIELD_TYPES:
            raise ValueError("REGISTRY_SPEC_UNSUPPORTED")
        if spec.get("enum_ref") not in (None, "tool_categories", "unknown_classes"):
            raise ValueError("REGISTRY_ENUM_UNSUPPORTED")
        if "fields" in spec:
            check_fields(spec["fields"])
        if "items" in spec:
            check_fields({"item": spec["items"]})


def normalize_allow(spec: dict[str, Any], renderer: RegexRenderer) -> dict[str, Any]:
    return dict(spec, regexes=[renderer.compile(regex) for regex in spec.get("regexes") or []],
                stopwords=spec.get("stopwords") or [])


def normalize_credentials(source: dict[str, Any], source_bytes: bytes) -> dict[str, Any]:
    if source.get("schema_version") != "omp-kit.cc.credential-shapes.v1" or not source.get("rules"):
        raise ValueError("CC_CREDENTIAL_CATALOG")
    renderer = RegexRenderer()
    rules: list[dict[str, Any]] = []
    for rule in source["rules"]:
        try:
            rules.append(dict(rule, regex=renderer.compile(rule["regex"]),
                              keywords=rule.get("keywords") or [],
                              allowlists=[normalize_allow(allow, renderer) for allow in rule.get("allowlists") or []]))
        except (ValueError, re.error) as error:
            raise ValueError("CC_CREDENTIAL_RULE_UNSUPPORTED:" + rule["id"] + ":" + str(error)) from None
    globals_ = [normalize_allow(allow, renderer) for allow in source.get("global_allowlists") or []]
    normalized = dict(source, regex_dialect="ecmascript-u", rules=rules, global_allowlists=globals_,
                      python_digit_ranges=ranges([point for point in range(0x110000) if chr(point).isdigit()]))
    normalized["normalization"] = {"source_sha256": hashlib.sha256(source_bytes).hexdigest(),
                                   "parser": parser.__name__, "python": sys.version.split()[0],
                                   "unicode": unicodedata.unidata_version, "expressions": renderer.expressions}
    return normalized


def main() -> int:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("events", type=Path)
    cli.add_argument("credentials", type=Path)
    cli.add_argument("--check", action="store_true")
    args = cli.parse_args()
    events = json.loads(args.events.read_bytes())
    if events.get("schema_version") != "omp-kit.cc.events.v1":
        raise ValueError("REGISTRY_VERSION_UNSUPPORTED")
    check_fields(events["envelope"])
    for spec in events["types"].values():
        check_fields(spec["data"])
    raw_credentials = args.credentials.read_bytes()
    credentials = normalize_credentials(json.loads(raw_credentials), raw_credentials)
    outputs = {ROOT / "src/cc-events.v1.json": events, ROOT / "src/cc-credential-shapes.v1.json": credentials}
    for path, document in outputs.items():
        text = json.dumps(document, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
        if args.check:
            if path.read_text() != text:
                raise ValueError("CC_SCHEMA_OUT_OF_DATE:" + path.name)
        else:
            path.write_text(text)
    print(json.dumps({"status": "current" if args.check else "generated", "event_types": len(events["types"]),
                      "credential_rules": len(credentials["rules"]), **credentials["normalization"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
