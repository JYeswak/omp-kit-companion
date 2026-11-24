#!/usr/bin/env python3
"""AMREPLAY1 (ompkit-wy0ka): replay or discard Agent Mail UNSENT artifacts.

On the load-watch tick, when the Agent Mail server answers: for each artifact
under pending_sends with status UNSENT_UNTIL_REPLAY, match a delivered copy
(same sender, exact subject, overlapping recipient, archive copy created at or
after the artifact; ported from Fuchsia scripts/sg/mail_unsent_audit.py) and
  - delivered copy -> `am mail discard-queued --artifact PATH --reason delivered`
  - older than --max-age-h (default 72) -> discard with reason stale
  - older than --replay-max-age-h (default 72; first live run uses 24) -> hold
    (listed, neither replayed nor discarded)
  - else -> `am mail replay-queued --artifact PATH` exactly once (replay and
    discard receipts are terminal siblings the reader skips, so a second tick
    replays nothing twice)
With --list-only nothing is replayed or discarded. Prints one JSON report with
unsent_count and oldest_age_hours over artifacts needing action, plus p1 which
is true when any of them is older than 1 h. Exits 0 unless the report itself
cannot be built; per-item am failures are recorded in errors, never thrown, so
one bad artifact cannot fail the tick.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import kitlib_run  # noqa: E402  (bounded child runs; sibling in every release)

UNSENT_STATUS = "UNSENT_UNTIL_REPLAY"
SLUG_PREFIX = 50
FRONT_OPEN, FRONT_CLOSE = "---json\n", "\n---\n"
P1_AGE_H = 1.0
AM_DEADLINE_S = 60.0


def parse_ts(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def norm_subject(text: object) -> str:
    return " ".join(str(text or "").lower().split())


def recipients(envelope: dict) -> set[str]:
    names: set[str] = set()
    for key in ("to", "cc", "bcc"):
        value = envelope.get(key)
        items = value if isinstance(value, list) else [value]
        for item in items:
            if isinstance(item, str) and item.strip():
                names.add(item.strip())
            elif isinstance(item, dict) and isinstance(item.get("name"), str) and item["name"].strip():
                names.add(item["name"].strip())
    return names


def read_artifact(path: Path) -> dict | None:
    """One UNSENT row, or None for receipts, foreign schemas and unreadables."""
    try:
        data = json.loads(path.read_bytes()[: 1024 * 1024])
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("status") != UNSENT_STATUS:
        return None
    envelope = data.get("envelope")
    created = parse_ts(data.get("created_ts"))
    if not isinstance(envelope, dict) or created is None or not isinstance(envelope.get("project_key"), str):
        return None
    failure = data.get("failure")
    return {
        "artifact": path.name, "path": str(path), "created": created,
        "project": envelope["project_key"], "sender": str(envelope.get("sender") or ""),
        "recipients": recipients(envelope), "subject": str(envelope.get("subject") or ""),
        "failure_class": str(failure.get("class")) if isinstance(failure, dict) else "unknown",
    }


def frontmatter(path: Path) -> dict | None:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    if not text.startswith(FRONT_OPEN):
        return None
    end = text.find(FRONT_CLOSE, len(FRONT_OPEN) - 1)
    if end < 0:
        return None
    try:
        meta = json.loads(text[len(FRONT_OPEN):end + 1])
    except ValueError:
        return None
    return meta if isinstance(meta, dict) else None


class Archive:
    """Delivered messages of one project, looked up by subject slug and month."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._by_slug: dict[str, dict[str, list[tuple[str, Path]]]] = {}

    def candidates(self, project: str, subject: str, since: datetime) -> list[Path]:
        folder = self.root / slug(project) / "messages"
        key = str(folder)
        if key not in self._by_slug:
            index: dict[str, list[tuple[str, Path]]] = {}
            for month in sorted(folder.glob("[0-9][0-9][0-9][0-9]/[0-9][0-9]")):
                for path in month.glob("*.md"):
                    parts = path.stem.split("__", 2)
                    if len(parts) == 3:
                        index.setdefault(parts[1][:SLUG_PREFIX], []).append((parts[0], path))
            self._by_slug[key] = index
        floor = since.strftime("%Y-%m-%dT%H-%M-%SZ")
        return [path for stamp, path in self._by_slug[key].get(slug(subject)[:SLUG_PREFIX], []) if stamp >= floor]


def delivered_later(row: dict, archive: Archive) -> bool:
    wanted = norm_subject(row["subject"])
    for path in archive.candidates(row["project"], row["subject"], row["created"].replace(microsecond=0)):
        meta = frontmatter(path)
        if meta is None or str(meta.get("from") or "") != row["sender"]:
            continue
        if norm_subject(meta.get("subject")) != wanted:
            continue
        sent = parse_ts(meta.get("created"))
        if sent is None or sent < row["created"] - timedelta(seconds=1):
            continue
        if recipients(meta) & row["recipients"]:
            return True
    return False


