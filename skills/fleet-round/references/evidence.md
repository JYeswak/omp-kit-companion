# Evidence for every field and enum the validator trusts

The tracker fields below were observed with br 0.7.4 on darwin arm64, 2026-10-12,
through REA `capture_process_scenario` (6.4.0, `confidence: observed`). Run the tracker
probes from a tracker root to re-observe. Facts not observed at runtime stay UNKNOWN.

| Evidence id | Command (cwd: tracker root) | Observed |
|---|---|---|
| `ev_29c921317dabf45546e9024f21353b29f9f8b3333913e53468ab4a96a284eef5` | `br schema issue --json` | `Status` enum `open, in_progress, blocked, deferred, draft, closed, tombstone, pinned`, **plus any string** (anyOf). No `in_review` in br itself. `IssueType` adds `epic`. `DependencyType` includes `blocks`, `parent-child`. Comment fields `id, issue_id, author, text, created_at`. |
| `ev_856aee15ae26dc7b41257fd3fd37e6503082a1824c4db70cd9662a27fa7c1d28` | `python3 probes/br_shapes.py list` | `br list --all --limit 0 --json` is `{issues, total, limit, offset, has_more}`. Rows carry no `dependencies`, `comments` or `parent`, and omit null fields (a row without `assignee`). |
| `ev_ea991ac45fd710d2c5061246c93af7b0c11c5d4b965ea886eb318340066dfb34` | `python3 probes/br_shapes.py show ompkit-v66l.4 ompkit-v66l ompkit-3isy.1` | `br show ID... --json` is a JSON array. A child carries `parent` (string) and a `parent-child` entry in `dependencies`; a root has no `parent` key. Edge entries are `{id, title, status, priority, dependency_type}` (not the schema's `Dependency` record). |
| `ev_d5865132473c280e324962c08b3d4f6ead653455f81372c3369041be4334fd50` | `python3 probes/br_shapes.py ready` | `br ready --limit 0 --json` is a bare array of rows in br's ranking order. |
| `ev_d56befd98abe2642e7ae62305853024955e5c9f8f91521bb0dfbaba6e4c9c287` | `python3 probes/br_shapes.py cycles` | `br dep cycles --json` reports 0 cycles in scope `active`; the validator recomputes cycles itself (Tarjan over `blocks` and parent edges among non-terminal beads). |
| `ev_6c5785b567b4bc4f1be7e8773b869951d45d96dbedbcc5cae37832d18a33c078` | `python3 probes/edge_shapes.py` | Dependency types in use: `blocks` 432, `parent-child` 305, `related` 94, `discovered-from` 1. A `blocks` edge is stored on the dependent and names the blocker. Two status=blocked beads point at closed blockers (`rz5.45 -> jdeq`, `rz5.45 -> rz5.36`); `tests/fixtures/fleet-round/real-omp-kit.raw.json` reproduces both. |

`tests/fixtures/fleet-round/real-omp-kit.raw.json` is a historical tracker capture.
Its former seat evidence cannot establish a current holder.

## Current Board and Tern evidence

- **Thread:** `vb read <root> --json` returns a `message`, `replies`, and `cursor`.
  Live read of root `20195` and reply `20218`, channel `omp-kit`, 2026-11-28:
  ids are decimal strings; the native `thread` is not the root id. The root has
  `re` and `replyTo` null; the reply has `re` set to the root id. Both carry
  `createdAt`, nullable `editedAt`, `deleted`, `revision`, `by.actor`, `by.profile`, and `text`.
  The validator requires exact root, channel, thread and reply linkage. A revision cannot inherit
  the validation or deadline time of a different revision.
- **Seat:** `tern inspect --json` supplies the session/tab/block tree and per-pane cwd and exit
  status; `tern process <id> --json` supplies the foreground process for that exact pane.
  The same native Tern decoders used for kit sends verify the lossless block id and
  project-local foreground OMP process. The project configuration maps an expected holder to
  that session and pane; hostname or Board profile alone does not prove occupancy.

## What the validator does with each fact

- **Statuses.** Declared statuses come from `.beads/policy.yaml` `workflow.statuses` (parsed with
  `Bun.YAML`), else br's built-in enum. Held statuses are `in_progress` and `in_review`.
- **Null fields.** br omits null keys, so an absent `assignee`, `owner`, `closed_at` or `parent` is
  read as null. A required field (`id`, `status`, `issue_type`, `created_at`, `updated_at`) that is
  absent or mistyped throws `ShapeError` naming it; `br list` `total` must equal its row count.
- **Parent link.** `parent` from `br show`, else a `parent-child` dependency, else the dotted-id
  prefix when that bead exists.
- **Holder liveness.** LIVE requires an exact project-configured pane with the trusted
  Tern inventory and matching foreground OMP process proof. An observed exit on that exact
  configured project pane is DEAD. Missing, ambiguous, unmatched and legacy-only observations
  are UNKNOWN. If any stale holder is unknown, no exact `stale_no_holder` metric is published.
