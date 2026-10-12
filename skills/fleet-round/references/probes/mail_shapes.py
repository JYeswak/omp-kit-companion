"""Read-only projection of Agent Mail's message store (fleet-round barrier evidence probe).

Usage: python3 mail_shapes.py DB PROJECT_KEY THREAD_ID [SENT_BODY_FILE]

Opens the SQLite store with mode=ro (no writes, no WAL checkpoint) and prints the columns the
barrier timer reads, how many projects carry the key, and per message of the thread: id,
created_ts (raw and as UTC ISO), sender, body size and SHA-256, and whether body_md equals the
body that was sent (when SENT_BODY_FILE is given). Bodies themselves are not printed.
"""
import datetime
import hashlib
import sqlite3
import sys

db, key, thread = sys.argv[1], sys.argv[2], sys.argv[3]
sent = open(sys.argv[4], encoding="utf-8").read() if len(sys.argv) > 4 else None
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
for table in ("projects", "agents", "messages"):
    cols = [(r[1], r[2], bool(r[3])) for r in con.execute(f"PRAGMA table_info({table})")]
    print(table, cols)
projects = con.execute("SELECT id FROM projects WHERE human_key = ?", (key,)).fetchall()
print("projects_with_key", len(projects))
rows = con.execute(
    "SELECT m.id, m.created_ts, typeof(m.created_ts), a.name, m.body_md FROM messages m"
    " JOIN projects p ON p.id = m.project_id LEFT JOIN agents a ON a.id = m.sender_id"
    " WHERE p.human_key = ? AND m.thread_id = ? ORDER BY m.created_ts, m.id",
    (key, thread),
).fetchall()
print("thread_messages", len(rows))
for mid, ts, kind, sender, body in rows:
    iso = datetime.datetime.fromtimestamp(ts / 1_000_000, datetime.timezone.utc).isoformat() if kind == "integer" else None
    digest = hashlib.sha256(body.encode()).hexdigest()
    print("message", mid, ts, kind, iso, sender, len(body.encode()), digest, "body_equals_sent" if sent == body else "body_differs_or_unchecked")
