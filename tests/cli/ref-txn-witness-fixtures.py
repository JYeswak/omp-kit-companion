#!/usr/bin/env python3
"""Real-Git fixtures for the reviewed history-transform witness (HISTADMIT1, ompkit-2w7h.3).

Test-only. `build` creates the fixture repository and its bare origin inside a
fresh kitlib owned dir under the caller's owned tmp, never the working
directory; every other command refuses a repository outside an owned dir. The
helper emulation writes history_remove_apply's owner lock, PREPARE_INTENT and
GIT_CHILD_STARTED records (HISTPREP1) around a live
`git update-ref --no-deref --stdin`, so the installed reference-transaction
chain runs exactly as Git dispatches it. Record field sets come from the
reader's pinned HISTPREP1 contracts, and `helper-format` checks those against
the real helper source by parsing it.

  build OWNED_TMP                             -> "repo|origin|root|l1|l2 VALUE" lines, legacy history on main
  rewrite REPO OUT --l1 OID --l2 OID ROOT...  [--keep-signature] [--drop-extra] [--keep-path]
                                              [--alter-message] [--wrong-parent]
  plan REPO MAP OUT --old OID --public OID --authority A [--drop-key OID] [--add-key OID] [--repo-override P]
                                              -> "<plan_sha256> <new_tip>"
  plan ... [--backup REF=OID]...              (PUSHADMIT2) adds a reviewed writable non-branch ref
  forge-review REPO PLAN --reviewer NAME [--set KEY=JSON]... [--alter-after-digest] [--writable]
               [--approval-from NAME] [--no-approval-copy] [--tamper-approval] [--legacy-v1]
  approval REPO OUT --plan PLAN --id N --from NAME [--subject TEXT]
                                              -> an exported Agent Mail APPROVE message (JSON)
  drive REPO PLAN [--actor NAME] [--commands JSON] [--intent-commands JSON] [--no-lock]
                  [--foreign-child] [--tamper-lock] [--prepare-only]
  record-child PLAN ACTOR OWNER_PID CHILD_PID  (drive's Git-child shell only)
  helper-format HISTORY_REMOVE_APPLY_PY       -> HELPER_FORMAT_MATCH, or the drift
"""
from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import os
import secrets
import sys
from datetime import datetime, timezone

SCRIPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "scripts")
sys.path.insert(0, SCRIPTS)
import kitlib_run  # noqa: E402  (the bounded-run primitive; one implementation)
import pysafe  # noqa: E402  (cancel-safe spawn: own process group, stdin DEVNULL, hard deadline)
from kitlib_tmp import owned_tmp  # noqa: E402

IDENT = "Test <test@invalid.example> 1700000000 +0000"
FAKE_SIG = "-----BEGIN PGP SIGNATURE-----\n\nfixture-signature\n-----END PGP SIGNATURE-----"
PATH = "raw.bin"


def fail(message: str) -> None:
    print("fixtures: " + message, file=sys.stderr)
    sys.exit(2)


def git_raw(repo: str, *args: str, data: bytes | None = None) -> bytes:
    result = pysafe.run_bounded(["git", "-C", repo, *args], timeout=30, input=data, cap_bytes=64 << 20)
    if not result.ok:
        fail("git %s: %s" % (" ".join(args), result.text("stderr").strip()))
    return result.stdout


def git(repo: str, *args: str, data: bytes | None = None) -> str:
    return git_raw(repo, *args, data=data).decode().strip()


