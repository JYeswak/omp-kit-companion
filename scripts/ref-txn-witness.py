#!/usr/bin/env python3
"""ref-txn-witness.py — reviewed history-transform witness (HISTADMIT1, ompkit-2w7h.3).

ref-txn-bead.sh judges every commit a main update gains by its message. A
reviewed history scrub rewrites old id-less commits, so each rewritten
counterpart looks new, and the guard used to judge thousands of them until the
history helper's 30 s prepare deadline expired (GIT_REF_TRANSACTION_TIMEOUT,
2026-10-17). This reader is the guard's only route for such a transform. It
admits the prepared transaction only when all three of these agree exactly:

1. The owned operation context the history helper records before Git prepares:
   the owner record in <gitdir>/index.lock, PREPARE_INTENT and
   GIT_CHILD_STARTED in <plan>.events.jsonl, and this hook running under that
   very Git child. This is context only; it never admits by itself.
2. The immutable reviewed plan the lock names, whose digest binds it.
3. An independent review record at
   <git-common-dir>/omp-kit/history-review/<plan_sha256>.json: read-only,
   single-link, self-digested, written by `review` from a reviewer who is not
   the applier. It binds repository, ref, old and new tips, source roots, the
   full map digest, the path and signature policy and the complete transaction.

The reader then re-derives the transform from the Git objects: the map covers
exactly the commits reachable from the reviewed source roots, every parent maps
consistently, every rewritten commit is its old commit byte for byte except the
tree, parent and (dropped) signature lines, and every tree differs from its old
tree only by deleting the allowed paths. It prints the commits the main update
gains that are not mapped counterparts; the guard judges those with the
unchanged ordinary check. No environment variable, origin ref or journal is
authority. Like the helper's owner lock, this is a cooperation boundary: a
same-UID writer can forge every file it reads.

  python3 ref-txn-witness.py admit < transaction-lines      (the guard, prepared state)
  python3 ref-txn-witness.py review --plan PATH --reviewer NAME --approval-message-id ID --approval-file PATH
  python3 ref-txn-witness.py push-admit LOCAL_SHA REMOTE_REF REMOTE_SHA -- REV-LIST-ARGS...

PUSHADMIT1 (ompkit-fp72.120.16.221): pre-push members 40 (pushed-beads) and 41 (pushed-vlevel) use
push-admit. `review` stores the reviewed plan bytes read-only beside its record, as
history-review/<plan_sha256>.plan.json, so a member finds the plan from the pushed tip alone (a copy whose
new_tip is the tip or its ancestor), never from a caller variable. The push is admitted only when the tip
is that new_tip, the remote sha is the plan's public main root (a moved origin is a stale lease), local main
already equals the new root, every preservation ref holds its original, the review record verifies with the
unchanged binding, and its reviewer is not the pusher (AGENT_NAME, required). The member then judges its own
range minus the mapped counterparts with its ordinary check. Without a claiming plan copy the member's
ordinary check runs unchanged.

HISTQUIESCE1 part 3 (ompkit-fp72.120.16.222): the reviewer is bound to the APPROVE it relies on. `review`
requires --approval-message-id and --approval-file: the Agent Mail message exported as JSON (its "id",
"from", "subject" and "body_md" fields). `review`, an operator command, refuses unless the id matches, the
sender equals the reviewer and the subject or body names APPROVE and the plan_sha256. It stores the exact
bytes read-only as history-review/<plan_sha256>.approval.json and binds approval_message_id and
approval_sha256 into the self-digested record. admit and push-admit share check_review, which re-verifies
the copy offline: its sha256 equals the recorded one and its content passes the same test. No hook ever
calls Agent Mail. Every plan requires an approval. A record written before this change (schema v1, without
approval fields) fails closed as REVIEW_APPROVAL_ABSENT; re-run `review` for it.
"""
from __future__ import annotations

import hashlib
import json
import os
import stat
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pysafe  # noqa: E402  (cancel-safe spawn: own process group, stdin DEVNULL, hard deadline)

SCHEMA = "omp-kit.history-review.v2"
LEGACY_SCHEMA = "omp-kit.history-review.v1"  # pre-approval records: refused, never admitted
OPERATIONS = ("scrub-dag-v1",)
LOCK_OPERATION = "history-remove"
SIGNATURE_POLICY = "invalidate-pgp-ssh-preserve-originals"
ROOT_PREFIXES = ("refs/heads/", "refs/notes/", "refs/backup/")
MAIN = "refs/heads/main"
# Below the history helper's 30 s wait for Git's prepare acknowledgment.
DEADLINE = time.monotonic() + 25
GIT_CAP = 512 << 20
FILE_CAP = 256 << 20
PLAN_KEYS = ("schema_version", "operation", "repo", "gitdir", "old_tip", "new_tip", "paths", "map",
             "public_refs", "authority", "preserve_ref", "signature_policy", "writable_refs", "plan_sha256")
