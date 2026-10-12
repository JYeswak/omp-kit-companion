# Evidence for every field and enum the validator trusts

Each fact below was observed on the reference host (darwin arm64, br 0.7.4, tmux socket under
`~/.tmux-sockets`, Agent Mail identity files under `~/.config/agent-mail/identity`) on 2026-10-12,
through REA process captures (`capture_process_scenario`, REA 6.4.0, `confidence: observed`). The
probe scripts are in `probes/`; run them from a tracker root to re-observe. Facts the validator
could not observe are reported UNKNOWN at run time, never assumed.

| Evidence id | Command (cwd: tracker root) | Observed |
|---|---|---|
| `ev_29c921317dabf45546e9024f21353b29f9f8b3333913e53468ab4a96a284eef5` | `br schema issue --json` | `Status` enum `open, in_progress, blocked, deferred, draft, closed, tombstone, pinned`, **plus any string** (anyOf). No `in_review` in br itself. `IssueType` adds `epic`. `DependencyType` includes `blocks`, `parent-child`. Comment fields `id, issue_id, author, text, created_at`. |
| `ev_856aee15ae26dc7b41257fd3fd37e6503082a1824c4db70cd9662a27fa7c1d28` | `python3 probes/br_shapes.py list` | `br list --all --limit 0 --json` is `{issues, total, limit, offset, has_more}`. Rows carry no `dependencies`, `comments` or `parent`, and omit null fields (a row without `assignee`). |
| `ev_ea991ac45fd710d2c5061246c93af7b0c11c5d4b965ea886eb318340066dfb34` | `python3 probes/br_shapes.py show ompkit-v66l.4 ompkit-v66l ompkit-3isy.1` | `br show ID... --json` is a JSON array. A child carries `parent` (string) and a `parent-child` entry in `dependencies`; a root has no `parent` key. Edge entries are `{id, title, status, priority, dependency_type}` (not the schema's `Dependency` record). |
| `ev_d5865132473c280e324962c08b3d4f6ead653455f81372c3369041be4334fd50` | `python3 probes/br_shapes.py ready` | `br ready --limit 0 --json` is a bare array of rows in br's ranking order. |
| `ev_d56befd98abe2642e7ae62305853024955e5c9f8f91521bb0dfbaba6e4c9c287` | `python3 probes/br_shapes.py cycles` | `br dep cycles --json` reports 0 cycles in scope `active`; the validator recomputes cycles itself (Tarjan over `blocks` and parent edges among non-terminal beads). |
| `ev_6c5785b567b4bc4f1be7e8773b869951d45d96dbedbcc5cae37832d18a33c078` | `python3 probes/edge_shapes.py` | Dependency types in use: `blocks` 432, `parent-child` 305, `related` 94, `discovered-from` 1. A `blocks` edge is stored on the dependent and names the blocker. Two status=blocked beads point at closed blockers (`rz5.45 -> jdeq`, `rz5.45 -> rz5.36`); `tests/fixtures/fleet-round/real-omp-kit.raw.json` reproduces both. |
| `ev_b2815cbd0659536f966aa190653a5019dec515fe34172d52b7284a2e9455fd7d` | earlier revision of `probes/seat_shapes.py` (SHA-256 hypothesis) | tmux panes (`session:window.pane`, `%id`, `pane_pid`); an agent pane's tree holds `bun .../pi-coding-agent/dist/cli.js ...`; `.beads/policy.yaml` declares `statuses: [open, in_progress, in_review, rework, blocked, deferred, closed]` (so `in_review` exists only where a policy declares it). The identity directory `sha256(project)[:12]` does **not** exist: hypothesis disproved. |
| `ev_4a897407475922ed96961a26f10e91dcefb05c79ac5fbb94262a875cec265385` | `python3 probes/seat_shapes.py SOCKET IDENTITY_ROOT <jev root> POLICY` | Identity directory is `sha1(project)[:12]`. Three file shapes in use: plain-text name, JSON `{"name"}`, and JSON `{"name","session_name","pane_id","pane_pid","socket_path","written_at"}` whose `pane_pid` equals the live pane's. Files are keyed by bare pane id (`%26` -> `26`) and by composite key (`omp-test:0:1` -> `omp-test-0-1`). |

Source evidence (structural, ast-grep over `mcp_agent_mail_rust@22fdcb13`,
`crates/mcp-agent-mail-core/src/pane_identity.rs`): `project_hash` is SHA-1 truncated to 12 hex
chars (lines 459-465); `sanitize_pane_id` strips one leading `%`, keeps `[A-Za-z0-9_-]`, maps `:`
to `-` and anything else to `_` (lines 476-493). `lib/model.ts` mirrors both.

Probe SHA-256 at capture: `br_shapes.py` 8007ecde...e6e4f31e, `edge_shapes.py`
0086258d...e98571c1, `seat_shapes.py` e7b1ae7a...d5c73e00 (the version captured by
`ev_4a8974...`), `mail_shapes.py` 2a62b058...01106aa0.

## Agent Mail round thread (barrier timer)

Observed 2026-10-12 with `am` 0.3.36 on the same host, REA 6.4.0 process captures. To see a real
round report in the store, one report (the format in SKILL.md, project `app`, phase `insight`) was
posted with `am mail send --thread-id fleet-round-0` into a scratch project key under
`omp-test/var/agent-tmp/`, not into any fleet project.

| Evidence id | Command | Observed |
|---|---|---|
| `ev_245b51e80d4d68d03d5e222ae9b81af7ced4d9a66a609a66332096120dea9327` | `python3 probes/mail_shapes.py <AGENT_MAIL_STORAGE_ROOT>/storage.sqlite3 <scratch key> fleet-round-0 <sent body>` | The store opens with `mode=ro`. `projects(id, slug, human_key, created_at)`, `agents(id, project_id, name, ...)`, `messages(id, project_id, sender_id, thread_id, topic, subject, body_md, importance, ack_required, created_ts, recipients_json, attachments)`; a thread is `messages.thread_id` within one `project_id`; exactly one project carries the key. `created_ts` is an **integer in microseconds** (`1791768295454448` = `2026-10-12T01:24:55.454448Z`, the time `am mail send` returned). `body_md` equals the sent body byte for byte (454 bytes, sha256 `d4b76cf2...`), so labeled lines and the json fence reach the validator unchanged. |
| `ev_add0714a2163181c6219e8cf87b0dbf96b036cf7d2394c4c9212dc66c3790f90` | `am robot thread fleet-round-0 --project <key> --json`, then an absent thread and an absent project key | Thread messages carry `ack, age, body, from, importance, position, subject, to`: no message id and only a relative `age` (`25s ago`), so a deadline cannot be judged from it. An absent thread and an absent project both exit 1 with an `error: invalid argument: ... not found` line. The timer therefore reads the store, not `am`. |

`am robot search` was not used: on this host it tried to take the search index writer lock
(`LockBusy`) and reported the index unavailable, so it is neither read-only nor reliable.

## What the validator does with each fact

- **Statuses.** Declared statuses come from `.beads/policy.yaml` `workflow.statuses` (parsed with
  `Bun.YAML`), else br's built-in enum. Held statuses are `in_progress` and `in_review`.
- **Null fields.** br omits null keys, so an absent `assignee`, `owner`, `closed_at` or `parent` is
  read as null. A required field (`id`, `status`, `issue_type`, `created_at`, `updated_at`) that is
  absent or mistyped throws `ShapeError` naming it; `br list` `total` must equal its row count.
- **Parent link.** `parent` from `br show`, else a `parent-child` dependency, else the dotted-id
  prefix when that bead exists.
- **Holder liveness.** LIVE needs a verified binding: a JSON identity file whose `pane_pid` (and
  `pane_id`, when present) equals the live pane's, on a pane whose process tree runs an agent
  (`agent_markers`, default the two omp command shapes above). Plain-text and pid-less JSON files
  are what Agent Mail calls legacy-unverified: a match on one is UNKNOWN. A pid mismatch is a dead
  binding. DEAD means every source was read and no agent pane binds the name. A missing identity
  directory, unreachable tmux or missing `ps` makes every holder UNKNOWN.
- **Never Agent Mail's resolver.** `resolve_pane_identity` may adopt a dead binding and rewrite the
  file, so the validator only reads the files.
- **Round thread.** `barrier` opens the store readonly, checks that every column it reads exists
  (a missing one is schema drift: UNKNOWN, exit 3), requires exactly one project with the
  configured key (none or several: UNKNOWN), and reads `id`, sender `name`, `created_ts` (must be
  an SQLite integer; divided by 1000 for milliseconds) and `body_md` of the thread's messages. The
  configured key existing with no thread is a fact (MISSING), not an unknown.
