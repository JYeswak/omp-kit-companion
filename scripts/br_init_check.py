#!/usr/bin/env python3
"""Refuse unpinned fixture ``br init`` and caller-inheriting ``br`` calls (BRINITPIN1).

Python uses its native AST; TS/JS uses the shared kitlib lexer plus a balanced
walk over literal process-call arguments; shell uses kitlib's comment/quote/
heredoc scanner and shlex. Initialization requires the fixture's
``.beads/beads.db`` in ``--db`` or an inline ``BEADS_DB`` binding. Other
fixture commands must show a local database binding instead of inheriting the
suite's caller-selected ``BEADS_DB``. Source suppressions are disabled.
"""
from __future__ import annotations

import ast
import os
import shlex
import sys
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import kitlib_ratchet_core as core  # noqa: E402

RULE = "unpinned-br-init"
INHERITED_RULE = "inherited-br-call"
PRAGMA = "brinit"
RULES = {
    RULE: "br init must bind its fixture's own .beads/beads.db with --db or inline BEADS_DB",
    INHERITED_RULE: "fixture br calls must bind their own tracker instead of inheriting caller BEADS_DB",
    **core.meta_rules(PRAGMA),
}
EXEMPT = ("tests/fixtures/br-init/unpinned.sh",)
PY_RUNNERS = {"run", "Popen", "call", "check_call", "check_output", "brun", "run_br", "runBr"}
JS_RUNNERS = {"run", "runBounded", "spawn", "spawnSync", "execFile", "execFileSync",
              "exec", "execSync", "brun", "brOut", "runBr", "run_br"}
WRAPPERS = {"brun", "brOut", "run_br", "runBr"}


def _detail(rule: str, lang: str, constructs: List[str]) -> str:
    if rule == "parse-error":
        return f"shell analysis is incomplete: {', '.join(constructs)}"
    if rule == INHERITED_RULE:
        return "bind the fixture's br call with --db or an explicit fixture-local BEADS_DB"
    return "pass --db <fixture/.beads/beads.db> or inline BEADS_DB for that path"


def _path_is_fixture_db(values: Iterable[str]) -> bool:
    path = "/".join(values)
    return ".beads" in path and "beads.db" in path


def _ast_string(node: Optional[ast.AST]) -> Optional[str]:
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def _ast_path_is_fixture_db(node: ast.AST) -> bool:
    return _path_is_fixture_db(
        child.value for child in ast.walk(node)
        if isinstance(child, ast.Constant) and isinstance(child.value, str)
    )


def _ast_argv(node: ast.AST) -> Optional[List[ast.AST]]:
    return list(node.elts) if isinstance(node, (ast.List, ast.Tuple)) else None


def _ast_mapping_has_fixture_db(node: ast.AST, environment: bool = False) -> bool:
    if not isinstance(node, ast.Dict):
        return False
    for key, value in zip(node.keys, node.values):
        if environment and _ast_string(key) == "BEADS_DB" and _ast_path_is_fixture_db(value):
            return True
        if _ast_string(key) == "env" and _ast_mapping_has_fixture_db(value, True):
            return True
    return False


def _ast_inherits_caller_environment(node: ast.AST) -> bool:
    return any(
        isinstance(child, ast.Attribute)
        and child.attr in {"environ", "env"}
        and isinstance(child.value, ast.Name)
        and child.value.id in {"os", "process"}
        for child in ast.walk(node)
    )


def _ast_db_parameter(node: ast.AST) -> bool:
    names = {
        item.id.lower() if isinstance(item, ast.Name) else item.attr.lower()
        for item in ast.walk(node) if isinstance(item, (ast.Name, ast.Attribute))
    }
    return bool(names & {"db", "database", "db_path", "database_path"})


def _ast_db_flag(argv: Sequence[ast.AST], start: int) -> bool:
    for index in range(start, len(argv)):
        option = _ast_string(argv[index])
        if option == "--db" and index + 1 < len(argv) and _ast_path_is_fixture_db(argv[index + 1]):
            return True
        if option is not None and option.startswith("--db=") and ".beads" in option and "beads.db" in option:
            return True
    return False