def am_run(am_bin: str, args: list[str], deadline_s: float) -> tuple[bool, str]:
    result = kitlib_run.run([am_bin, *args], deadline_s=deadline_s, max_output_bytes=65536)
    out = (result.stdout.decode("utf-8", "replace") if isinstance(result.stdout, bytes) else str(result.stdout or ""))
    err = (result.stderr.decode("utf-8", "replace") if isinstance(result.stderr, bytes) else str(result.stderr or ""))
    if result.rc == 0 and not result.timed_out and not result.killed:
        return True, out.strip()
    detail = err.strip() or out.strip() or f"rc={result.rc} timed_out={result.timed_out} killed={result.killed}"
    return False, detail[:500]


def tick(pending: Path, archive_root: Path, now: datetime, args: argparse.Namespace) -> dict:
    rows: list[dict] = []
    for path in sorted(pending.glob("*.json")):
        # Replay and discard receipts are terminal siblings; the base artifact
        # keeps its UNSENT status, so a consumed base must not replay twice.
        stem = path.name[:-5] if path.name.endswith(".json") else path.name
        if (path.with_name(stem + ".sent.json")).exists() or (path.with_name(stem + ".discarded.json")).exists():
            continue
        row = read_artifact(path)
        if row is not None:
            rows.append(row)
    archive = Archive(archive_root)
    planned: list[tuple[dict, float, str]] = []
    for row in sorted(rows, key=lambda r: (r["created"], r["artifact"])):
        age_h = (now - row["created"]).total_seconds() / 3600
        if delivered_later(row, archive):
            planned.append((row, age_h, "discard-delivered"))
        elif age_h > args.max_age_h:
            planned.append((row, age_h, "discard-stale"))
        elif age_h > args.replay_max_age_h:
            planned.append((row, age_h, "hold"))
        else:
            planned.append((row, age_h, "replay"))
    # Observed before acting: what this tick saw needing action.
    observed = [(row, age_h) for row, age_h, kind in planned if kind in ("replay", "hold")]
    oldest = round(max((age_h for _, age_h in observed), default=0.0), 2)
    replayed: list[str] = []
    discarded: list[dict] = []
    held: list[str] = [row["artifact"] for row, _, kind in planned if kind == "hold"]
    errors: list[dict] = []
    acting = 0
    # Replays first: the point of the tick is delivering mail; discards are
    # hygiene. Stable sort keeps oldest-first within each kind. Holds were
    # already collected above and are skipped again below.
    planned.sort(key=lambda item: 0 if item[2] == "replay" else 1)
    for row, age_h, kind in planned:
        if args.list_only:
            if kind == "replay":
                replayed.append(row["artifact"])
            elif kind != "hold":
                discarded.append({"artifact": row["artifact"], "reason": kind.split("-")[1]})
            continue
        if kind == "hold":
            continue
        if acting >= args.max_actions:
            held.append(row["artifact"])
            continue
        acting += 1
        if kind == "replay":
            ok, detail = am_run(args.am_bin, ["mail", "replay-queued", "--artifact", row["path"]], args.deadline_s)
            if ok:
                replayed.append(row["artifact"])
            else:
                errors.append({"artifact": row["artifact"], "op": "replay", "detail": detail})
        else:
            reason = f"AMREPLAY1: {kind.split('-')[1]}, {age_h:.1f}h old"
            ok, detail = am_run(args.am_bin, ["mail", "discard-queued", "--artifact", row["path"], "--reason", reason], args.deadline_s)
            if ok:
                discarded.append({"artifact": row["artifact"], "reason": kind.split("-")[1]})
            else:
                errors.append({"artifact": row["artifact"], "op": "discard", "detail": detail})
    return {
        "schema_version": "am-replay-report.v1", "unsent_count": len(observed),
        "oldest_age_hours": oldest, "replayed": sorted(replayed),
        "discarded": sorted(discarded, key=lambda d: d["artifact"]), "held": sorted(held),
        "errors": errors, "p1": oldest > P1_AGE_H,
        "p1_reason": f"undelivered artifact older than {P1_AGE_H}h" if oldest > P1_AGE_H else "",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["tick", "list"], help="tick acts (or only lists with --list-only); list is tick --list-only")
    parser.add_argument("--pending", default=str(Path.home() / ".local/share/mcp-agent-mail-rust-live/pending_sends"))
    parser.add_argument("--archive", default=str(Path.home() / ".local/share/mcp-agent-mail-rust-live/projects"))
    parser.add_argument("--am-bin", default="am")
    parser.add_argument("--max-age-h", type=float, default=72.0)
    parser.add_argument("--replay-max-age-h", type=float, default=72.0)
    parser.add_argument("--max-actions", type=int, default=10)
    parser.add_argument("--deadline-s", type=float, default=AM_DEADLINE_S)
    parser.add_argument("--list-only", action="store_true")
    parser.add_argument("--actor", default="")
    args = parser.parse_args(argv)
    if args.command == "list":
        args.list_only = True
    now = datetime.now(timezone.utc)
    try:
        report = tick(Path(args.pending), Path(args.archive), now, args)
    except Exception as exc:  # never fail the tick on a report-building error
        print(json.dumps({"schema_version": "am-replay-report.v1", "unsent_count": -1,
                           "oldest_age_hours": -1.0, "replayed": [], "discarded": [],
                           "held": [], "errors": [{"artifact": "", "op": "report", "detail": str(exc)[:300]}],
                           "p1": True, "p1_reason": "report failed to build"}))
        return 0
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
