#!/usr/bin/env python3
"""Static literal shell invocation graph; never execute a repo's gates or call CI."""
from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
from fnmatch import fnmatchcase
import json
import os
from pathlib import Path, PurePosixPath
import shlex
import sys

POLICY = ".omp/gate-wiring.json"
CATEGORIES = ("unwired", "unreachable", "expired_quarantine")
IGNORED = {".git", "node_modules", "var", "dist", "build", "vendor", "coverage"}
MAX_FILES = 20000
MAX_BYTES = 1024 * 1024
MAX_TOTAL_BYTES = 16 * MAX_BYTES


def unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate policy key: {key}")
        result[key] = value
    return result


def relative(value: object) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError(f"invalid repo-relative path: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or str(path) != value:
        raise ValueError(f"invalid repo-relative path: {value!r}")
    return value


def read_text(path: Path) -> str:
    with path.open("rb") as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError(f"file exceeds {MAX_BYTES} bytes: {path}")
    return data.decode("utf-8")


def load_policy(path: Path) -> dict:
    policy = json.loads(read_text(path), object_pairs_hook=unique_object)
    if not isinstance(policy, dict) or set(policy) != {"version", "gate_globs", "entrypoints", "thresholds", "quarantines"}:
        raise ValueError("policy requires version, gate_globs, entrypoints, thresholds, quarantines only")
    if type(policy["version"]) is not int or policy["version"] != 1:
        raise ValueError("policy version must be 1")
    for key in ("gate_globs", "entrypoints"):
        values = policy[key]
        if not isinstance(values, list) or not values:
            raise ValueError(f"{key} must be a nonempty path list")
        for value in values:
            relative(value)
        if len(set(values)) != len(values):
            raise ValueError(f"duplicate {key}")
    thresholds = policy["thresholds"]
    if not isinstance(thresholds, dict) or set(thresholds) != set(CATEGORIES):
        raise ValueError(f"thresholds must contain exactly {CATEGORIES}")
    for key, value in thresholds.items():
        if type(value) is not int or value < 0:
            raise ValueError(f"threshold {key} must be a nonnegative integer")
    if not isinstance(policy["quarantines"], dict):
        raise ValueError("quarantines must be an object keyed by gate path")
    for gate, record in policy["quarantines"].items():
        relative(gate)
        if not isinstance(record, dict) or set(record) != {"owner", "reason", "expires_on"}:
            raise ValueError(f"quarantine {gate} requires owner, reason, expires_on only")
        if any(not isinstance(value, str) or not value.strip() for value in record.values()):
            raise ValueError(f"quarantine {gate} fields must be nonempty strings")
        expiry = date.fromisoformat(record["expires_on"])
        if expiry.isoformat() != record["expires_on"]:
            raise ValueError(f"quarantine {gate} requires YYYY-MM-DD expiry")
    return policy


def inventory(root: Path) -> dict[str, Path]:
    files = {}
    for directory, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(name for name in dirs if name not in IGNORED and not (Path(directory) / name).is_symlink())
        for name in sorted(names):
            path = Path(directory) / name
            if path.is_symlink():
                continue
            files[path.relative_to(root).as_posix()] = path
            if len(files) > MAX_FILES:
                raise ValueError(f"inventory exceeds {MAX_FILES} files")
    return files


def invocation(words: list[str]) -> str | None:
    # Only command positions count: echo, printf, test, comments and arbitrary
    # arguments containing a script name cannot manufacture a consumer.
    prefixes = {"exec", "command", "env"}
    while words and (words[0] in prefixes or ("=" in words[0] and not words[0].startswith("/"))):
        words = words[1:]
    if not words:
        return None
    command = words[0]
    if Path(command).name in {"sh", "bash", "dash", "zsh", "python3", "python", "node", "bun", ".", "source"}:
        words = words[1:]
        while words and words[0].startswith("-"):
            # Inline programs are not paths. Never count their string arguments.
            if words[0] in {"-c", "-e", "--eval", "-m"}:
                return None
            words = words[1:]
        if not words:
            return None
        command = words[0]
    if command.startswith("./"):
        command = command[2:]
    if "/" not in command or "$" in command or "`" in command:
        return None
    return relative(command)


def consumers(source: str) -> set[str]:
    # shlex owns quoting, escapes and comments. This is deliberately a
    # straight-line shell subset, not an approximate parser for compound shell.
    lexer = shlex.shlex(source, posix=True, punctuation_chars=";&|()<>\n")
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    commands = []
    words = []
    for token in lexer:
        if token and all(char in ";\n" for char in token) and ";;" not in token:
            if words:
                commands.append(words)
            words = []
        elif token and all(char in ";&|()<>\n" for char in token):
            raise ValueError(f"unsupported shell operator: {token!r}")
        else:
            words.append(token)
    if words:
        commands.append(words)
    result = set()
    stopped = False
    for words in commands:
        if words[0] in {"if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "function", "{", "}"}:
            raise ValueError(f"unsupported compound shell command: {words[0]}")
        if any("$" in word or "`" in word for word in words):
            raise ValueError("dynamic shell expansion cannot prove static wiring")
        if stopped:
            continue
        if words[0] in {"exit", "return"}:
            stopped = True
            continue
        target = invocation(words)
        if target:
            result.add(target)
        if words[0] == "exec":
            stopped = True
    return result


def audit(root: Path, policy: dict) -> tuple[dict[str, list[str]], dict[str, int]]:
    files = inventory(root)
    gates = sorted(name for name in files if any(fnmatchcase(name, pattern) for pattern in policy["gate_globs"]))
    sources = sorted(name for name in files if name.endswith(".sh") or name in policy["entrypoints"])
    for entry in policy["entrypoints"]:
        if entry not in files:
            raise ValueError(f"entrypoint missing or symlinked: {entry}")
    graph = {}
    errors = {}
    total = 0
    for name in sources:
        source = read_text(files[name])
        total += len(source.encode("utf-8"))
        if total > MAX_TOTAL_BYTES:
            raise ValueError(f"shell sources exceed {MAX_TOTAL_BYTES} bytes")
        try:
            graph[name] = consumers(source)
        except ValueError as error:
            errors[name] = str(error)
            graph[name] = set()
    reachable = set()
    pending = list(policy["entrypoints"])
    while pending:
        current = pending.pop()
        if current in reachable:
            continue
        reachable.add(current)
        # Gate bodies are terminal checks, not chain roots. Their own control
        # flow does not establish another gate's wiring.
        if current in errors and current not in gates:
            raise ValueError(f"cannot parse reachable shell source {current}: {errors[current]}")
        if current not in gates:
            pending.extend(target for target in graph.get(current, ()) if target in files)
    referenced = set().union(*graph.values()) if graph else set()
    findings = {key: [] for key in CATEGORIES}
    today = datetime.now(timezone.utc).date()
    for gate in gates:
        quarantine = policy["quarantines"].get(gate)
        if quarantine:
            if date.fromisoformat(quarantine["expires_on"]) < today:
                findings["expired_quarantine"].append(gate)
        elif gate not in reachable:
            findings["unreachable" if gate in referenced else "unwired"].append(gate)
    counts = {key: len(findings[key]) for key in CATEGORIES}
    return findings, counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--policy-root", type=Path)
    args = parser.parse_args()
    root = args.repo.resolve(strict=True)
    policy_root = (args.policy_root or root).resolve(strict=True)
    try:
        candidate_path = root / POLICY
        policy_path = policy_root / POLICY
        if not policy_path.exists():
            policy_path = candidate_path
            policy_root = root
        if not policy_path.exists():
            print(f"SKIP gate-wiring: {POLICY} not configured; no wiring judgment")
            return 0
        if (not candidate_path.is_file() or candidate_path.is_symlink() or policy_path.is_symlink()
                or not candidate_path.resolve().is_relative_to(root)
                or not policy_path.resolve().is_relative_to(policy_root)):
            raise ValueError(f"configured policy missing or symlinked: {POLICY}")
        policy = load_policy(policy_path)
        candidate = load_policy(candidate_path)
        # Retiring a quarantine restores the real wiring check immediately.
        # Retained exceptions cannot gain time on the push that extends them.
        # A newly added exception must not hide incumbent wiring debt, but its
        # expiry is still judged on the push that introduces it.
        incumbent_quarantines = policy["quarantines"]
        candidate_quarantines = candidate["quarantines"]
        effective = {gate: record for gate, record in incumbent_quarantines.items()
                     if gate in candidate_quarantines}
        today = datetime.now(timezone.utc).date()
        for gate, record in candidate_quarantines.items():
            expiry = date.fromisoformat(record["expires_on"])
            incumbent = incumbent_quarantines.get(gate)
            if ((incumbent and expiry < date.fromisoformat(incumbent["expires_on"]))
                    or (not incumbent and expiry < today)):
                effective[gate] = record
        policy = {**policy, "quarantines": effective}
        findings, counts = audit(root, policy)
        print("gate-wiring counts=" + json.dumps(counts, sort_keys=True) + " thresholds=" + json.dumps(policy["thresholds"], sort_keys=True))
        failed = False
        for category in CATEGORIES:
            if counts[category] > policy["thresholds"][category]:
                failed = True
                for gate in findings[category]:
                    print(f"RED gate-wiring {category}: {gate}")
        if not failed:
            print("GREEN gate-wiring: configured static thresholds satisfied")
        return int(failed)
    except (OSError, UnicodeError, ValueError) as error:
        print(f"RED gate-wiring invalid: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