PLAN_SUFFIX = ".plan.json"
APPROVAL_SUFFIX = ".approval.json"
APPROVAL_CAP = 1 << 20
BINDING_KEYS = ("operation", "plan_sha256", "repo", "gitdir", "ref", "old_tip", "new_tip", "map_sha256",
                "source_roots", "paths", "signature_policy", "transaction", "authority")
RECORD_KEYS = frozenset(BINDING_KEYS + ("schema", "reviewer", "reviewed_at", "approval_message_id",
                                        "approval_sha256", "record_sha256"))
# HISTPREP1 record contracts, as history_remove_apply.py writes them (ompkit-fp72.120.14.1): the owner
# lock body, every journal record's common fields, and the two phases recorded before Git prepares.
# Exact key sets: a helper or reader change that drifts refuses instead of silently matching.
LOCK_FIELDS = frozenset({"operation", "pid", "process_start", "nonce", "plan_sha256", "map"})
JOURNAL_FIELDS = frozenset({"schema_version", "phase", "pid", "actor", "at"})
INTENT_FIELDS = JOURNAL_FIELDS | {"plan_sha256", "operation", "repo", "gitdir", "transaction", "expected_tip",
                                  "recover", "index_before_sha256", "index_after_sha256", "targets_before",
                                  "owner_lock_sha256"}
CHILD_FIELDS = JOURNAL_FIELDS | {"plan_sha256", "child_pid", "child_pgid", "child_start", "owner_pid"}


class Refused(Exception):
    """A failed witness prerequisite; the transaction must not proceed."""


def run(argv: list, data: bytes | None = None) -> bytes:
    remaining = DEADLINE - time.monotonic()
    if remaining <= 0:
        raise Refused("WITNESS_DEADLINE_EXCEEDED")
    env = {**os.environ, "GIT_NO_REPLACE_OBJECTS": "1", "GIT_NO_LAZY_FETCH": "1", "GIT_TERMINAL_PROMPT": "0"}
    result = pysafe.run_bounded(argv, timeout=remaining, input=data, cap_bytes=GIT_CAP, env=env)
    if result.outcome != pysafe.OK:
        raise Refused("WITNESS_DEADLINE_EXCEEDED " + argv[0] + " " + argv[1])
    if result.stdout_truncated:
        raise Refused("OUTPUT_TOO_LARGE " + argv[1])
    if result.returncode != 0:
        raise Refused("COMMAND_FAILED %s exit=%s: %s" % (" ".join(argv[:2]), result.returncode,
                                                        result.text("stderr").strip()[:400]))
    return result.stdout


def git(*args: str, data: bytes | None = None) -> bytes:
    return run(["git", *args], data)


def line(*args: str) -> str:
    return git(*args).decode("utf-8", "strict").strip()


class Repo:
    def __init__(self) -> None:
        self.top = os.path.realpath(line("rev-parse", "--show-toplevel"))
        self.gitdir = os.path.realpath(line("rev-parse", "--absolute-git-dir"))
        common = os.path.realpath(line("rev-parse", "--path-format=absolute", "--git-common-dir"))
        if common != self.gitdir:
            raise Refused("LINKED_WORKTREE_UNSUPPORTED")
        if line("rev-parse", "--is-shallow-repository") != "false":
            raise Refused("SHALLOW_HISTORY_UNSUPPORTED")
        self.oid_length = 40 if line("rev-parse", "--show-object-format") == "sha1" else 64
        self.zero = "0" * self.oid_length

    def oid(self, value: object, what: str) -> str:
        if (not isinstance(value, str) or len(value) != self.oid_length
                or any(c not in "0123456789abcdef" for c in value)):
            raise Refused("FULL_OBJECT_ID_REQUIRED " + what)
        return value

    def ref_value(self, ref: str) -> str:
        out = git("for-each-ref", "--format=%(refname) %(objectname)", ref).decode()
        for row in out.splitlines():
            name, _, value = row.partition(" ")
            if name == ref:
                return value
        return ""

    def review_path(self, plan_sha256: str) -> str:
        return os.path.join(self.gitdir, "omp-kit", "history-review", plan_sha256 + ".json")


def unique_object(pairs: list) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise Refused("DUPLICATE_JSON_KEY " + str(key))
        result[key] = value
    return result


def reject_constant(name: str) -> object:
    raise Refused("NON_FINITE_JSON_NUMBER " + name)


def parse_json(data: bytes, what: str) -> object:
    try:
        return json.loads(data.decode("utf-8", "strict"), object_pairs_hook=unique_object,
                          parse_constant=reject_constant)
    except (UnicodeError, ValueError) as exc:
        raise Refused("MALFORMED_JSON " + what) from exc