def _ast_callee(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return ""


def _word_is_assignment(word: str) -> bool:
    key, separator, _ = word.partition("=")
    return bool(separator) and key.isidentifier()


def _shell_command_index(words: Sequence[str]) -> int:
    index = 0
    prefixes = {"if", "then", "else", "elif", "while", "until", "do", "!", "exec", "command", "env", "sudo"}
    while index < len(words) and words[index] in prefixes:
        index += 1
    while index < len(words) and _word_is_assignment(words[index]):
        index += 1
    return index


def _word_env_is_fixture_db(words: Sequence[str]) -> bool:
    for word in words:
        key, separator, value = word.partition("=")
        if separator and key == "BEADS_DB" and _path_is_fixture_db([value]):
            return True
    return False


def _word_db_flag(words: Sequence[str]) -> bool:
    for index, word in enumerate(words):
        if word == "--db" and index + 1 < len(words) and _path_is_fixture_db([words[index + 1]]):
            return True
        if word.startswith("--db=") and _path_is_fixture_db([word.partition("=")[2]]):
            return True
    return False


def _shell_words(source: str) -> Optional[List[str]]:
    try:
        return shlex.split(source, posix=True)
    except ValueError:
        return None


def _python_calls(source: bytes, path: str) -> core.Scan:
    parsed = core.py_source(source, path)
    hits = core.Hits()
    for node in ast.walk(parsed.tree):
        if not isinstance(node, ast.Call) or _ast_callee(node.func) not in PY_RUNNERS:
            continue
        name = _ast_callee(node.func)
        argv_node = node.args[0] if node.args else next(
            (keyword.value for keyword in node.keywords if keyword.arg in {"args", "cmd"}), None
        )
        if argv_node is None:
            continue
        argv = _ast_argv(argv_node)
        offset = 0
        is_wrapper = False
        if argv and len(argv) >= 2 and _ast_string(argv[0]) == "br" and _ast_string(argv[1]) == "init":
            offset = 2
        elif argv and len(argv) >= 2 and _ast_string(argv[0]) == "br":
            subcommand = _ast_string(argv[1])
            if subcommand not in {None, "--help", "--version"}:
                own_db = _ast_db_flag(argv, 1)
                own_env = any(_ast_mapping_has_fixture_db(keyword.value, True)
                              for keyword in node.keywords if keyword.arg == "env")
                if not (own_db or own_env):
                    hits.add(INHERITED_RULE, node.lineno, node.col_offset + 1, "br call")
            continue
        elif name == "brun" and argv and _ast_string(argv[0]) not in {None, "init"}:
            env_arg = (
                node.args[2] if len(node.args) > 2
                else next((keyword.value for keyword in node.keywords if keyword.arg == "env"), None)
            )
            env_is_unbound = (
                env_arg is None
                or _ast_inherits_caller_environment(env_arg)
                or (isinstance(env_arg, ast.Dict) and not _ast_mapping_has_fixture_db(env_arg, True))
            )
            if env_is_unbound:
                hits.add(INHERITED_RULE, node.lineno, node.col_offset + 1, "br call")
            continue
        elif argv and _ast_string(argv[0]) == "br" and len(node.args) > 1:
            second = _ast_argv(node.args[1])
            if second and _ast_string(second[0]) == "init":
                argv, offset, is_wrapper = second, 1, True
        elif name in WRAPPERS and argv and _ast_string(argv[0]) == "init":
            offset, is_wrapper = 1, True
        else:
            words = _shell_words(_ast_string(argv_node) or "")
            if words is None:
                continue
            command = _shell_command_index(words)
            if command + 1 >= len(words) or words[command].rsplit("/", 1)[-1] != "br":
                continue
            subcommand = words[command + 1]
            if subcommand == "init":
                own_env = _word_env_is_fixture_db(words[:command])
                own_db = _word_db_flag(words[command + 2:])
                explicit_env = any(_ast_mapping_has_fixture_db(keyword.value, True)
                                   for keyword in node.keywords if keyword.arg == "env")
                if not (own_env or own_db or explicit_env):
                    hits.add(RULE, node.lineno, node.col_offset + 1, "br init")
            elif subcommand not in {"--help", "--version"}:
                own_env = _word_env_is_fixture_db(words[:command])
                own_db = _word_db_flag(words[command + 1:])
                if not (own_env or own_db):
                    hits.add(INHERITED_RULE, node.lineno, node.col_offset + 1, "br call")
            continue
        if argv is None:
            continue
        own_db = _ast_db_flag(argv, offset)
        own_env = any(_ast_mapping_has_fixture_db(keyword.value, True)
                      for keyword in node.keywords if keyword.arg == "env")
        own_parameter = (name in {"runBr", "run_br"} and is_wrapper and len(node.args) > 1
                         and _ast_db_parameter(node.args[1]))
        if not (own_db or own_env or own_parameter):
            hits.add(RULE, node.lineno, node.col_offset + 1, "br init")
    return core.Scan(hits, parsed.texts(hits.lines()), [])


def _trim(code: str, start: int, end: int) -> Tuple[int, int]:
    while start < end and code[start].isspace():
        start += 1
    while end > start and code[end - 1].isspace():
        end -= 1
    return start, end


def _pairs(code: str) -> Dict[int, int]:
    opening = {"(": ")", "[": "]", "{": "}"}
    closing = {value: key for key, value in opening.items()}
    stack: List[Tuple[int, str]] = []
    pairs: Dict[int, int] = {}
    for index, char in enumerate(code):
        if char in opening:
            stack.append((index, char))
        elif char in closing and stack and stack[-1][1] == closing[char]:
            start, _ = stack.pop()
            pairs[start] = index
            pairs[index] = start
    return pairs


def _parts(code: str, start: int, end: int, pairs: Dict[int, int]) -> List[Tuple[int, int]]:
    start, end = _trim(code, start, end)
    if start == end:
        return []
    result: List[Tuple[int, int]] = []
    part = start
    index = start
    while index < end:
        if code[index] in "([{" and index in pairs and pairs[index] < end:
            index = pairs[index] + 1
            continue
        if code[index] == ",":
            result.append(_trim(code, part, index))
            part = index + 1
        index += 1
    result.append(_trim(code, part, end))
    return result


def _literal(strings: Dict[int, Tuple[str, int, bool]], span: Tuple[int, int]) -> Optional[str]:
    start, end = span
    value = strings.get(start)
    if value is not None and value[1] + 1 == end and not value[2]:
        return value[0]
    return None


def _span_has_fixture_db(strings: Dict[int, Tuple[str, int, bool]], span: Tuple[int, int]) -> bool:
    start, end = span
    return _path_is_fixture_db(
        value for offset, (value, closing, interpolated) in strings.items()
        if start <= offset and closing < end and not interpolated
    )


def _property(code: str, strings: Dict[int, Tuple[str, int, bool]], span: Tuple[int, int],
              pairs: Dict[int, int]) -> Optional[Tuple[str, Tuple[int, int]]]:
    start, end = span
    index = start
    while index < end:
        if code[index] in "([{" and index in pairs and pairs[index] < end:
            index = pairs[index] + 1
            continue
        if code[index] == ":":
            key_span = _trim(code, start, index)
            value_span = _trim(code, index + 1, end)
            return _literal(strings, key_span) or code[key_span[0]:key_span[1]], value_span
        index += 1
    return None


def _object_has_fixture_db(code: str, span: Tuple[int, int], pairs: Dict[int, int],
                           strings: Dict[int, Tuple[str, int, bool]], environment: bool = False) -> bool:
    start, end = _trim(code, *span)
    if start >= end or code[start] != "{" or pairs.get(start) != end - 1:
        return False
    for prop in _parts(code, start + 1, end - 1, pairs):
        parsed = _property(code, strings, prop, pairs)
        if parsed is None:
            continue
        key, value = parsed
        if key == "BEADS_DB" and environment and _span_has_fixture_db(strings, value):
            return True
        if key == "env" and _object_has_fixture_db(code, value, pairs, strings, True):
            return True
    return False


def _identifiers(code: str, span: Tuple[int, int]) -> Iterable[str]:
    start, end = span
    index = start
    while index < end:
        if code[index].isalpha() or code[index] in "_$":
            token_start = index
            index += 1
            while index < end and (code[index].isalnum() or code[index] in "_$"):
                index += 1
            yield code[token_start:index].lower()
        else:
            index += 1


def _js_identifier(code: str, start: int) -> Tuple[str, int]:
    index = start
    while index < len(code) and (code[index].isalnum() or code[index] in "_$"):
        index += 1
    return code[start:index], index


def _js_wrapper_environment_pinned(code: str, strings: Dict[int, Tuple[str, int, bool]],
                                   pairs: Dict[int, int], arguments: Sequence[Tuple[int, int]],
                                   argv_argument_index: int) -> bool:
    environment = argv_argument_index + 2
    if environment >= len(arguments):
        return False
    start, end = _trim(code, *arguments[environment])
    if code[start:start + 1] == "{":
        return _object_has_fixture_db(code, arguments[environment], pairs, strings, True)
    expression = "".join(code[start:end].split())
    if expression in {"process.env", "process.env.copy()", "os.environ", "os.environ.copy()", "undefined", "null"}:
        return False
    return True


def _js_pinned(code: str, strings: Dict[int, Tuple[str, int, bool]], pairs: Dict[int, int],
               arguments: Sequence[Tuple[int, int]], argv: Sequence[Tuple[int, int]], offset: int,
               name: str, wrapper: bool, argv_argument_index: int) -> bool:
    for index in range(offset, len(argv)):
        option = _literal(strings, argv[index])
        if option == "--db" and index + 1 < len(argv) and _span_has_fixture_db(strings, argv[index + 1]):
            return True
        if option is not None and option.startswith("--db=") and _path_is_fixture_db([option]):
            return True
    database_argument = argv_argument_index + 1
    if wrapper and name in {"runBr", "run_br"} and database_argument < len(arguments):
        if set(_identifiers(code, arguments[database_argument])) & {"db", "database", "db_path", "database_path"}:
            return True
    if wrapper and name == "brun" and _js_wrapper_environment_pinned(code, strings, pairs, arguments, argv_argument_index):
        return True
    return any(_object_has_fixture_db(code, extra, pairs, strings) for extra in arguments[argv_argument_index + 1:])



def _js_calls(source: bytes, path: str) -> core.Scan:
    text = source.decode("utf-8", "replace")
    code, bare, string_rows, comments = core.lex_js(text)
    strings = {start: (value, end, interpolated) for start, value, end, interpolated in string_rows}
    pairs = _pairs(code)
    where = core.js_locator(text)
    hits = core.Hits()
    index = 0
    while index < len(code):
        if not (code[index].isalpha() or code[index] in "_$"):
            index += 1
            continue
        start = index
        name, index = _js_identifier(code, start)
        if name not in JS_RUNNERS:
            continue
        opening = index
        while opening < len(code) and code[opening].isspace():
            opening += 1
        if opening >= len(code) or code[opening] != "(" or opening not in pairs:
            continue
        arguments = _parts(code, opening + 1, pairs[opening], pairs)
        if not arguments:
            continue
        first_start, first_end = _trim(code, *arguments[0])
        first_is_array = code[first_start:first_start + 1] == "[" and pairs.get(first_start) == first_end - 1
        argv: List[Tuple[int, int]] = []
        argv_argument_index = 0
        offset = 0
        wrapper = False
        rule = RULE
        if first_is_array:
            argv = _parts(code, first_start + 1, first_end - 1, pairs)
            if len(argv) >= 2 and _literal(strings, argv[0]) == "br" and _literal(strings, argv[1]) == "init":
                offset = 2
            elif len(argv) >= 2 and _literal(strings, argv[0]) == "br":
                subcommand = _literal(strings, argv[1])
                if subcommand not in {None, "--help", "--version"}:
                    offset, rule = 1, INHERITED_RULE
                else:
                    argv = []
            elif name == "brun" and argv and _literal(strings, argv[0]) not in {None, "init"}:
                wrapper, rule = True, INHERITED_RULE
            elif name in WRAPPERS and argv and _literal(strings, argv[0]) == "init":
                offset, wrapper = 1, True
            else:
                argv = []
        elif len(arguments) > 1 and _literal(strings, arguments[0]) == "br":
            second_start, second_end = _trim(code, *arguments[1])
            if code[second_start:second_start + 1] == "[" and pairs.get(second_start) == second_end - 1:
                argv = _parts(code, second_start + 1, second_end - 1, pairs)
                if argv and _literal(strings, argv[0]) == "init":
                    offset, wrapper, argv_argument_index = 1, True, 1
                else:
                    argv = []
        if argv:
            if not _js_pinned(code, strings, pairs, arguments, argv, offset, name, wrapper, argv_argument_index):
                line, column = where(start)
                hits.add(rule, line, column, "br init" if rule == RULE else "br call")
            continue
        command = _literal(strings, arguments[0])
        words = _shell_words(command or "") if name in {"exec", "execSync"} else None
        if words is None:
            continue
        command_index = _shell_command_index(words)
        if command_index + 1 >= len(words) or words[command_index].rsplit("/", 1)[-1] != "br":
            continue
        subcommand = words[command_index + 1]
        if subcommand == "init":
            rule = RULE
            own_db = _word_db_flag(words[command_index + 2:])
        elif subcommand not in {"--help", "--version"}:
            rule = INHERITED_RULE
            own_db = _word_db_flag(words[command_index + 1:])
        else:
            continue
        explicit_env = any(_object_has_fixture_db(code, extra, pairs, strings, True) for extra in arguments[1:])
        if not (_word_env_is_fixture_db(words[:command_index] or []) or own_db or explicit_env):
            line, column = where(start)
            hits.add(rule, line, column, "br init" if rule == RULE else "br call")
    scanned = core.js_scan(text, hits, bare, comments, where)
    return core.Scan(scanned.hits, scanned.texts, [])



def _split_shell(line: str) -> Optional[List[List[str]]]:
    try:
        lexer = shlex.shlex(line, posix=True, punctuation_chars=";&|()")
        lexer.whitespace_split = True
        lexer.commenters = ""
        tokens = list(lexer)
    except ValueError:
        return None
    commands: List[List[str]] = []
    current: List[str] = []
    for token in tokens:
        if token and all(char in ";&|()" for char in token):
            if current:
                commands.append(current)
                current = []
        else:
            current.append(token)
    if current:
        commands.append(current)
    return commands


def _backtick_end(source: str, start: int) -> Optional[int]:
    index = start + 1
    while index < len(source):
        if source[index] == "\\":
            index += 2
        elif source[index] == "`":
            return index
        else:
            index += 1
    return None


def _arithmetic_end(source: str, start: int) -> Optional[int]:
    depth = 2
    index = start + 3
    while index < len(source):
        if source[index] == "\\":
            index += 2
        elif source[index] == "(":
            depth += 1
            index += 1
        elif source[index] == ")":
            depth -= 1
            if depth == 0:
                return index
            index += 1
        else:
            index += 1
    return None


def _command_substitution_end(source: str, start: int, nesting: int = 0) -> Optional[int]:
    if nesting >= 32:
        return None
    depth = 1
    quote = ""
    index = start + 2
    while index < len(source):
        char = source[index]
        if quote == "'":
            if char == "'":
                quote = ""
            index += 1
            continue
        if quote == "$'":
            if char == "'":
                quote = ""
            elif char == "\\":
                index += 1
            index += 1
            continue
        if quote == '"':
            if char == "\\":
                index += 2
            elif char == '"':
                quote = ""
                index += 1
            elif source.startswith("$((", index):
                end = _arithmetic_end(source, index)
                if end is None:
                    return None
                index = end + 1
            elif source.startswith("$(", index):
                end = _command_substitution_end(source, index, nesting + 1)
                if end is None:
                    return None
                index = end + 1
            elif char == "`":
                end = _backtick_end(source, index)
                if end is None:
                    return None
                index = end + 1
            else:
                index += 1
            continue
        if source.startswith("$'", index):
            quote = "$'"
            index += 2
        elif char == "\\":
            index += 2
        elif char == "'":
            quote = "'"
            index += 1
        elif char == '"':
            quote = '"'
            index += 1
        elif source.startswith("$((", index):
            end = _arithmetic_end(source, index)
            if end is None:
                return None
            index = end + 1
        elif source.startswith("$(", index):
            end = _command_substitution_end(source, index, nesting + 1)
            if end is None:
                return None
            index = end + 1
        elif char == "(":
            depth += 1
            index += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return index
            index += 1
        elif char == "`":
            end = _backtick_end(source, index)
            if end is None:
                return None
            index = end + 1
        else:
            index += 1
    return None


def _shell_expansions(source: str, initial_quote: str) -> Tuple[List[str], str, Optional[str]]:
    expansions: List[str] = []
    quote = initial_quote
    index = 0
    while index < len(source):
        char = source[index]
        if quote == "'":
            if char == "'":
                quote = ""
            index += 1
            continue
        if quote == "$'":
            if char == "'":
                quote = ""
            elif char == "\\":
                index += 1
            index += 1
            continue
        if quote == '"':
            if char == "\\":
                index += 2
            elif char == '"':
                quote = ""
                index += 1
            elif source.startswith("$((", index):
                end = _arithmetic_end(source, index)
                if end is None:
                    return expansions, quote, "unclosed arithmetic expansion"
                index = end + 1
            elif source.startswith("$(", index):
                end = _command_substitution_end(source, index)
                if end is None:
                    return expansions, quote, "unclosed command substitution"
                expansions.append(source[index + 2:end])
                index = end + 1
            elif char == "`":
                end = _backtick_end(source, index)
                if end is None:
                    return expansions, quote, "unclosed backtick substitution"
                expansions.append(source[index + 1:end])
                index = end + 1
            else:
                index += 1
            continue
        if source.startswith("$'", index):
            quote = "$'"
            index += 2
        elif char == "\\":
            index += 2
        elif char == "'":
            quote = "'"
            index += 1
        elif char == '"':
            quote = '"'
            index += 1
        elif source.startswith("$((", index):
            end = _arithmetic_end(source, index)
            if end is None:
                return expansions, quote, "unclosed arithmetic expansion"
            index = end + 1
        elif source.startswith("$(", index):
            end = _command_substitution_end(source, index)
            if end is None:
                return expansions, quote, "unclosed command substitution"
            expansions.append(source[index + 2:end])
            index = end + 1
        elif char == "`":
            end = _backtick_end(source, index)
            if end is None:
                return expansions, quote, "unclosed backtick substitution"
            expansions.append(source[index + 1:end])
            index = end + 1
        else:
            index += 1
    return expansions, quote, None


def _mask_escaped_substitutions(source: str) -> str:
    chars = list(source)
    quote = ""
    index = 0
    while index < len(source):
        char = source[index]
        if quote == "'":
            if char == "'":
                quote = ""
            index += 1
            continue
        if quote == "$'":
            if char == "'":
                quote = ""
            elif char == "\\":
                index += 1
            index += 1
            continue
        if quote == '"':
            if char == "\\":
                if index + 2 < len(source) and source[index + 1] == "$" and source[index + 2] == "(":
                    end = _command_substitution_end(source, index + 1)
                    stop = len(source) if end is None else end + 1
                    chars[index:stop] = [" "] * (stop - index)
                    index = stop
                else:
                    index += 2
            elif char == '"':
                quote = ""
                index += 1
            else:
                index += 1
            continue
        if char == "\\":
            if index + 2 < len(source) and source[index + 1] == "$" and source[index + 2] == "(":
                end = _command_substitution_end(source, index + 1)
                stop = len(source) if end is None else end + 1
                chars[index:stop] = [" "] * (stop - index)
                index = stop
            else:
                index += 2
        elif source.startswith("$'", index):
            quote = "$'"
            index += 2
        elif char == "'":
            quote = "'"
            index += 1
        elif char == '"':
            quote = '"'
            index += 1
        else:
            index += 1
    return "".join(chars)


def _shell_line_continues(line: str, quote: str) -> bool:
    if quote == "'":
        return False
    trailing_backslashes = 0
    for char in reversed(line):
        if char != "\\":
            break
        trailing_backslashes += 1
    return trailing_backslashes % 2 == 1


def _scan_shell_line(line: str, number: int, hits: core.Hits) -> None:
    commands = _split_shell(_mask_escaped_substitutions(line))
    if commands is None:
        return
    for words in commands:
        command = _shell_command_index(words)
        if command + 1 >= len(words) or words[command].rsplit("/", 1)[-1] != "br":
            continue
        subcommand = words[command + 1]
        if subcommand == "init":
            rule = RULE
            own_db = _word_db_flag(words[command + 2:])
        elif subcommand not in {"--help", "--version"}:
            rule = INHERITED_RULE
            own_db = _word_db_flag(words[command + 1:])
        else:
            continue
        if _word_env_is_fixture_db(words[:command]) or own_db:
            continue
        hits.add(rule, number, max(1, line.find(words[command]) + 1), "br init" if rule == RULE else "br call")


def _scan_shell_expansions(source: str, number: int, hits: core.Hits, initial_quote: str,
                           work: List[int]) -> str:
    max_work = core.MAX_FILE_BYTES * 4
    max_depth = 32
    work[0] += len(source)
    if work[0] > max_work:
        hits.add("parse-error", number, 1, "shell expansion work limit exceeded")
        return initial_quote
    expansions, quote, error = _shell_expansions(source, initial_quote)
    if error is not None:
        hits.add("parse-error", number, 1, error)
        return quote
    pending = [(expansion, 1) for expansion in expansions]
    while pending:
        expression, depth = pending.pop()
        work[0] += len(expression)
        if work[0] > max_work:
            hits.add("parse-error", number, 1, "shell expansion work limit exceeded")
            break
        _scan_shell_line(expression, number, hits)
        nested, _, nested_error = _shell_expansions(expression, "")
        if nested_error is not None:
            hits.add("parse-error", number, 1, nested_error)
        elif depth >= max_depth and nested:
            hits.add("parse-error", number, 1, "shell expansion nesting limit exceeded")
        else:
            pending.extend((child, depth + 1) for child in nested)
    return quote


def _shell_calls(source: bytes, path: str) -> core.Scan:
    del path
    quote = [""]
    physical_quote = [""]
    pending_code: List[str] = []
    pending_line = [0]
    pending_quote = [""]
    continued_first_lines: Dict[int, str] = {}
    work = [0]

    def scan_code(code: str, number: int, initial_quote: str, hits: core.Hits) -> None:
        if initial_quote == "":
            _scan_shell_line(code, number, hits)
        quote[0] = _scan_shell_expansions(code, number, hits, initial_quote, work)

    def on_code(code: str, number: int, hits: core.Hits) -> None:
        _, _, next_quote, heredocs = core.sh_line(code, physical_quote[0])
        physical_quote[0] = next_quote
        continues = _shell_line_continues(code, next_quote)
        if continues and heredocs:
            hits.add("parse-error", number, 1, "continued heredoc command")

        if pending_code:
            pending_code.append(code[:-1] if continues else code)
            if continues:
                return
            scan_code("".join(pending_code), pending_line[0], pending_quote[0], hits)
            pending_code.clear()
        elif continues:
            continued_first_lines[number] = code
            pending_code.append(code[:-1])
            pending_line[0] = number
            pending_quote[0] = quote[0]
        else:
            scan_code(code, number, quote[0], hits)

    def on_heredoc(line: str, number: int, hits: core.Hits) -> None:
        if "$(" in line or "`" in line:
            _scan_shell_expansions(line, number, hits, "", work)

    scanned = core.scan_sh(source.decode("utf-8", "replace"), on_code, on_heredoc)
    if pending_code:
        scanned.hits.add("parse-error", pending_line[0], 1, "line continuation at end of file")
    for number in scanned.hits.lines():
        if number not in scanned.texts and number in continued_first_lines:
            scanned.texts[number] = continued_first_lines[number]
    return core.Scan(scanned.hits, scanned.texts, [])


RULESET = core.RuleSet(
    prog="br_init_check",
    description="Refuse unpinned fixture br initialization and inherited calls",
    pragma=PRAGMA,
    rules=RULES,
    exempt=EXEMPT,
    scanners={"py": _python_calls, "ts": _js_calls, "sh": _shell_calls},
    detail=_detail,
)
language = core.language
is_exempt = RULESET.is_exempt
check_source = RULESET.check_source
check_file = RULESET.check_file
ratchet = RULESET.ratchet
main = RULESET.main

if __name__ == "__main__":
    core.pysafe.run_main(main)
