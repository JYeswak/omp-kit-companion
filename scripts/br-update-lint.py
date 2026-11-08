#!/usr/bin/env python3
"""br-update-lint.py -- LINTGATE1 update path (ompkit-fp72.19.1.28).

Gate content edits to a bead (`br update ID ...`) on the per-bead
bead-lint subset before the write lands. Invoked by the kit-flywheel-guard
extension and by br-shim.sh (full admission for in_review, replayability-only
for claims); also usable directly as a kit `bead update` verb.

Exit contract (shim honors it):
  0  admit (no content flags, or prospective bead passes)
  4  LINT_REFUSED (prospective bead fails; check names on stderr)
  3  UNVERIFIED (infra error reading the tracker; shim passes through
     with a warning, never refusing on a broken probe)

Only lint-relevant content flags trigger evaluation: --title,
-d/--description/--body, --description-file, --acceptance-criteria,
--add-acceptance, --set-labels/--add-label/--remove-label, -t/--type.
Workflow flags (--status/--priority/--assignee/--owner/--claim) and edge
flags (--parent) never newly fail the gated checks and pass through, so
claiming a failing bead for repair is never deadlocked by them; only the
REPLAYABLE1 claim gate below judges a claim.

Repair admission (LINTREPAIR ompkit-fp72.135.3.50): a content edit to a bead
that already fails is admitted when the checks it fails afterwards are a
strict subset of the checks it fails now (it repairs something and breaks
nothing), so a description repair is not frozen behind a failure only a
different fix can clear. It never applies when the same command carries
--claim or --status: those moves are judged exactly as before.

`--status in_review` (ACPHASE1 ompkit-9e9w6): for a bead created at or
after ac_phase.AC_PHASE_CUTOVER the move is refused (exit 4) unless every
[build]/[landed] item is ticked (ac_phase.in_review_admission). The refusal
codes AC_PHASE_UNTAGGED, AC_PHASE_MULTI and AC_UNTICKED_BUILD_LANDED ride
the LINT_REFUSED line, each detailed on its own line. Legacy beads are
admitted with a one-line AC_PHASE_LEGACY notice.

REPLAYABLE1 (ompkit-fp72.135.3.71): on an edit carrying --acceptance-criteria
or --add-acceptance, a non-[v] box the edit adds or changes that `omp-kit
verify` cannot replay (no backticked command, a tag run other than one
scope letter then one known phase, or a first backticked span not followed by
-> <expected> or expect: <expected>) fails r-verify-replayable naming the box
and its corrected shape. Boxes left as stored are reported on an
ACCEPTANCE_NOT_REPLAYABLE_LEGACY line and never refused. The box grammar is
src/verify.ts's, run through scripts/box-lint.ts.

Claim gate (REPLAYABLE1 revision, J-2026-10-29-22 'Migrate at claim,
enforced'): `--claim` and `--status in_review` are refused (exit 4,
REFUSED_NOT_REPLAYABLE on the LINT_REFUSED line) unless `omp-kit verify` can
replay the bead's acceptance as it would stand after the command: at least
one non-[v] box, and every such box replayable. Each bad box is named on its
own REFUSED_NOT_REPLAYABLE line with the corrected shape; once the boxes are
rewritten the claim is admitted. With BR_UPDATE_REPLAYABLE_ONLY=1 (the shim's
claim-only call) only this gate runs.

LANESPLIT1b handoff mode reads decoded DONE lines, not shell syntax: an
absolute literal path (spaces and @ permitted) followed by @ and a Git
object id, or an object id in the invoking checkout. Existing literal directory
interpretations must be unique: a SHA-shaped path segment cannot select a
different checkout, and ambiguous claims fail closed. Shell quoting/escaping
is already decoded here; no eval or recovery is performed. Review entry needs
a source claim; positional, flag, file and stdin DONE comments are gated too.
Repositories that declare fresh-gate.sh keep the bounded ledger requirement:
the latest matching version-2 observation needs integer rc=0 and complete
evidence. HANDOFFREPO1 consumes ~/.claude's own storegate-pass marker, keyed
by tree, first parent, current hook blob and suite-metrics runtime. Queue
success, JSON verdicts and skipped gates are not GREEN. Other repositories
without a supported declared gate fail closed; evidence is never borrowed.

Reads are live (`br show`, `br list`); no JSONL flush is involved, so a
fixed bead passes immediately (LINTGATE1 acceptance 2).
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path
from collections.abc import Iterable
from contextlib import nullcontext
from itertools import chain

import kitlib_run
from kitlib_tmp import owned_tmp


def run(cmd: list[str], cwd: str, timeout: int = 60) -> tuple[int, str, str]:
    result = kitlib_run.run(cmd, cwd=cwd, deadline_s=timeout, stdin=b"",
                            max_output_bytes=64 * 1024 * 1024)
    return (127 if result.timed_out else result.rc,
            result.stdout.decode("utf-8", "replace"),
            result.stderr.decode("utf-8", "replace"))


def split_csv(values: list[str] | None) -> list[str]:
    out: list[str] = []
    for value in values or []:
        out.extend(
            token.strip() for token in value.split(",") if token.strip())
    return out


def parse_update(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument("subcommand", nargs="?")
    parser.add_argument("bead_id", nargs="?")
    parser.add_argument("--status")
    parser.add_argument("--claim", action="store_true")
    parser.add_argument("--title")
    parser.add_argument("-d", "--description", "--body", dest="description")
    parser.add_argument("--description-file")
    parser.add_argument("--acceptance-criteria", "--acceptance",
                        dest="acceptance")
    parser.add_argument("--add-acceptance", action="append", default=[])
    parser.add_argument("--set-labels")
    parser.add_argument("--add-label", action="append", default=[])
    parser.add_argument("--remove-label", action="append", default=[])
    parser.add_argument("-t", "--type")
    args, _ = parser.parse_known_args(argv)
    return args


def has_content_flags(args: argparse.Namespace) -> bool:
    # TIMEAC1 is a lifecycle gate: review entry is linted even when the
    # mutation contains workflow-only flags.
    return any([
        args.status == "in_review",
        args.title is not None,
        args.description is not None,
        args.description_file is not None,
        args.acceptance is not None,
        bool(args.add_acceptance),
        args.set_labels is not None,
        bool(args.add_label),
        bool(args.remove_label),
        args.type is not None,
    ])


def show_bead(real: str, project: str, db: str, bead_id: str) -> dict:
    cmd = [real, "show", bead_id, "--json"]
    cmd.extend(["--no-auto-import", "--no-auto-flush"])
    if db:
        cmd.extend(["--db", db])
    rc, out, err = run(cmd, project)
    if rc != 0:
        raise RuntimeError(f"br show failed rc={rc}: {(err or out)[:300]}")
    try:
        data = json.loads(out)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"br show unparsable: {exc}")
    record = data[0] if isinstance(data, list) else data
    if not isinstance(record, dict) or record.get("id") != bead_id:
        raise RuntimeError(f"br show returned no such bead: {bead_id}")
    return record


def tracker_rows(real: str, project: str, db: str) -> list[dict]:
    cmd = [real, "list", "--status", "all", "--deferred", "--limit", "0",
           "--json"]
    cmd.extend(["--no-auto-import", "--no-auto-flush"])
    if db:
        cmd.extend(["--db", db])
    rc, out, err = run(cmd, project)
    if rc != 0:
        raise RuntimeError(f"br list failed rc={rc}: {(err or out)[:300]}")
    try:
        data = json.loads(out)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"br list unparsable: {exc}")
    rows = data.get("issues", data) if isinstance(data, dict) else data
    return [row for row in rows if isinstance(row, dict) and row.get("id")]


def prospective(
    live: dict, args: argparse.Namespace, project: str
) -> dict:
    bead = {
        "id": live["id"],
        "title": live.get("title") or "",
        "status": live.get("status") or "open",
        "priority": live.get("priority", 2),
        "created_at": live.get("created_at"),
        "assignee": live.get("assignee"),
        "issue_type": args.type or live.get("issue_type") or "task",
        "labels": list(live.get("labels") or []),
        "description": live.get("description") or "",
        "acceptance_criteria": live.get("acceptance_criteria") or "",
        "dependencies": [
            {
                "depends_on_id": dep.get("depends_on_id", dep.get("id")),
                "type": dep.get("type", dep.get("dependency_type")),
            }
            for dep in (live.get("dependencies") or [])
        ],
    }
    if args.title is not None:
        bead["title"] = args.title
    if args.description_file is not None:
        path = args.description_file
        if not os.path.isabs(path):
            path = os.path.join(project, path)
        try:
            with open(path, encoding="utf-8") as handle:
                bead["description"] = handle.read()
        except (OSError, UnicodeError) as exc:
            raise RuntimeError(f"cannot read description file: {exc}")
    elif args.description is not None:
        bead["description"] = args.description
    if args.acceptance is not None:
        bead["acceptance_criteria"] = args.acceptance
    for text in args.add_acceptance:
        # br stores --add-acceptance as a new "- [ ] <text>" box.
        bead["acceptance_criteria"] += f"\n- [ ] {text}"
    if args.set_labels is not None:
        bead["labels"] = split_csv([args.set_labels])
    else:
        bead["labels"].extend(split_csv(args.add_label))
        bead["labels"] = [
            label for label in bead["labels"]
            if label not in set(split_csv(args.remove_label))
        ]
    return bead


def tracker_repo(project: str, db: str) -> str:
    """The repo whose tracker this update writes (see module docstring)."""
    if db:
        beads_dir = os.path.dirname(os.path.realpath(db))
        if os.path.basename(beads_dir) == ".beads":
            return os.path.dirname(beads_dir)
    here = os.path.realpath(project)
    for _ in range(here.count(os.sep) + 1):  # one step per path component
        if os.path.isdir(os.path.join(here, ".beads")):
            return here
        here = os.path.dirname(here)
    return os.path.realpath(project)


def _handoff_source(payload: str, project: str) -> tuple[str, str] | None:
    """Read only the DONE subject, not hashes or email addresses in its explanation."""
    def token(value: str) -> str:
        words = value[:65].partition(":")[0].split(maxsplit=1)
        return words[0] if words else ""

    def sha(value: str) -> bool:
        return 7 <= len(value) <= 64 and all(c in "0123456789abcdefABCDEF" for c in value)

    bare = token(payload)
    if sha(bare):
        return project, bare
    sources: list[tuple[str, str]] = []
    for index, character in enumerate(payload):
        if character != "@":
            continue
        candidate = token(payload[index + 1:index + 66])
        if sha(candidate):
            repo = payload[:index].strip()
            if Path(repo).is_absolute() and Path(repo).is_dir():
                sources.append((repo, candidate))
                if len(sources) > 1:
                    return None
    return sources[0] if sources else None

def _is_commit_sha(value: str) -> bool:
    return 7 <= len(value) <= 64 and all(
        character in "0123456789abcdefABCDEF" for character in value
    )


def _has_absolute_repo_sha(value: str) -> bool:
    subject = value.partition(":")[0]
    for index, character in enumerate(subject):
        if character != "@":
            continue
        candidate = subject[index + 1:index + 66].partition(":")[0].split(maxsplit=1)
        repo = subject[:index].strip()
        if candidate and _is_commit_sha(candidate[0]) and Path(repo).is_absolute():
            return True
    return False


def _field_commit_shas(text: str, field: str) -> Iterable[str]:
    lower = text.lower()
    offset = 0
    hexadecimal = "0123456789abcdefABCDEF"
    while offset < len(lower):
        index = lower.find(field, offset)
        if index < 0:
            return
        offset = index + len(field)
        before = lower[index - 1] if index else ""
        after_index = index + len(field)
        after = lower[after_index] if after_index < len(lower) else ""
        if before.isalnum() or before == "_" or after.isalnum() or after == "_":
            continue
        start = after_index
        while start < len(text) and text[start] in " \t":
            start += 1
        end = start
        while end < len(text) and text[end] in hexadecimal and end - start <= 64:
            end += 1
        candidate = text[start:end]
        if _is_commit_sha(candidate) and (end == len(text) or text[end] not in hexadecimal):
            yield candidate.lower()


def publication_citations(argv: list[str]) -> int:
    """Print repository/SHA pairs for the close guard's fail-closed publication check."""
    if len(argv) != 3 or argv[0] not in ("close", "update"):
        print("PUBLISH_CITATION_UNKNOWN incomplete citation request", file=sys.stderr)
        return 2
    subcommand, project_arg, text = argv
    project = os.path.realpath(project_arg)
    if len(text.encode("utf-8")) > 1024 * 1024:
        print("PUBLISH_CITATION_UNKNOWN transition comment exceeds 1 MiB", file=sys.stderr)
        return 2

    citations: list[tuple[str, str]] = []
    for line in text.splitlines():
        stripped = line.strip()
        is_done = stripped == "DONE" or stripped.startswith("DONE ")
        if is_done:
            payload = stripped[4:].strip()
            source = _handoff_source(payload, project)
            if source is not None:
                citations.append(source)
            else:
                subject = payload.partition(":")[0]
                words = subject.split()
                if words and _is_commit_sha(words[0]):
                    citations.append((project, words[0]))
                elif len(words) > 1 and _is_commit_sha(words[1]):
                    citations.append((project, words[1]))
                elif _has_absolute_repo_sha(subject) and subcommand == "close":
                    print("PUBLISH_CITATION_UNKNOWN DONE source repository is ambiguous or unreadable",
                          file=sys.stderr)
                    return 2
        else:
            source = _handoff_source(line, project)
            if source is not None:
                citations.append(source)
            elif _has_absolute_repo_sha(line) and subcommand == "close":
                print("PUBLISH_CITATION_UNKNOWN cited repository is ambiguous or unreadable",
                      file=sys.stderr)
                return 2
        citations.extend((project, sha) for field in ("export", "commit")
                         for sha in _field_commit_shas(line, field))

    ordered: dict[str, list[str]] = {}
    for repo, sha in citations:
        if "\t" in repo or "\n" in repo or "\r" in repo:
            print("PUBLISH_CITATION_UNKNOWN cited repository path has unsupported control characters",
                  file=sys.stderr)
            return 2
        values = ordered.setdefault(repo, [])
        if sha.lower() not in values:
            values.append(sha.lower())
    for repo, shas in ordered.items():
        for sha in shas:
            print(f"{repo}\t{sha}")
    return 0