def read_owned(path: str, what: str, read_only: bool = False) -> bytes:
    """A regular, single-link file of ours, opened without following a final symlink."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError as exc:
        raise Refused(what + "_ABSENT") from exc
    except OSError as exc:
        raise Refused(what + "_UNREADABLE") from exc
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != os.geteuid():
            raise Refused(what + "_NOT_OWNED_REGULAR_SINGLE_LINK")
        if read_only and before.st_mode & 0o222:
            raise Refused(what + "_NOT_IMMUTABLE")
        chunks, total = [], 0
        while total <= FILE_CAP:
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        if total > FILE_CAP:
            raise Refused(what + "_TOO_LARGE")
        after = os.fstat(fd)
        if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
            raise Refused(what + "_CHANGED_DURING_READ")
        return b"".join(chunks)
    finally:
        os.close(fd)


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def digest(record: dict, skip: str) -> str:
    return hashlib.sha256(canonical({k: v for k, v in record.items() if k != skip})).hexdigest()


def literal_paths(paths: object) -> list:
    if not isinstance(paths, list) or not paths or len(set(paths)) != len(paths):
        raise Refused("PATH_POLICY_MALFORMED")
    for path in paths:
        parts = path.split("/") if isinstance(path, str) else [""]
        if (any(part in ("", ".", "..") for part in parts) or any(c in path for c in "*?[\\\n\0")):
            raise Refused("PATH_POLICY_NOT_LITERAL")
    if any(b.startswith(a + "/") for a in paths for b in paths if a != b):
        raise Refused("PATH_POLICY_OVERLAP")
    return paths


def allowed(path: str, paths: list) -> bool:
    return any(path == p or path.startswith(p + "/") for p in paths)


def check_plan(repo: Repo, plan: object) -> dict:
    if not isinstance(plan, dict) or any(key not in plan for key in PLAN_KEYS):
        raise Refused("PLAN_MALFORMED")
    if plan["plan_sha256"] != digest(plan, "plan_sha256"):
        raise Refused("PLAN_DIGEST_MISMATCH")
    if type(plan["schema_version"]) is not int or plan["schema_version"] != 1 or plan["operation"] not in OPERATIONS:
        raise Refused("PLAN_OPERATION_UNSUPPORTED")
    if plan["repo"] != repo.top or plan["gitdir"] != repo.gitdir:
        raise Refused("PLAN_REPOSITORY_MISMATCH")
    if plan["signature_policy"] != SIGNATURE_POLICY:
        raise Refused("SIGNATURE_POLICY_UNSUPPORTED")
    if not isinstance(plan["authority"], str) or not plan["authority"].strip():
        raise Refused("PLAN_AUTHORITY_ABSENT")
    repo.oid(plan["old_tip"], "old_tip")
    repo.oid(plan["new_tip"], "new_tip")
    literal_paths(plan["paths"])
    mapping, public, writable = plan["map"], plan["public_refs"], plan["writable_refs"]
    if not isinstance(mapping, dict) or not mapping:
        raise Refused("MAP_MALFORMED")
    for old, new in mapping.items():
        repo.oid(old, "map key")
        repo.oid(new, "map value")
    if not isinstance(public, dict) or MAIN not in public:
        raise Refused("PUBLIC_ROOTS_MALFORMED")
    if not isinstance(writable, list) or MAIN not in writable or any(not isinstance(r, str) for r in writable):
        raise Refused("WRITABLE_ROOTS_MALFORMED")
    for name, value in public.items():
        repo.oid(value, name)
    return plan


def source_roots(plan: dict) -> dict:
    """The reviewed roots: the exact old main plus every reviewed public branch root."""
    roots = {MAIN: plan["old_tip"]}
    for name, value in sorted(plan["public_refs"].items()):
        if name.startswith("refs/pull/"):
            continue
        if not name.startswith(ROOT_PREFIXES):
            raise Refused("PUBLIC_ROOT_TYPE_UNSUPPORTED " + name)
        if name != MAIN:
            roots[name] = value
    roots["public:" + MAIN] = plan["public_refs"][MAIN]
    return roots


def transaction(repo: Repo, plan: dict, applied: bool = False) -> list:
    """The helper's exact apply transaction: preservation refs, then the main update.

    applied=True re-derives the transaction the reviewer bound before the apply: every preservation
    ref must now hold its original, and each is the "create" the review recorded."""
    old = plan["old_tip"]
    prefix = "refs/preserve/history-scrub/" + old + "/"
    if plan["preserve_ref"] != prefix + "main":
        raise Refused("PRESERVATION_REF_NOT_DERIVED")
    preserved = {prefix + "main": old}
    for name, value in plan["public_refs"].items():
        if not name.startswith("refs/pull/"):
            preserved[prefix + "public/" + name[len("refs/"):]] = value
    commands = []
    for ref, original in sorted(preserved.items()):
        existing = repo.ref_value(ref)
        if applied and existing != original:
            raise Refused("PRESERVATION_REF_NOT_APPLIED " + ref)
        if existing and existing != original:
            raise Refused("PRESERVATION_REF_CONFLICT " + ref)
        commands.append(("verify" if existing and not applied else "create") + " %s %s" % (ref, original))
    commands.append("update %s %s %s" % (MAIN, plan["new_tip"], old))
    return commands


def hook_lines(repo: Repo, commands: list) -> list:
    """What Git hands the prepared hook for each command (old new ref)."""
    rows = []
    for command in commands:
        parts = command.split(" ")
        if parts[0] == "create" and len(parts) == 3:
            rows.append("%s %s %s" % (repo.zero, parts[2], parts[1]))
        elif parts[0] == "verify" and len(parts) == 3:
            rows.append("%s %s %s" % (parts[2], repo.zero, parts[1]))
        elif parts[0] == "update" and len(parts) == 4:
            rows.append("%s %s %s" % (parts[3], parts[2], parts[1]))
        else:
            raise Refused("TRANSACTION_COMMAND_UNSUPPORTED")
    return sorted(rows)


def binding(repo: Repo, plan: dict, applied: bool = False) -> dict:
    return {"operation": plan["operation"], "plan_sha256": plan["plan_sha256"], "repo": repo.top,
            "gitdir": repo.gitdir, "ref": MAIN, "old_tip": plan["old_tip"], "new_tip": plan["new_tip"],
            "map_sha256": hashlib.sha256(canonical(plan["map"])).hexdigest(),
            "source_roots": source_roots(plan), "paths": plan["paths"],
            "signature_policy": plan["signature_policy"], "transaction": transaction(repo, plan, applied),
            "authority": plan["authority"]}


def commits(repo: Repo, oids: list) -> dict:
    wanted = sorted(set(oids))
    out = git("cat-file", "--batch", data=("\n".join(wanted) + "\n").encode())
    result, pos = {}, 0
    for oid in wanted:
        end = out.find(b"\n", pos)
        header = out[pos:end].split(b" ") if end >= 0 else []
        if len(header) != 3 or header[0].decode() != oid or header[1] != b"commit":
            raise Refused("MAPPED_OBJECT_NOT_A_COMMIT " + oid)
        size = int(header[2])
        result[oid] = out[end + 1:end + 1 + size]
        pos = end + 2 + size
    return result


def headers(repo: Repo, raw: bytes, oid: str) -> tuple:
    head, sep, message = raw.partition(b"\n\n")
    if not sep:
        raise Refused("MALFORMED_COMMIT " + oid)
    blocks = []
    for row in head.split(b"\n"):
        if row.startswith(b" "):
            if not blocks:
                raise Refused("MALFORMED_COMMIT " + oid)
            blocks[-1] += b"\n" + row
        elif b" " not in row:
            raise Refused("MALFORMED_COMMIT " + oid)
        else:
            blocks.append(row)
    tree, parents, signatures = None, [], 0
    for block in blocks:
        name, value = block.split(b" ", 1)
        if name in (b"tree", b"parent"):
            try:
                parsed = repo.oid(value.decode("ascii"), "commit header")
            except UnicodeError as exc:
                raise Refused("MALFORMED_COMMIT " + oid) from exc
            if name == b"tree":
                if tree is not None:
                    raise Refused("MALFORMED_COMMIT " + oid)
                tree = parsed
            else:
                parents.append(parsed)
        elif name == b"mergetag" or name.startswith(b"gpgsig"):
            signature = value.replace(b"\n ", b"\n")
            kind = [k for k in (b"PGP", b"SSH") if signature.startswith(b"-----BEGIN " + k + b" SIGNATURE-----\n")
                    and signature.rstrip(b"\n").endswith(b"-----END " + k + b" SIGNATURE-----")]
            if name != b"gpgsig" or not kind:
                raise Refused("UNKNOWN_SIGNATURE_HEADER_OR_MERGETAG " + oid)
            signatures += 1
    if tree is None or signatures > 1:
        raise Refused("MALFORMED_COMMIT " + oid)
    return blocks, sep + message, tree, parents


def diff_records(out: bytes) -> list:
    """Parse `diff-tree --stdin -r -z` over tree pairs: [(pair_header, status, path)].

    Grammar accepted (git's own raw -z form, nothing else): an echoed
    "<tree> <tree>\\n" pair line, or ":<mode> <mode> <oid> <oid> <status>\\0<path>\\0".
    Anything else refuses."""
    rows, pos, current = [], 0, ""
    try:
        while pos < len(out):
            if out[pos:pos + 1] == b":":
                meta_end = out.index(b"\0", pos)
                path_end = out.index(b"\0", meta_end + 1)
                meta = out[pos + 1:meta_end].split(b" ")
                if len(meta) != 5 or not current:
                    raise ValueError("raw diff record")
                rows.append((current, meta[4].decode("ascii"), out[meta_end + 1:path_end].decode("utf-8", "surrogateescape")))
                pos = path_end + 1
            else:
                end = out.index(b"\n", pos)
                current = out[pos:end].decode("ascii")
                if len(current.split(" ")) != 2:
                    raise ValueError("pair line")
                pos = end + 1
    except (ValueError, UnicodeError) as exc:
        raise Refused("UNPARSEABLE_TREE_DIFF") from exc
    return rows


def check_transform(repo: Repo, plan: dict) -> None:
    """Re-derive the reviewed transform from the objects; never trust the plan's own witnesses."""
    mapping, paths = plan["map"], plan["paths"]
    roots = source_roots(plan)
    reachable = set(git("rev-list", *sorted(set(roots.values())), "--").decode().split())
    missing = reachable - set(mapping)
    if missing:
        raise Refused("MAP_INCOMPLETE %d unmapped source commit(s), e.g. %s" % (len(missing), min(missing)))
    extra = set(mapping) - reachable
    if extra:
        raise Refused("MAP_EXTRA_ENTRY %d commit(s) outside the reviewed roots, e.g. %s" % (len(extra), min(extra)))
    if mapping.get(plan["old_tip"]) != plan["new_tip"]:
        raise Refused("MAP_TIP_MISMATCH")
    for name in roots:
        if name.startswith("refs/") and name not in plan["writable_refs"] and mapping[roots[name]] != roots[name]:
            raise Refused("UNREVIEWED_ROOT_REWRITTEN " + name)
    values = list(mapping.values())
    if len(set(values)) != len(values):
        raise Refused("MAP_CONFLICT_NOT_ONE_TO_ONE")
    raw = commits(repo, list(mapping) + [v for k, v in mapping.items() if v != k])
    changed_pairs, new_trees = set(), set()
    for old, new in mapping.items():
        blocks, message, tree, parents = headers(repo, raw[old], old)
        mapped_parents = [mapping[p] for p in parents]
        if new == old:
            if mapped_parents != parents:
                raise Refused("MAP_CONFLICT_PARENTS " + old)
            new_trees.add(tree)
            continue
        _, _, new_tree, new_parents = headers(repo, raw[new], new)
        if new_parents != mapped_parents:
            raise Refused("MAP_CONFLICT_PARENTS " + old)
        if new_tree == tree and new_parents == parents:
            raise Refused("UNAPPROVED_METADATA_CHANGE " + old)
        rebuilt, kept, index = [], [], 0
        for block in blocks:
            name = block.split(b" ", 1)[0]
            if name == b"tree":
                block = b"tree " + new_tree.encode()
            elif name == b"parent":
                block = b"parent " + new_parents[index].encode()
                index += 1
            elif name == b"gpgsig":
                kept.append(block)
                continue
            rebuilt.append(block)
            kept.append(block)
        if b"\n".join(rebuilt) + message != raw[new]:
            if kept != rebuilt and b"\n".join(kept) + message == raw[new]:
                raise Refused("BORROWED_SIGNATURE " + old)
            raise Refused("UNAPPROVED_METADATA_CHANGE " + old)
        new_trees.add(new_tree)
        if new_tree != tree:
            changed_pairs.add((tree, new_tree))
    if changed_pairs:
        data = "".join("%s %s\n" % pair for pair in sorted(changed_pairs)).encode()
        for pair, status, path in diff_records(git("diff-tree", "--stdin", "-r", "-z", "--no-renames", data=data)):
            if status != "D" or not allowed(path, paths):
                raise Refused("UNAPPROVED_TREE_CHANGE %s %s (%s)" % (status, path, pair))
    empty = line("hash-object", "-t", "tree", "--stdin")
    data = "".join("%s %s\n" % (empty, tree) for tree in sorted(new_trees)).encode()
    retained = diff_records(git("--literal-pathspecs", "diff-tree", "--stdin", "-r", "-z", "--", *paths, data=data))
    if retained:
        raise Refused("ALLOWED_PATH_RETAINED %s (%s)" % (retained[0][2], retained[0][0]))


def process(pid: int, field: str) -> str:
    return run(["ps", "-o", field + "=", "-p", str(pid)]).decode().strip()


def ancestors() -> list:
    chain, pid = [], os.getppid()
    for _ in range(32):
        if pid <= 1:
            break
        chain.append(pid)
        try:
            pid = int(process(pid, "ppid"))
        except (Refused, ValueError):
            break
    return chain


def owned_context(repo: Repo) -> tuple:
    """HISTPREP1's early context: owner lock, durable intent, owned Git child. Not authority."""
    lock_bytes = read_owned(os.path.join(repo.gitdir, "index.lock"), "OWNER_LOCK")
    lock = parse_json(lock_bytes, "owner lock")
    if (not isinstance(lock, dict) or set(lock) != LOCK_FIELDS or lock.get("operation") != LOCK_OPERATION
            or type(lock.get("pid")) is not int or lock["pid"] <= 1 or not lock.get("nonce")
            or not isinstance(lock.get("map"), str) or not os.path.isabs(lock["map"])
            or not isinstance(lock.get("plan_sha256"), str) or not lock.get("process_start")):
        raise Refused("OWNER_LOCK_MALFORMED")
    return lock_bytes, lock


def check_context(repo: Repo, lock_bytes: bytes, lock: dict, plan: dict) -> dict:
    if lock["plan_sha256"] != plan["plan_sha256"]:
        raise Refused("OWNER_LOCK_PLAN_MISMATCH")
    try:
        os.kill(lock["pid"], 0)
    except OSError as exc:
        raise Refused("OWNER_NOT_LIVE") from exc
    if process(lock["pid"], "lstart") != lock["process_start"]:
        raise Refused("OWNER_INCARNATION_MISMATCH")
    events = read_owned(lock["map"] + ".events.jsonl", "JOURNAL").splitlines()
    records = [parse_json(row, "journal") for row in events if row.strip()]
    starts = [i for i, r in enumerate(records) if isinstance(r, dict) and r.get("phase") == "PREPARE_INTENT"]
    if not starts:
        raise Refused("PREPARE_INTENT_ABSENT")
    intent = records[starts[-1]]
    later = records[starts[-1] + 1:]
    if any(not isinstance(r, dict) or r.get("phase") != "GIT_CHILD_STARTED" for r in later) or len(later) != 1:
        raise Refused("PREPARE_INTENT_NOT_CURRENT")
    child = later[0]
    if set(intent) != INTENT_FIELDS or set(child) != CHILD_FIELDS:
        raise Refused("JOURNAL_RECORD_FORMAT_UNKNOWN")
    if (intent.get("plan_sha256") != plan["plan_sha256"] or child.get("plan_sha256") != plan["plan_sha256"]
            or intent.get("operation") != plan["operation"] or intent.get("repo") != repo.top
            or intent.get("gitdir") != repo.gitdir or intent.get("expected_tip") != plan["old_tip"]
            or intent.get("recover") is not False):
        raise Refused("PREPARE_INTENT_MISMATCH")
    if intent.get("owner_lock_sha256") != hashlib.sha256(lock_bytes).hexdigest():
        raise Refused("OWNER_LOCK_DIGEST_MISMATCH")
    pid = child.get("child_pid")
    if type(pid) is not int or child.get("owner_pid") != lock["pid"] or pid not in ancestors():
        raise Refused("GIT_CHILD_NOT_THIS_TRANSACTION")
    if process(pid, "lstart") != child.get("child_start") or process(pid, "ppid") != str(lock["pid"]):
        raise Refused("GIT_CHILD_INCARNATION_MISMATCH")
    return intent


def check_approval(body: bytes, message_id: object, reviewer: str, plan_sha256: str) -> None:
    """The exported APPROVE message: same id, sent by the reviewer, naming APPROVE and the plan digest."""
    if len(body) > APPROVAL_CAP:
        raise Refused("APPROVAL_TOO_LARGE")
    message = parse_json(body, "approval message")
    if not isinstance(message, dict) or not all(isinstance(message.get(k), str) for k in ("from", "subject", "body_md")):
        raise Refused("APPROVAL_MALFORMED needs the exported message's id, from, subject and body_md")
    if type(message.get("id")) is not int or type(message_id) is not int or message["id"] != message_id:
        raise Refused("APPROVAL_MESSAGE_ID_MISMATCH")
    if message["from"] != reviewer:
        raise Refused("APPROVAL_SENDER_MISMATCH sender %s is not the reviewer %s" % (message["from"], reviewer))
    text = message["subject"] + "\n" + message["body_md"]
    if "APPROVE" not in (word.strip(".,:;!()[]*_`") for word in text.split()):
        raise Refused("APPROVAL_NOT_APPROVE")
    if plan_sha256 not in text:
        raise Refused("APPROVAL_NOT_FOR_PLAN")


def check_review(repo: Repo, plan: dict, intent: dict, applied: bool = False) -> tuple:
    path = repo.review_path(plan["plan_sha256"])
    record = parse_json(read_owned(path, "REVIEW", read_only=True), "review record")
    if isinstance(record, dict) and record.get("schema") == LEGACY_SCHEMA:
        raise Refused("REVIEW_APPROVAL_ABSENT pre-approval record; re-run review with --approval-message-id and --approval-file")
    if not isinstance(record, dict) or set(record) != RECORD_KEYS or record.get("schema") != SCHEMA:
        raise Refused("REVIEW_MALFORMED")
    if record["record_sha256"] != digest(record, "record_sha256"):
        raise Refused("REVIEW_DIGEST_MISMATCH")
    expected = binding(repo, plan, applied)
    for key in BINDING_KEYS:
        if record[key] != expected[key]:
            raise Refused("REVIEW_BINDING_MISMATCH " + key)
    reviewer = record["reviewer"]
    if not isinstance(reviewer, str) or not reviewer.strip():
        raise Refused("REVIEWER_ABSENT")
    if reviewer == intent.get("actor"):
        raise Refused("REVIEWER_IS_APPLIER")
    if intent.get("transaction") != record["transaction"]:
        raise Refused("INTENT_TRANSACTION_MISMATCH")
    # HISTQUIESCE1 part 3: the APPROVE this review relies on, verified offline from its read-only copy.
    approval = path[:-len(".json")] + APPROVAL_SUFFIX
    body = read_owned(approval, "REVIEW_APPROVAL", read_only=True)
    if hashlib.sha256(body).hexdigest() != record["approval_sha256"]:
        raise Refused("REVIEW_APPROVAL_DIGEST_MISMATCH")
    check_approval(body, record["approval_message_id"], reviewer, plan["plan_sha256"])
    return path, record


def verify_witness(repo: Repo, lines: list, lock_bytes: bytes, lock: dict, plan_value: object) -> str:
    plan = check_plan(repo, plan_value)
    intent = check_context(repo, lock_bytes, lock, plan)
    path, record = check_review(repo, plan, intent)
    if lines != hook_lines(repo, record["transaction"]):
        raise Refused("TRANSACTION_MISMATCH")
    if repo.ref_value(MAIN) != plan["old_tip"]:
        raise Refused("STALE_OLD_TIP")
    check_transform(repo, plan)
    return "plan=%s ref=%s old=%s new=%s mapped=%d review=%s reviewer=%s" % (
        plan["plan_sha256"], MAIN, plan["old_tip"], plan["new_tip"], len(plan["map"]), path, record["reviewer"])


def admit() -> int:
    outcome, data, truncated = pysafe.read_stdin(timeout=5, cap_bytes=1 << 20)
    if outcome != pysafe.OK or truncated:
        raise Refused("TRANSACTION_UNREADABLE")
    repo = Repo()
    lines = sorted(row for row in data.decode("utf-8", "strict").splitlines() if row.strip())
    mains = [row.split(" ") for row in lines if row.endswith(" " + MAIN)]
    if len(mains) != 1 or len(mains[0]) != 3:
        raise Refused("TRANSACTION_MISMATCH")
    old, new = mains[0][0], mains[0][1]
    lock_bytes, lock = owned_context(repo)
    plan = parse_json(read_owned(lock["map"], "PLAN"), "plan")
    summary = verify_witness(repo, lines, lock_bytes, lock, plan)  # WITNESS-VALIDATION
    gained = git("rev-list", "--no-merges", new, "^" + old, "--not", "--remotes=origin", "--").decode().split()
    counterparts = set(plan["map"].values()) if isinstance(plan, dict) and isinstance(plan.get("map"), dict) else set()
    for oid in gained:
        if oid not in counterparts:
            print(oid)
    print("ref-txn-witness: ADMITTED reviewed history transform " + summary, file=sys.stderr)
    return 0


def reviewed_plans(common: str, tip: str) -> list:
    """The reviewed plan copies whose new main is the pushed tip or one of its ancestors (discovery only)."""
    folder = os.path.join(common, "omp-kit", "history-review")
    try:
        names = sorted(n for n in os.listdir(folder) if n.endswith(PLAN_SUFFIX))
    except FileNotFoundError:
        return []
    found = []
    for name in names:
        try:
            plan = parse_json(read_owned(os.path.join(folder, name), "REVIEWED_PLAN", read_only=True), "plan")
            new = plan.get("new_tip") if isinstance(plan, dict) else None
            if not isinstance(new, str) or len(new) not in (40, 64) or any(c not in "0123456789abcdef" for c in new):
                continue
            if git("cat-file", "-t", new).strip() == b"commit" and not git("rev-list", "-n", "1", new, "^" + tip, "--"):
                found.append((name, plan))
        except Refused:
            continue
    return found


def verify_push(repo: Repo, name: str, plan_value: object, tip: str, remote: str) -> str:
    """Members 40/41: the push publishes exactly the applied, independently reviewed new main."""
    plan = check_plan(repo, plan_value)
    if name != plan["plan_sha256"] + PLAN_SUFFIX:
        raise Refused("REVIEWED_PLAN_NAME_MISMATCH " + name)
    if tip != plan["new_tip"]:
        raise Refused("PUSH_TIP_NOT_REVIEWED_NEW_ROOT %s (reviewed %s)" % (tip, plan["new_tip"]))
    if remote != plan["public_refs"][MAIN]:
        raise Refused("STALE_LEASE remote %s is not the reviewed public root %s" % (remote, plan["public_refs"][MAIN]))
    if repo.ref_value(MAIN) != plan["new_tip"]:
        raise Refused("LOCAL_MAIN_NOT_NEW_ROOT")
    applier = os.environ.get("AGENT_NAME", "").strip()
    if not applier or applier == "operator":
        raise Refused("APPLIER_NAME_ABSENT set AGENT_NAME to the pushing seat's registered name")
    intent = {"actor": applier, "transaction": transaction(repo, plan, applied=True)}
    path, record = check_review(repo, plan, intent, applied=True)
    check_transform(repo, plan)
    return "plan=%s ref=%s old=%s new=%s mapped=%d review=%s reviewer=%s pusher=%s" % (
        plan["plan_sha256"], MAIN, plan["public_refs"][MAIN], plan["new_tip"], len(plan["map"]), path,
        record["reviewer"], applier)


def push_admit(argv: list) -> int:
    """push-admit LOCAL_SHA REMOTE_REF REMOTE_SHA -- REV-LIST-ARGS...

    Exit 3: no reviewed plan claims this push; the member runs its ordinary check unchanged.
    Exit 0: the push is the reviewed rewrite; prints the member's own range minus the mapped
    counterparts, which the member then judges with its ordinary check. Exit 4: refused."""
    if len(argv) < 5 or argv[3] != "--":
        raise Refused("USAGE push-admit LOCAL_SHA REMOTE_REF REMOTE_SHA -- REV-LIST-ARGS...")
    tip, ref, remote, revs = argv[0], argv[1], argv[2], argv[4:]
    if ref != MAIN or set(tip) == {"0"} or set(remote) == {"0"}:
        return 3
    found = reviewed_plans(line("rev-parse", "--path-format=absolute", "--git-common-dir"), tip)
    if not found:
        return 3
    if len(found) != 1:
        raise Refused("AMBIGUOUS_REVIEWED_PLANS " + " ".join(n for n, _ in found))
    repo = Repo()
    name, plan = found[0]
    summary = verify_push(repo, name, plan, tip, remote)  # PUSH-VALIDATION
    counterparts = set(plan["map"].values()) if isinstance(plan.get("map"), dict) else set()
    for oid in git("rev-list", *revs, "--").decode().split():
        if oid not in counterparts:
            print(oid)
    print("ref-txn-witness: ADMITTED reviewed rewrite push " + summary, file=sys.stderr)
    return 0


def write_read_only(path: str, data: bytes, what: str) -> None:
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o400)
    except FileExistsError as exc:
        raise Refused(what + "_ALREADY_RECORDED " + path) from exc
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)