def witness():
    spec = importlib.util.spec_from_file_location("ref_txn_witness", os.path.join(SCRIPTS, "ref-txn-witness.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def options(argv: list, flags: tuple, values: tuple) -> tuple:
    found, rest = {}, []
    it = iter(argv)
    for arg in it:
        if arg in flags:
            found[arg] = True
        elif arg in values:
            found.setdefault(arg, []).append(next(it))
        else:
            rest.append(arg)
    return found, rest


def mktree(repo: str, files: dict) -> str:
    data = "".join("100644 blob %s\t%s\n" % (oid, name) for name, oid in sorted(files.items()))
    return git(repo, "mktree", data=data.encode())


def blob(repo: str, text: str) -> str:
    return git(repo, "hash-object", "-w", "--stdin", data=text.encode())


def write_commit(repo: str, raw: bytes) -> str:
    return git(repo, "hash-object", "-t", "commit", "-w", "--stdin", data=raw)


def raw_commit(tree: str, parents: list, message: str, signature: str = "") -> bytes:
    head = ["tree " + tree] + ["parent " + p for p in parents] + ["author " + IDENT, "committer " + IDENT]
    if signature:
        head.append("gpgsig " + signature.replace("\n", "\n "))
    return ("\n".join(head) + "\n\n" + message + "\n").encode()


def owned_dir(path: str) -> str:
    """The nearest enclosing kitlib owned dir (it carries a .owner record); refuse anything else."""
    probe = os.path.realpath(path)
    while probe != os.path.dirname(probe):
        if os.path.isfile(os.path.join(probe, ".owner")):
            return probe
        probe = os.path.dirname(probe)
    fail("refusing %s: not inside a kitlib owned tmp dir" % path)
    return ""


def build(owned: str) -> None:
    base = owned_tmp("ref-txn-witness-fixture", root=owned_dir(owned), auto_cleanup=False).path
    repo, origin = os.path.join(base, "repo"), os.path.join(base, "origin.git")
    git(base, "init", "-q", "--template=", "--bare", origin)
    git(base, "init", "-q", "--template=", "-b", "main", repo)
    root = write_commit(repo, raw_commit(mktree(repo, {"keep.txt": blob(repo, "root\n")}), [], "root ompkit-2w7h"))
    l1 = write_commit(repo, raw_commit(mktree(repo, {"keep.txt": blob(repo, "one\n"), PATH: blob(repo, "RAW PAYLOAD\n")}),
                                       [root], "legacy import with no identity", FAKE_SIG))
    l2 = write_commit(repo, raw_commit(mktree(repo, {"keep.txt": blob(repo, "two\n"), PATH: blob(repo, "RAW PAYLOAD\n"),
                                                     "note.txt": blob(repo, "note\n")}), [l1], "legacy edit with no identity"))
    git(repo, "remote", "add", "origin", origin)
    git(repo, "push", "-q", "origin", root + ":refs/heads/main")
    git(repo, "fetch", "-q", "origin")
    # Legacy id-less history already on main before any guard exists.
    git(repo, "update-ref", "refs/heads/main", l2)
    git(repo, "read-tree", "refs/heads/main")
    for key, value in (("repo", repo), ("origin", origin), ("root", root), ("l1", l1), ("l2", l2)):
        print(key, value)


def rewrite(repo: str, argv: list) -> None:
    found, rest = options(argv, ("--keep-signature", "--drop-extra", "--keep-path", "--alter-message", "--wrong-parent"),
                          ("--l1", "--l2"))
    out, roots = rest[0], rest[1:]
    l1, l2 = found["--l1"][0], found["--l2"][0]
    mapping = {}
    for old in git(repo, "rev-list", "--reverse", "--topo-order", *roots).split():
        head, _, message = git_raw(repo, "cat-file", "commit", old).partition(b"\n\n")
        blocks = []
        for row in head.split(b"\n"):
            if row.startswith(b" "):
                blocks[-1] += b"\n" + row
            else:
                blocks.append(row)
        tree = [b.split(b" ", 1)[1].decode() for b in blocks if b.startswith(b"tree ")][0]
        parents = [b.split(b" ", 1)[1].decode() for b in blocks if b.startswith(b"parent ")]
        files = {}
        for row in git(repo, "ls-tree", tree).splitlines():
            meta, name = row.split("\t", 1)
            files[name] = meta.split(" ")[2]
        if not ("--keep-path" in found and old == l2):
            files.pop(PATH, None)
        if "--drop-extra" in found and old == l1:
            files.pop("keep.txt", None)
        new_tree = mktree(repo, files)
        new_parents = parents if ("--wrong-parent" in found and old == l2) else [mapping[p] for p in parents]
        if new_tree == tree and new_parents == [mapping[p] for p in parents] == parents:
            mapping[old] = old
            continue
        rebuilt, index = [], 0
        for block in blocks:
            if block.startswith(b"tree "):
                block = b"tree " + new_tree.encode()
            elif block.startswith(b"parent "):
                block = b"parent " + new_parents[index].encode()
                index += 1
            elif block.startswith(b"gpgsig ") and "--keep-signature" not in found:
                continue
            elif block.startswith(b"author ") and "--alter-message" in found and old == l2:
                block = block.replace(b"author Test", b"author Someone Else")
            rebuilt.append(block)
        mapping[old] = write_commit(repo, b"\n".join(rebuilt) + b"\n\n" + message)
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(mapping, handle, sort_keys=True)


def plan(repo: str, argv: list) -> None:
    found, rest = options(argv, (), ("--old", "--public", "--authority", "--drop-key", "--add-key", "--repo-override",
                                     "--backup"))
    mapping = json.loads(open(rest[0], encoding="utf-8").read(1 << 20))
    out, old = rest[1], found["--old"][0]
    for key in found.get("--drop-key", []):
        mapping.pop(key)
    for key in found.get("--add-key", []):
        mapping[key] = key
    top = os.path.realpath(git(repo, "rev-parse", "--show-toplevel"))
    result = {"schema_version": 1, "operation": "scrub-dag-v1", "repo": found.get("--repo-override", [top])[0],
              "gitdir": os.path.realpath(git(repo, "rev-parse", "--absolute-git-dir")), "old_tip": old,
              "new_tip": mapping[old], "paths": [PATH], "map": mapping, "forbidden_oids": [],
              "public_refs": {"refs/heads/main": found["--public"][0]}, "origin_identity": {}, "before": {},
              "authority": found["--authority"][0], "preserve_ref": "refs/preserve/history-scrub/%s/main" % old,
              "writable_refs": ["refs/heads/main"], "new_roots": {},
              "signature_policy": "invalidate-pgp-ssh-preserve-originals", "signature_invalidations": [],
              "tree_map": {}, "commit_witnesses": {}, "readonly_residuals": {}}
    # PUSHADMIT2: --backup REF=OID adds a reviewed writable non-branch ref, as the jev scrub plan recorded them.
    for item in found.get("--backup", []):
        ref, _, public = item.partition("=")
        result["public_refs"][ref] = public
        result["writable_refs"].append(ref)
        result["new_roots"][ref] = {"old": public, "new": mapping[public]}
    result["plan_sha256"] = witness().digest(result, "plan_sha256")
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(result, handle, sort_keys=True)
    print(result["plan_sha256"], result["new_tip"])


def approval_message(message_id: int, sender: str, plan_sha256: str, subject: str = "") -> bytes:
    """An exported Agent Mail message, in the fields fetch_inbox returns."""
    return (json.dumps({"id": message_id, "from": sender, "subject": subject or "APPROVE history scrub " + plan_sha256,
                        "body_md": "APPROVE plan_sha256=%s after independent review.\n" % plan_sha256,
                        "created_ts": "2026-11-04T00:00:00+00:00", "importance": "high"}, sort_keys=True) + "\n").encode()


def approval(repo: str, argv: list) -> None:
    found, rest = options(argv, (), ("--plan", "--id", "--from", "--subject"))
    value = json.loads(open(found["--plan"][0], encoding="utf-8").read(1 << 20))
    with open(rest[0], "wb") as handle:
        handle.write(approval_message(int(found["--id"][0]), found["--from"][0], value["plan_sha256"],
                                      found.get("--subject", [""])[0]))
    print(rest[0])


def forge_review(repo: str, argv: list) -> None:
    found, rest = options(argv, ("--alter-after-digest", "--writable", "--no-approval-copy", "--tamper-approval",
                                 "--legacy-v1"), ("--reviewer", "--set", "--approval-from"))
    os.chdir(repo)
    module = witness()
    checkout = module.Repo()
    value = json.loads(open(rest[0], encoding="utf-8").read(1 << 20))
    reviewer = found["--reviewer"][0]
    body = approval_message(7, found.get("--approval-from", [reviewer])[0], value["plan_sha256"])
    record = {"schema": module.SCHEMA, **module.binding(checkout, value), "reviewer": reviewer,
              "reviewed_at": "2026-11-04T00:00:00+00:00", "approval_message_id": 7,
              "approval_sha256": hashlib.sha256(body).hexdigest()}
    if "--legacy-v1" in found:  # a record written before HISTQUIESCE1 part 3: no approval fields
        record = {k: v for k, v in record.items() if not k.startswith("approval_")}
        record["schema"] = module.LEGACY_SCHEMA
    for item in found.get("--set", []):
        key, _, raw = item.partition("=")
        record[key] = json.loads(raw)
    record["record_sha256"] = module.digest(record, "record_sha256")
    if "--alter-after-digest" in found:
        record["reviewer"] += "-altered"
    path = checkout.review_path(value["plan_sha256"])
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")
    os.chmod(path, 0o644 if "--writable" in found else 0o444)
    if "--no-approval-copy" not in found and "--legacy-v1" not in found:
        copy = path[:-len(".json")] + module.APPROVAL_SUFFIX
        with open(copy, "wb") as handle:
            handle.write(body.replace(b"independent", b"tampered") if "--tamper-approval" in found else body)
        os.chmod(copy, 0o444)
    print(path)


def lstart(pid: int) -> str:
    result = pysafe.run_bounded(["ps", "-o", "lstart=", "-p", str(pid)], timeout=30)
    return result.text().strip()


def contract(fields: frozenset, values: dict, what: str) -> dict:
    """A record with exactly the reader's pinned HISTPREP1 field set; a drift fails the fixture loudly."""
    if set(values) != set(fields):
        fail("%s fields drifted from the reader contract: extra=%s missing=%s"
             % (what, sorted(set(values) - fields), sorted(fields - set(values))))
    return dict(values)


def journal(module, path: str, phase: str, fields: frozenset, actor: str, **values: object) -> None:
    record = contract(fields, {"schema_version": 1, "phase": phase, "pid": os.getpid(), "actor": actor,
                               "at": datetime.now(timezone.utc).isoformat(), **values}, phase)
    with open(path + ".events.jsonl", "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")


# The helper's Git child is `git update-ref --no-deref --stdin`, a direct child
# of the owner, whose identity is durable before Git can prepare. This shell
# records GIT_CHILD_STARTED for its own pid (or, as a forgery, pid 1), with
# stdin kept away from the recorder, then execs Git: same pid, same start
# time, same parent (the owner, through kitlib_run's direct spawn).
CHILD_SHELL = ('fixtures=$1; shift; '
               'child=$$; [ "$4" = foreign ] && child=1; '
               '(CDPATH="" cd -- "$fixtures" && python3 -B ref-txn-witness-fixtures.py record-child '
               '"$1" "$2" "$3" "$child") < /dev/null || exit 97; '
               'exec git update-ref --no-deref --stdin')


def record_child(plan_path: str, argv: list) -> None:
    actor, owner, child = argv[0], int(argv[1]), int(argv[2])
    module = witness()
    value = json.loads(open(plan_path, encoding="utf-8").read(1 << 20))
    journal(module, plan_path, "GIT_CHILD_STARTED", module.CHILD_FIELDS, actor, plan_sha256=value["plan_sha256"],
            child_pid=child, child_pgid=child, child_start=lstart(child), owner_pid=owner)


def drive(repo: str, argv: list) -> int:
    found, rest = options(argv, ("--no-lock", "--foreign-child", "--tamper-lock", "--prepare-only"),
                          ("--actor", "--commands", "--intent-commands"))
    plan_path = os.path.abspath(rest[0])
    os.chdir(repo)
    module = witness()
    checkout = module.Repo()
    value = json.loads(open(plan_path, encoding="utf-8").read(1 << 20))
    commands = json.loads(found["--commands"][0]) if "--commands" in found else module.transaction(checkout, value)
    intent = json.loads(found["--intent-commands"][0]) if "--intent-commands" in found else commands
    actor = found.get("--actor", ["applier"])[0]
    lock_path = os.path.join(checkout.gitdir, "index.lock")
    lock_bytes = b""
    if "--no-lock" not in found:
        lock = contract(module.LOCK_FIELDS, {"operation": module.LOCK_OPERATION, "pid": os.getpid(),
                                             "process_start": lstart(os.getpid()), "nonce": secrets.token_hex(16),
                                             "plan_sha256": value["plan_sha256"], "map": plan_path}, "owner lock")
        lock_bytes = (json.dumps(lock, sort_keys=True) + "\n").encode()
        fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.write(fd, lock_bytes)
        os.close(fd)
        journal(module, plan_path, "PREPARE_INTENT", module.INTENT_FIELDS, actor, plan_sha256=value["plan_sha256"],
                operation=value["operation"], repo=checkout.top, gitdir=checkout.gitdir, transaction=intent,
                expected_tip=value["old_tip"], recover=False, index_before_sha256="0" * 64,
                index_after_sha256="0" * 64, targets_before={}, owner_lock_sha256=hashlib.sha256(lock_bytes).hexdigest())
        if "--tamper-lock" in found:
            lock["nonce"] = secrets.token_hex(16)
            lock_bytes = (json.dumps(lock, sort_keys=True) + "\n").encode()
            with open(lock_path, "wb") as handle:
                handle.write(lock_bytes)
    stream = "start\n" + "\n".join(commands) + "\nprepare\n" + ("" if "--prepare-only" in found else "commit\n")
    if "--no-lock" in found:
        argv_git = ["git", "update-ref", "--no-deref", "--stdin"]
    else:
        mode = "foreign" if "--foreign-child" in found else "own"
        argv_git = ["/bin/sh", "-c", CHILD_SHELL, "child", os.path.dirname(os.path.abspath(__file__)),
                    plan_path, actor, str(os.getpid()), mode]
    try:
        # The guard's reader has a 25 s budget inside Git's prepare; this bound only stops a wedged fixture.
        done = kitlib_run.run(argv_git, deadline_s=120, stdin=stream.encode())
    finally:
        if lock_bytes:
            with open(lock_path, "rb") as handle:
                if handle.read(1 << 20) == lock_bytes:
                    os.unlink(lock_path)
    sys.stderr.write(done.stderr.decode("utf-8", "replace"))
    acks = done.stdout.decode("utf-8", "replace").split()
    acks = [" ".join(acks[i:i + 2]) for i in range(0, len(acks), 2)]
    result = "PREPARE_REFUSED"
    if acks[:2] == ["start: ok", "prepare: ok"]:
        result = "PREPARED_OK" if "--prepare-only" in found else ("COMMITTED" if acks[2:3] == ["commit: ok"] and done.rc == 0
                                                                  else "COMMIT_FAILED")
    if done.timed_out:
        result = "TIMED_OUT"
    print(result)
    return 0 if result in ("COMMITTED", "PREPARED_OK") else 1


def helper_format(source: str) -> int:
    """Compare the reader's pinned contracts with the real helper's record literals (parsed, never executed)."""
    module = witness()
    tree = ast.parse(open(source, encoding="utf-8").read(4 << 20), source)

    def keys(node: ast.Dict) -> set:
        return {k.value for k in node.keys if isinstance(k, ast.Constant) and isinstance(k.value, str)}

    found = {"lock": set(), "journal": set(), "intent": set(), "child": set()}
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict) and {"operation", "nonce", "process_start"} <= keys(node):
            found["lock"] = keys(node)
        if isinstance(node, ast.FunctionDef) and node.name == "journal":
            found["journal"] = set().union(*[keys(d) for d in ast.walk(node) if isinstance(d, ast.Dict)])
        if isinstance(node, ast.Call) and getattr(node.func, "id", "") == "journal" and len(node.args) >= 2:
            phase = node.args[1].value if isinstance(node.args[1], ast.Constant) else None
            if phase == "PREPARE_INTENT":
                found["intent"] = {k.arg for k in node.keywords if k.arg}
            if phase == "GIT_CHILD_STARTED":
                found["child"] |= {k.arg for k in node.keywords if k.arg}
        if isinstance(node, ast.Call) and getattr(node.func, "id", "") == "record_child" and node.args:
            if isinstance(node.args[0], ast.Dict):
                found["child"] |= keys(node.args[0])
    expected = {"lock": set(module.LOCK_FIELDS), "journal": set(module.JOURNAL_FIELDS),
                "intent": set(module.INTENT_FIELDS - module.JOURNAL_FIELDS),
                "child": set(module.CHILD_FIELDS - module.JOURNAL_FIELDS)}
    drift = {name: {"helper": sorted(found[name]), "reader": sorted(expected[name])}
             for name in expected if found[name] != expected[name]}
    print("HELPER_FORMAT_MATCH" if not drift else "HELPER_FORMAT_DRIFT " + json.dumps(drift, sort_keys=True))
    return 0 if not drift else 1


def main() -> int:
    command, target, argv = sys.argv[1], sys.argv[2], sys.argv[3:]
    if command == "build":
        build(target)
        return 0
    if command == "helper-format":
        return helper_format(target)
    if command == "record-child":
        owned_dir(target)
        record_child(target, argv)
        return 0
    repo = os.path.join(owned_dir(target), os.path.relpath(os.path.realpath(target), owned_dir(target)))
    if command == "rewrite":
        rewrite(repo, argv)
    elif command == "plan":
        plan(repo, argv)
    elif command == "forge-review":
        forge_review(repo, argv)
    elif command == "approval":
        approval(repo, argv)
    elif command == "drive":
        return drive(repo, argv)
    else:
        fail("unknown command " + command)
    return 0


if __name__ == "__main__":
    sys.exit(main())