def _commit_identity(repo: str, commit: object, cache: dict) -> str | None:
    """The repo's own commit object minus only the committer's `<epoch> <tz>`; None when unresolvable.

    Fresh-gate judges tree, parents, author, committer identity, signatures and message, so only
    the committer time the commit gate's candidate cannot share with the landed commit is dropped.
    """
    if (not isinstance(commit, str) or len(commit) not in (40, 64)
            or not set(commit) <= set("0123456789abcdef")):
        return None
    if commit not in cache:
        rc, body, _ = run(["git", "-C", repo, "cat-file", "-p", commit], repo, 10)
        identity = None
        headers, separator, message = body.partition("\n\n")
        lines = headers.split("\n")
        committers = [i for i, line in enumerate(lines) if line.startswith("committer ")]
        # A lossy decode could make distinct bytes compare equal, so it is never admitted.
        if (rc == 0 and separator and "\ufffd" not in body and lines[0].startswith("tree ")
                and len(committers) == 1):
            name, _, stamp = lines[committers[0]].rpartition("> ")
            if name and len(stamp.split(" ")) == 2:
                lines[committers[0]] = name + ">"
                identity = "\n".join(lines) + separator + message
        cache[commit] = identity
    return cache[commit]


def _fresh_green(repo: str, commit: str) -> bool:
    """A candidate row admits the landed commit only when the objects differ in committer time alone."""
    rc, directory, _ = run(["git", "-C", repo, "rev-parse", "--absolute-git-dir"], repo, 10)
    if rc != 0:
        return False
    ledger = Path(directory.strip()) / "omp-kit" / "fresh-gate-runs.jsonl"
    limit = 8 * 1024 * 1024
    try:
        descriptor = os.open(ledger, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                return False
            size = handle.seek(0, os.SEEK_END)
            start = max(0, size - limit)
            handle.seek(start)
            data = handle.read(limit)
        if start:
            data = data.partition(b"\n")[2]
        if data and not data.endswith(b"\n"):
            return False
        identities: dict = {}
        landed = None
        for line in reversed(data.splitlines()):
            row = json.loads(line)
            if not isinstance(row, dict):
                return False
            if row.get("commit") != commit:
                if landed is None:
                    landed = _commit_identity(repo, commit, identities) or ()
                if not landed or _commit_identity(repo, row.get("commit"), identities) != landed:
                    continue
            evidence = row.get("evidence")
            return (row.get("version") == 2 and type(row.get("rc")) is int and row["rc"] == 0
                    and isinstance(evidence, dict) and evidence.get("complete") is True)
    except (OSError, ValueError, UnicodeError):
        return False
    return False


def handoff_gate(argv: list[str]) -> int:
    if len(argv) < 3 or argv[0] not in ("0", "1"):
        print("br-shim: HANDOFF_UNGATED incomplete admission request; "
              "identify the source checkout with: git rev-parse --show-toplevel", file=sys.stderr)
        return 4
    return _handoff_check(argv[0] == "1", argv[1:3], argv[3:])


def _handoff_kind(repo: str) -> str:
    if repo == os.path.realpath(Path.home() / ".claude"):
        return "storegate"
    rc, _, _ = run(["git", "-C", repo, "cat-file", "-e",
                    "HEAD:scripts/fresh-gate.sh"], repo, 10)
    return "companion" if rc == 0 else "unknown"


def _storegate_green(repo: str, commit: str) -> bool:
    """Consume only the native marker, with exactly the producer's current key."""
    hook = Path(repo) / ".githooks/hooks.d/pre-push/10-pre-push"
    metrics = Path.home() / "Developer/omp-kit-companion/scripts/suite-metrics.py"
    inputs = [
        ["git", "-C", repo, "rev-parse", "--absolute-git-dir"],
        ["git", "-C", repo, "rev-parse", "-q", "--verify", f"{commit}^{{tree}}"],
        ["git", "-C", repo, "rev-parse", "-q", "--verify", f"{commit}^"],
        ["git", "-C", repo, "hash-object", "--", str(hook)],
        ["python3", str(metrics), "runtime"],
    ]
    values = []
    for cmd in inputs:
        rc, out, _ = run(cmd, repo, 10)
        if rc != 0 or not out.strip():
            return False
        values.append(out.strip())
    directory, tree, parent, hook_id, runtime = values
    payload = f"storegate-v2\n{tree}\n{parent}\n{hook_id}\n{runtime}\n".encode()
    result = kitlib_run.run(["git", "-C", repo, "hash-object", "--stdin"],
                            cwd=repo, deadline_s=10, stdin=payload,
                            max_output_bytes=4096)
    if result.rc != 0 or result.timed_out or result.truncated:
        return False
    key = result.stdout.decode().strip()
    return bool(key) and (Path(directory) / "omp-kit/storegate-pass" / key).is_file()


def _handoff_remedy(repo: str, target: str) -> str:
    kind = _handoff_kind(repo)
    if kind == "storegate":
        command = "python3 .githooks/hooks.d/pre-push/storegate-verdict.py"
        if (Path(repo) / ".githooks/hooks.d/pre-push/storegate-verdict.py").is_file():
            return f"cd {shlex.quote(repo)} && {command} queue {shlex.quote(target)}"
    elif kind == "companion" and (Path(repo) / "scripts/fresh-gate.sh").is_file():
        return f"cd {shlex.quote(repo)} && sh scripts/fresh-gate.sh --commit {shlex.quote(target)}"
    for hook in (".githooks/hooks.d/pre-push/10-pre-push", ".githooks/pre-push"):
        if (Path(repo) / hook).is_file():
            return (f"no supported GREEN observation; declared gate: "
                    f"cd {shlex.quote(repo)} && bash {shlex.quote(hook)}")
    return "no declared gate exists in this repository"


def _handoff_claim(repo: str, subject: str, request: list[str]) -> int:
    repo = os.path.realpath(repo)
    commit = ""
    if subject:
        rc, out, _ = run(["git", "-C", repo, "rev-parse", "--verify", f"{subject}^{{commit}}"], repo, 10)
        if rc == 0:
            commit = out.strip()
    kind = _handoff_kind(repo)
    if commit and ((kind == "companion" and _fresh_green(repo, commit))
                   or (kind == "storegate" and _storegate_green(repo, commit))):
        return 0
    target = commit or subject or "<sha>"
    remedy = _handoff_remedy(repo, target)
    print("br-shim: HANDOFF_UNGATED requires a complete GREEN observation for the exact DONE source "
          f"{repo}@{target}; run: {remedy}", file=sys.stderr)
    return 4


def _handoff_check(required: bool, texts: Iterable[str], request: list[str]) -> int:
    project = os.path.realpath(os.environ.get("BR_HANDOFF_PROJECT", os.getcwd()))
    claims: list[tuple[str, str]] = []
    for text in texts:
        for line in text.splitlines():
            line = line.strip()
            if line == "DONE" or line.startswith("DONE "):
                source = _handoff_source(line[4:].strip(), project)
                if source is None:
                    claims.append((project, ""))
                else:
                    claims.append(source)
    if not claims and not required:
        return 0
    if not claims:
        claims.append((project, ""))
    for repo, subject in claims:
        refusal = _handoff_claim(repo, subject, request)
        if refusal:
            return refusal
    return 0


def handoff_file(argv: list[str]) -> int:
    """Validate and dispatch the same private file snapshot, including native -f -."""
    try:
        if len(argv) < 7 or argv[1] not in ("", "-f", "--file="):
            raise ValueError("incomplete file admission request")
        index = int(argv[0])
        command = argv[5:]
        if not 1 <= index < len(command):
            raise ValueError("invalid file argument position")
        if argv[2] == "-" and sys.stdin.isatty():
            raise ValueError("file '-' requires piped stdin, not an interactive terminal")
        with owned_tmp("br-handoff-comment") as directory:
            snapshot = Path(directory) / "comment"
            source = nullcontext(sys.stdin.buffer) if argv[2] == "-" else open(argv[2], "rb")
            with source as reader, snapshot.open("wb") as writer:
                shutil.copyfileobj(reader, writer)
            with snapshot.open(encoding="utf-8") as lines:
                refusal = _handoff_check(False, chain(argv[3:5], lines), command[1:])
            if refusal:
                return refusal
            command[index] = argv[1] + str(snapshot)
            rc, out, err = run(command, os.getcwd())
            sys.stdout.write(out)
            sys.stderr.write(err)
            return rc
    except (OSError, UnicodeError, ValueError) as error:
        print(f"br-shim: HANDOFF_UNGATED comment input could not be verified: {error}; "
              "identify the source checkout with: git rev-parse --show-toplevel", file=sys.stderr)
        return 4


# PARENTBLOCK1 (ompkit-rc-epic-land-fix-release-dogfood-rz5.134): `br dep add P C` with the default blocks type, where
# C is a parent-child descendant of P, parent-blocks every child of P and drops them from br ready. Measured: jev
# 2026-10-13 (54 edges in four waves); omp-kit 2026-11-01 (54 then 51 of ~60 release-train children hidden, four times).
DEP_VALUE_FLAGS = {"-t", "--type", "--metadata", "--db", "--actor", "--lock-timeout"}
PARENT_WALK_LIMIT = 8


def _dep_add_args(argv: list[str]) -> tuple[str, str, str, str] | None:
    """(issue, depends_on, type, db) from a br argv holding `dep add`, or None when it is not one."""
    words: list[str] = []
    dep_type, db, i = "blocks", "", 0
    while i < len(argv):
        arg = argv[i]
        if arg in DEP_VALUE_FLAGS and i + 1 < len(argv):
            if arg in ("-t", "--type"):
                dep_type = argv[i + 1]
            elif arg == "--db":
                db = argv[i + 1]
            i += 2
            continue
        if arg.startswith("--type="):
            dep_type = arg.split("=", 1)[1]
        elif arg.startswith("--db="):
            db = arg.split("=", 1)[1]
        elif not arg.startswith("-"):
            words.append(arg)
        i += 1
    if words[:2] != ["dep", "add"] or len(words) < 4:
        return None
    return words[2], words[3], dep_type, db


def dep_parent_gate(argv: list[str]) -> int:
    """Refuse a blocks edge from a bead onto one of its own parent-child descendants; 0 admits."""
    if not argv:
        return 0
    real, rest = argv[0], argv[1:]
    parsed = _dep_add_args(rest)
    if parsed is None:
        return 0
    issue, depends_on, dep_type, db = parsed
    if dep_type != "blocks" or issue == depends_on:
        return 0
    project = os.environ.get("BR_UPDATE_PROJECT", os.getcwd())
    chain, current = [depends_on], depends_on
    try:
        for _ in range(PARENT_WALK_LIMIT):
            record = show_bead(real, project, db, current)
            parents = [edge.get("id") for edge in record.get("dependencies") or []
                       if isinstance(edge, dict) and edge.get("dependency_type") == "parent-child"]
            if not parents or not isinstance(parents[0], str):
                return 0
            current = parents[0]
            chain.append(current)
            if current == issue:
                print(f"br-shim: PARENT_CHILD_BLOCKS refused: {depends_on} descends from {issue} by parent-child "
                      f"({' -> '.join(reversed(chain))}). A blocks edge from {issue} onto it parent-blocks every child "
                      f"of {issue} and drops them from br ready (rz5.134). {issue} already stays open while a child is "
                      f"open; give {depends_on} its goal path through a release train or a bead on that path instead.",
                      file=sys.stderr)
                return 4
    except RuntimeError as exc:
        print(f"br-shim: PARENT_BLOCK_UNVERIFIED {exc}; passing through", file=sys.stderr)
    return 0


def main(argv: list[str]) -> int:
    if argv[:1] == ["dep-parent"]:
        return dep_parent_gate(argv[1:])
    if argv[:1] == ["handoff"]:
        return handoff_gate(argv[1:])
    if argv[:1] == ["handoff-file"]:
        return handoff_file(argv[1:])
    if argv[:1] == ["publication-citations"]:
        return publication_citations(argv[1:])
    real = os.environ.get("BR_UPDATE_REAL", "br")
    project = os.environ.get("BR_UPDATE_PROJECT", os.getcwd())
    db = os.environ.get("BR_UPDATE_DB", "")
    args = parse_update(argv)
    if args.subcommand != "update" or not args.bead_id:
        return 0
    # REPLAYABLE1 claim gate (J-2026-10-29-22): a claim or an in_review move
    # needs acceptance `omp-kit verify` can replay. br-shim.sh uses replay-only
    # mode for --claim and full admission for --status in_review.
    claim_gate = args.claim or args.status == "in_review"
    replay_only = os.environ.get("BR_UPDATE_REPLAYABLE_ONLY") == "1"
    full = not replay_only and has_content_flags(args)
    if not (full or claim_gate):
        return 0
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    failures: list[str] = []
    replay_notices: list[str] = []
    claim_refusal: list[str] = []
    repair_base = None
    admission = None
    try:
        from bead_lint import (BoxGrammarUnavailable, lint_bead_failures,
                               pitfalls_legacy, replayable_claim_refusal, replayable_findings)
        import ac_phase
        live = show_bead(real, project, db, args.bead_id)
        bead = prospective(live, args, project)
        if claim_gate:
            try:
                claim_refusal = replayable_claim_refusal(bead)
            except BoxGrammarUnavailable as exc:
                replay_notices.append(f"REPLAYABLE_UNVERIFIED {exc}")
        if full:
            rows = tracker_rows(real, project, db)
            byid = {row["id"] for row in rows} | {bead["id"]}
            failures = lint_bead_failures(bead, byid)
            # BEADPITFALL1: a pre-cutover build bead without Pitfalls is reported, never refused.
            for line in pitfalls_legacy(bead):
                print(f"br-update-lint: {line}", file=sys.stderr)
            # REPLAYABLE1: only a box this edit adds or changes can fail; boxes
            # left as stored are reported, never refused. An edit that does not
            # touch acceptance cannot add a box, so it is not judged here (the
            # legacy backlog is bead_lint.py --replayable-report's to list).
            replay_failures: list[str] = []
            if args.acceptance is not None or args.add_acceptance:
                try:
                    replay_failures, notices = replayable_findings(
                        bead, live.get("acceptance_criteria") or "")
                    replay_notices.extend(notices)
                except BoxGrammarUnavailable as exc:
                    replay_notices.append(f"REPLAYABLE_UNVERIFIED {exc}")
            failures = sorted(failures + replay_failures)
            # LINTREPAIR: the live bead's own failures, judged the same way, are the
            # baseline a repair is measured against (content edits only).
            repair_base = (lint_bead_failures(prospective(live, parse_update([]), project), byid)
                           if failures and args.status is None and not args.claim else None)
            admission = (ac_phase.in_review_admission(bead)
                if args.status == "in_review" else None)
    except Exception as exc:  # fail OPEN on probe failure, never refuse blind
        print(f"br-shim: LINT_GATE_UNVERIFIED {exc}", file=sys.stderr)
        return 3
    for notice in replay_notices:
        print(f"br-shim: {notice}", file=sys.stderr)
    details: list[str] = []
    if claim_refusal:
        failures.insert(0, "REFUSED_NOT_REPLAYABLE")
        move = "claimed" if args.claim else "moved to in_review"
        details.append(
            f"br-shim: REFUSED_NOT_REPLAYABLE {bead['id']}: omp-kit verify cannot replay this "
            f"bead's acceptance, so it cannot be {move} until each box below is rewritten in the "
            f"verify grammar (keep every obligation word for word; J-2026-10-29-22), then retry")
        details.extend(f"br-shim: REFUSED_NOT_REPLAYABLE {line}" for line in claim_refusal)
    if admission is not None:
        if admission["notice"]:
            print(f"br-shim: {admission['notice']}", file=sys.stderr)
        lint_tagged = any(f.startswith("l-ac-phase:") for f in failures)
        for code, detail in admission["refusals"]:
            # check l already names untagged/multi items for enforced beads.
            if lint_tagged and code in ("AC_PHASE_UNTAGGED", "AC_PHASE_MULTI"):
                continue
            failures.append(code)
            details.append(f"br-shim: {code} {detail}")
    if failures and repair_base is not None:
        after = {f.split(":", 1)[0] for f in failures}
        before = {f.split(":", 1)[0] for f in repair_base}
        if after < before:
            print(f"br-shim: LINT_REPAIR_ADMITTED {bead['id']}: this edit clears "
                  f"{','.join(sorted(before - after))} and adds no failure; still failing "
                  f"{','.join(sorted(after))}, so a claim or review move stays refused until those pass",
                  file=sys.stderr)
            return 0
    if failures:
        print(f"br-shim: LINT_REFUSED {','.join(failures)}: this edit "
              f"would leave {bead['id']} failing bead-lint or in_review "
              f"admission; fix the named checks and retry", file=sys.stderr)
        for line in details:
            print(line, file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