def review(argv: list) -> int:
    usage = "USAGE review --plan PATH --reviewer NAME --approval-message-id ID --approval-file PATH"
    flags = ("--plan", "--reviewer", "--approval-message-id", "--approval-file")
    options = {}
    it = iter(argv)
    for flag in it:
        if flag not in flags or flag in options:
            raise Refused(usage)
        options[flag] = next(it, "")
    if not {"--plan", "--reviewer"} <= set(options) or not options["--reviewer"].strip():
        raise Refused(usage)
    if set(options) != set(flags):
        raise Refused("APPROVAL_REQUIRED review needs --approval-message-id and --approval-file (the exported APPROVE)")
    message_id = options["--approval-message-id"]
    if not message_id.isdigit() or not message_id.isascii() or int(message_id) <= 0:
        raise Refused("APPROVAL_MESSAGE_ID_MALFORMED")
    repo = Repo()
    plan_bytes = read_owned(os.path.abspath(options["--plan"]), "PLAN")
    plan = check_plan(repo, parse_json(plan_bytes, "plan"))
    approval_bytes = read_owned(os.path.abspath(options["--approval-file"]), "APPROVAL")
    check_approval(approval_bytes, int(message_id), options["--reviewer"], plan["plan_sha256"])
    if line("symbolic-ref", "-q", "HEAD") != MAIN or repo.ref_value(MAIN) != plan["old_tip"]:
        raise Refused("STALE_OLD_TIP")
    check_transform(repo, plan)
    record = {"schema": SCHEMA, **binding(repo, plan), "reviewer": options["--reviewer"],
              "reviewed_at": datetime.now(timezone.utc).isoformat(), "approval_message_id": int(message_id),
              "approval_sha256": hashlib.sha256(approval_bytes).hexdigest()}
    record["record_sha256"] = digest(record, "record_sha256")
    path = repo.review_path(plan["plan_sha256"])
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    if os.path.lexists(path):
        raise Refused("REVIEW_ALREADY_RECORDED " + path)
    # The reviewed plan bytes beside the record let pre-push members find the plan by the pushed tip.
    copy = os.path.join(os.path.dirname(path), plan["plan_sha256"] + PLAN_SUFFIX)
    if not (os.path.isfile(copy) and read_owned(copy, "REVIEWED_PLAN", read_only=True) == plan_bytes):
        write_read_only(copy, plan_bytes, "REVIEWED_PLAN")
    # The exact APPROVE bytes beside the record let every hook re-verify it offline.
    approval = path[:-len(".json")] + APPROVAL_SUFFIX
    if not (os.path.isfile(approval) and read_owned(approval, "REVIEW_APPROVAL", read_only=True) == approval_bytes):
        write_read_only(approval, approval_bytes, "REVIEW_APPROVAL")
    write_read_only(path, canonical(record) + b"\n", "REVIEW")
    directory = os.open(os.path.dirname(path), os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    print(json.dumps({"status": "REVIEWED", "record": path, "plan_sha256": plan["plan_sha256"],
                      "reviewer": record["reviewer"], "approval_message_id": record["approval_message_id"]},
                     sort_keys=True))
    return 0


def main() -> int:
    argv = sys.argv[1:]
    try:
        if argv == ["admit"]:
            return admit()
        if argv[:1] == ["review"]:
            return review(argv[1:])
        if argv[:1] == ["push-admit"]:
            return push_admit(argv[1:])
        raise Refused("USAGE admit | review --plan PATH --reviewer NAME --approval-message-id ID --approval-file PATH"
                      " | push-admit LOCAL_SHA REMOTE_REF REMOTE_SHA -- REVS...")
    except Refused as exc:
        print("ref-txn-witness: REFUSED " + str(exc), file=sys.stderr)
        return 4


if __name__ == "__main__":
    pysafe.run_main(main)
