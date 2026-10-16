#!/usr/bin/env python3
"""Preserve a complete native BR snapshot; never certify its authorship.

The commit candidate must equal the working export, which must exactly match
native state in two fresh read-only v2 reconciliation plans. No supplied receipt,
PATH override, comment author, created_by or assignee is an authority input.
The installed caller pins this file and the native executable by SHA-256.

This gate is a point-in-time preservation check, not a cross-process writer lock,
a creation/grading certificate, or permission to change the tracker. Native writes
and their own identity/policy guards remain separate. No SQLite client, export,
import, filesystem mutation, temporary source copy or Git mutation is performed.

Usage: native-br-preserve.py --repo REPO --native-br ABS --native-br-sha256 SHA
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

TRACKER = ".beads/issues.jsonl"
SCHEMA = "br.sync.additive-reconciliation.v2"
ALGORITHM = "exact-id-additive-create-monotonic-closure-explicit-scalar-v2"
STATE_FIELDS = frozenset("""
issues issue_payload_sha256 issue_semantic_payload_sha256 issue_content_hashes
issue_content_hash_payload_sha256 relations label_payload_sha256
dependency_payload_sha256 comment_payload_sha256 export_hashes
export_hash_payload_sha256 events event_payload_sha256 dirty_issues
dirty_payload_sha256 metadata_rows metadata_payload_sha256 stable_metadata
blocked_cache_entries blocked_cache_payload_sha256 child_counter_entries
child_counter_payload_sha256 config close_metadata gate_results
gate_result_history schema_catalog sqlite_sequence stored_jsonl_content_hash
stored_jsonl_mtime stored_jsonl_size needs_flush
""".split())
ZERO_FIELDS = """
created updated conflicted conflict_occurrences deleted db_only_preserved
skipped_ephemeral content_hash_repairs_planned content_hash_repairs_applied
export_hash_updates_planned export_hashes_updated dirty_markers_clear_planned
dirty_markers_cleared new_blocking_cycles
""".split()
EMPTY_FIELDS = """
postcommit_failures created_issue_ids updated_issue_ids
requested_source_authoritative_issue_ids source_authoritative_issue_ids
scalar_updates content_hash_repairs content_hash_repair_issue_ids
db_only_issue_ids conflict_issue_ids conflict_witnesses conflict_scalar_diffs
conflict_relation_diffs comment_id_remaps
""".split()
FALSE_FIELDS = """
conflict_issue_ids_truncated cache_rebuild_planned cache_rebuild_performed
metadata_update_planned metadata_changed jsonl_written base_snapshot_used
merge_note_written
""".split()


class Refusal(Exception):
    """A named refusal, without dumping private tracker text or subprocess output."""


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def unique_pairs(pairs: list[tuple]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise Refusal("DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def bad_constant(_value: str) -> None:
    raise Refusal("NONFINITE_JSON_NUMBER")


def decode(data: bytes) -> object:
    try:
        return json.loads(data, object_pairs_hook=unique_pairs, parse_constant=bad_constant)
    except (UnicodeError, ValueError) as exc:
        raise Refusal("INVALID_JSON") from exc


def rows(data: bytes) -> dict[str, dict]:
    result = {}
    for line in data.splitlines():
        if not line.strip():
            continue
        row = decode(line)
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]:
            raise Refusal("INVALID_ISSUE_ID")
        if row["id"] in result:
            raise Refusal("DUPLICATE_ISSUE_ID")
        result[row["id"]] = row
    return result


def run(argv: list[str], repo: Path, env: dict) -> bytes:
    try:
        process = subprocess.run(argv, cwd=repo, env=env, capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Refusal("READ_UNAVAILABLE") from exc
    if process.returncode:
        # Native malformed/unknown-field/conflict refusals stay refusals. Their
        # raw diagnostic may contain tracker text and is deliberately not echoed.
        raise Refusal("READ_REFUSED_" + str(process.returncode))
    return process.stdout


def git(repo: Path, env: dict, *args: str) -> bytes:
    return run(["git", "-C", str(repo), *args], repo, env)


def checked_native(path: Path, expected: str) -> None:
    if len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected):
        raise Refusal("INVALID_NATIVE_DIGEST")
    if not path.is_absolute() or not path.is_file() or not os.access(path, os.X_OK):
        raise Refusal("NATIVE_EXECUTABLE_UNAVAILABLE")
    if file_sha(path) != expected:
        raise Refusal("NATIVE_EXECUTABLE_CHANGED")


def comments(row: dict) -> Counter:
    values = row.get("comments", [])
    if not isinstance(values, list) or any(not isinstance(c, dict) for c in values):
        raise Refusal("INVALID_COMMENTS")
    # Historical storage ids may have been rebased by native reconciliation.
    # Preserve every original author/text/time occurrence, never route authority
    # from it. The current native plan separately checks current storage ids.
    return Counter(json.dumps([c.get(k) for k in ("author", "text", "created_at")],
                              ensure_ascii=True, sort_keys=True) for c in values)


def retain_history(old: dict[str, dict], candidate: dict[str, dict]) -> None:
    if old.keys() - candidate.keys():
        raise Refusal("ORIGINAL_RECORD_OR_TOMBSTONE_MISSING")
    for ident, original in old.items():
        current = candidate[ident]
        if original.get("acceptance_criteria") and not current.get("acceptance_criteria"):
            raise Refusal("ORIGINAL_ACCEPTANCE_LOST")
        if comments(original) - comments(current):
            raise Refusal("ORIGINAL_COMMENT_LOST_OR_CHANGED")


def plan_matches(plan: object, repo: Path, candidate: dict[str, dict], digest: str) -> dict:
    if not isinstance(plan, dict) or plan.get("schema") != SCHEMA or plan.get("algorithm") != ALGORITHM:
        raise Refusal("UNSUPPORTED_NATIVE_WITNESS")
    if plan.get("status") != "no_changes":
        raise Refusal("NATIVE_STATE_NOT_EXACT")
    if plan.get("source_raw_sha256") != digest or plan.get("source_content_sha256") != digest:
        raise Refusal("NATIVE_SOURCE_CHANGED")
    for key, expected in (("source_path", TRACKER), ("database_path", ".beads/beads.db"),
                          ("workspace_path", ".beads")):
        value = plan.get(key)
        if not isinstance(value, str) or (repo / value).resolve() != (repo / expected).resolve():
            raise Refusal("NATIVE_WORKSPACE_MISMATCH")
    equal = plan.get("equal_issue_ids")
    if not isinstance(equal, list) or any(not isinstance(i, str) for i in equal):
        raise Refusal("NATIVE_ID_WITNESS_INCOMPLETE")
    if len(equal) != len(candidate) or set(equal) != candidate.keys():
        raise Refusal("NATIVE_ID_WITNESS_MISMATCH")
    for key in ("source_issues", "skipped_equal", "synchronized"):
        if type(plan.get(key)) is not int or plan[key] != len(candidate):
            raise Refusal("NATIVE_RECORD_COUNT_MISMATCH")
    for key in ZERO_FIELDS:
        if type(plan.get(key)) is not int or plan[key] != 0:
            raise Refusal("NATIVE_NONZERO_" + key.upper())
    if any(plan.get(key) != [] for key in EMPTY_FIELDS):
        raise Refusal("NATIVE_RELATION_OR_SCALAR_CHANGE")
    if any(plan.get(key) is not False for key in FALSE_FIELDS):
        raise Refusal("NATIVE_WRITE_OR_INCOMPLETE_WITNESS")
    if plan.get("conflict_reasons") != {}:
        raise Refusal("NATIVE_CONFLICT")
    before, after = plan.get("target_before"), plan.get("expected_target_after")
    if not isinstance(before, dict) or not isinstance(after, dict) or not STATE_FIELDS <= before.keys():
        raise Refusal("NATIVE_STATE_WITNESS_INCOMPLETE")
    if before != after or type(before.get("issues")) is not int or before["issues"] != len(candidate):
        raise Refusal("NATIVE_FULL_STATE_CHANGED")
    relation_counts = {key: sum(len(row.get(key, [])) for row in candidate.values())
                       for key in ("labels", "dependencies", "comments")}
    if before.get("relations") != relation_counts or plan.get("relations_before") != relation_counts or plan.get("relations_after") != relation_counts:
        raise Refusal("NATIVE_RELATION_WITNESS_MISMATCH")
    if plan.get("relation_rows_planned") != dict.fromkeys(relation_counts, 0) or plan.get("relation_rows_applied") != dict.fromkeys(relation_counts, 0):
        raise Refusal("NATIVE_RELATION_WRITE")
    if plan.get("health_before") != {"integrity_messages": ["ok"], "foreign_key_violations": []}:
        raise Refusal("NATIVE_HEALTH_UNAVAILABLE")
    token = plan.get("plan_sha256")
    if not isinstance(token, str) or len(token) != 64 or any(c not in "0123456789abcdef" for c in token):
        raise Refusal("NATIVE_PLAN_TOKEN_INVALID")
    return plan


def preserve(repo: Path, native: Path, native_digest: str) -> dict:
    env = dict(os.environ)
    # Git keeps its real GIT_INDEX_FILE (including commit --only's index).
    # Native BR gets explicit repository/database/export identity instead of
    # inheriting a different seat's BEADS_DB or BEADS_JSONL.
    env.pop("BEADS_DB", None)
    env["BEADS_JSONL"] = str(repo / TRACKER)
    root = Path(os.fsdecode(git(repo, env, "rev-parse", "--show-toplevel")).strip()).resolve()
    if root != repo:
        raise Refusal("GIT_WORKSPACE_MISMATCH")
    changed = git(repo, env, "diff", "--cached", "--name-only", "--", TRACKER).strip()
    if not changed:
        return {"status": "SKIPPED", "reason": "NO_STAGED_TRACKER_CHANGE"}
    source, database = repo / TRACKER, repo / ".beads/beads.db"
    if (repo / ".beads").is_symlink() or source.is_symlink() or database.is_symlink() or not database.is_file():
        raise Refusal("NONCANONICAL_NATIVE_PATH")
    checked_native(native, native_digest)
    head = git(repo, env, "rev-parse", "--verify", "HEAD").strip()
    candidate_bytes = git(repo, env, "show", ":" + TRACKER)
    if source.read_bytes() != candidate_bytes:
        raise Refusal("WORKING_EXPORT_DIFFERS_FROM_INDEX")
    candidate = rows(candidate_bytes)
    old_bytes = (git(repo, env, "show", "HEAD:" + TRACKER)
                 if git(repo, env, "ls-tree", "-z", "HEAD", "--", TRACKER) else b"")
    retain_history(rows(old_bytes), candidate)
    digest = sha(candidate_bytes)
    argv = [str(native), "--db", str(database), "--no-auto-import", "--no-auto-flush",
            "sync", "--reconcile-additive", "--dry-run", "--json"]
    first = plan_matches(decode(run(argv, repo, env)), repo, candidate, digest)
    second = plan_matches(decode(run(argv, repo, env)), repo, candidate, digest)
    if first != second:
        raise Refusal("NATIVE_CHANGED_DURING_CHECK")
    if source.read_bytes() != candidate_bytes or git(repo, env, "show", ":" + TRACKER) != candidate_bytes:
        raise Refusal("SOURCE_CHANGED_DURING_CHECK")
    if git(repo, env, "rev-parse", "--verify", "HEAD").strip() != head:
        raise Refusal("HEAD_CHANGED_DURING_CHECK")
    checked_native(native, native_digest)
    return {"status": "PRESERVED", "scope": "NATIVE_SNAPSHOT_ONLY",
            "creation_authority": "NOT_ESTABLISHED", "grading_authority": "NOT_ESTABLISHED",
            "attribution": "UNKNOWN", "records": len(candidate), "head": head.decode("ascii"),
            "head_source_sha256": sha(old_bytes), "source_sha256": digest,
            "native_plan_sha256": first["plan_sha256"], "native_sha256": native_digest}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--native-br", required=True)
    parser.add_argument("--native-br-sha256", required=True)
    args = parser.parse_args(argv)
    try:
        result = preserve(Path(args.repo).resolve(), Path(args.native_br), args.native_br_sha256)
    except (Refusal, OSError, UnicodeError, TypeError, ValueError) as exc:
        reason = str(exc) if isinstance(exc, Refusal) else "READ_OR_SHAPE_UNAVAILABLE"
        print(json.dumps({"status": "REFUSED", "reason": reason}), file=sys.stderr)
        return 4
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
