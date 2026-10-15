---
name: fleet-round
description: "Runs a lock-step fleet round across several projects and validates each director's round report by recomputing it from br, git, tmux, ps and Agent Mail identity files. Use for 'run a fleet round', 'validate the round report', 'round 0 pass bar', 'is the barrier met', 'barrier timer', 'score the predictions', 'spot-check closes'. Covers phases and barriers, report format, the round-0 pass bar (mission, pile, dag, frontier, focus), holder liveness, the barrier timer, close spot-checks and prediction scoring."
license: MIT
distribution: subscribers
---

# Fleet round

> A round report is a claim. The validator recomputes every claim from primary sources, read-only, and a check is PASS only when everything it needs was observed. What it cannot observe is UNKNOWN, never PASS.

## When to use

Triggers: "run a fleet round", "validate this round report", "round 0 pass bar", "is the barrier met", "start the barrier timer", "score the round predictions", "spot-check the round's closes". Run from the chief's seat.

## When NOT to use

- **Restarting panes or re-dispatching.** Routing: `fleet-restart`.
- **Planning the work inside a project.** Routing: `jeff-planning-enhanced`.
- **Fixing what the validator finds.** Directors fix their own trackers; the validator never writes.

## The round

Every project moves through the same phases together. A phase ends at a **barrier**: every director's report for that phase is validated before any project starts the next phase. The barrier timer (below) checks this mechanically.

| Phase (`PHASE:`) | Timebox | Output |
|---|---|---|
| `insight` | 2 h | What the director found: mission, pile, DAG, frontier, focus. Predictions are committed before measuring. |
| `agree` | 1 h | Chief and director agree the focus epics and the sort plan. |
| `execute` (round 0: **sort**) | 8 h | Every bead in the round-start snapshot ends in one outcome (below), with a comment as evidence. |
| `measure` | at the barrier | Director reports measured values; the validator recomputes them. |
| `validate` | at the barrier | Chief runs the validator, spot-checks closes, scores predictions. |

**Roles.** The chief runs rounds and the validator and owns barriers. One director per project reports for it. Workers execute under their director.

**Lending.** A director may lend a seat to another project for **verification only** (re-running a close, reviewing a diff). The seat returns at the next barrier; a lent seat never claims or closes beads in the borrowing project.

## Report format

Labeled lines (`KEY: value` or `KEY <id>: value`, plain text at top level, not inside lists or quotes) plus **exactly one** fenced ` ```json ` block with `"schema": "fleet-round.report/v1"`:

```text
ROUND: 0
PROJECT: app
SEAT: app:0.1
PHASE: insight
STATUS: done
MISSION: README.md:12
FOCUS: app-e1, app-e2, app-e3
PREDICTION P1: at least 80% of in_progress beads have no live seat
CLAIM C1: in_progress = 7
```

```json
{
  "schema": "fleet-round.report/v1",
  "round": 0, "project": "app", "seat": "app:0.1", "phase": "insight", "status": "done",
  "mission": "README.md:12",
  "focus": ["app-e1", "app-e2", "app-e3"],
  "predictions": [{"id": "P1", "metric": "in_progress_assignee_without_live_seat_share", "expect_min": 0.8}],
  "claims": [{"id": "C1", "metric": "in_progress", "value": 7, "evidence": "br list --status in_progress --json"}]
}
```

`ROUND`, `PROJECT`, `SEAT`, `PHASE` (`insight|agree|execute|measure|validate`) and `STATUS` (`done|warn|blocked`) are required on both sides. `MISSION` and `FOCUS` are optional but, when present, must be on both sides. In round 0 only, a repo that states no mission may report `MISSION: PROPOSED` with the drafted text in `"mission_proposed"` (the director drafts, the approver approves at the round-0 summary); a repo that already states one must cite it. Every `CLAIM` line needs a `claims[]` entry with metric, scalar value and an evidence command, and vice versa; the same holds for `PREDICTION` and `predictions[]`.

The report is **REJECTED** when: the json block is missing, malformed or duplicated (a second block anywhere, including inside a list); a required field is missing or duplicated; a line and the JSON disagree (the error names the field and both values); a labeled line is not verbatim in the source (inline markdown or escapes); `MISSION` cites anything but the validator's own mission location; or a claim differs from the validator's recomputation (the error names the claim and both values). A claim on a metric the validator cannot recompute makes the report **UNVERIFIED**, never ACCEPTED.

Recomputable metrics: every status name (`open`, `in_progress`, `in_review`, `blocked`, ...), `total`, `ready`, `orphans`, `cycles`, `blocked_on_closed`, `stale_no_holder`, `missions`.

## Round-0 pass bar

Each check recomputes from sources; none reads the report except for its declared focus.

1. **mission**: exactly one heading `Mission`, `Mission statement`, or `Mission (...)`/`Mission: ...` across the repo-root `*.md` and `docs/**.md` committed at `doc_ref` (never `.flywheel/`), with a statement paragraph and a `STATE: PROPOSED` line. `STATE: APPROVED` needs `APPROVED_BY: <approver> <date>` naming the configured approver. Cited as `path:line` of the heading.
2. **pile**: no `in_progress`/`in_review` bead untouched for more than `stale_hours` (24) without a live holder. With a round-start snapshot, every snapshot bead ends `closed`, `reclaimed` (open, no assignee), `blocked` (owner plus a route comment), `active` (live holder, touched within 24 h) or `review-queue` (`in_review`, or a `DONE <bead> <sha> ...` callback comment), each with a comment since round start.
3. **dag**: every open, in-progress, blocked, in-review or rework bead that is not an epic has a parent (br `parent`, a `parent-child` edge, or an existing dotted-id prefix) or a comment `no-epic: <reason>`; no cycles over `blocks` and parent edges among non-closed beads; no status=blocked bead with a `blocks` edge to a closed bead.
4. **frontier**: `br ready` is non-empty and its top `frontier_top` (3) items sit under a focus epic.
5. **focus**: exactly three distinct ids, each existing, not closed or deferred, and an epic (type `epic` or has children).

**Live holder.** A seat (`session:window.pane`) whose process tree runs an agent and whose Agent Mail identity file binds the assignee with the live `pane_pid`. Plain-text or pid-less identity files are unverified: a match on one is UNKNOWN. No identity directory, no tmux, or no `ps` makes every holder UNKNOWN. Field shapes and their REA evidence: `references/evidence.md`.

The pass bar is FAIL if any check fails, else UNKNOWN if any is unknown, else PASS.

## Commands

```bash
FR="bun <skill dir>/scripts/fleet-round.ts"
$FR collect    --config fleet.json --project app --out raw.json        # read-only capture, replayable
$FR snapshot   --config fleet.json --project app --raw raw.json --out start.json   # round start
$FR check      --config fleet.json --project app --raw raw.json --snapshot start.json --focus app-e1,app-e2,app-e3 --out-json v.json --out-md v.md
$FR validate   --config fleet.json --project app --report report.md --snapshot start.json --out-json v.json
$FR spot-check --config fleet.json --project app --since <round start> --seed <round id>     # 10% of the round's closes, reproducible
$FR score      --measured measured.json --predictions chief.md --predictions app-report.md
$FR barrier    --config fleet.json --round 0 --phase INSIGHT --opened-at <phase open> --state <round dir> --out-json b.json --out-md b.md
```

Exit codes: 0 PASS/ACCEPTED, 1 FAIL/REJECTED, 3 UNKNOWN/UNVERIFIED, 2 usage or unreadable input (`barrier` has its own, below). Without `--raw` every command captures live. The config (`config.example.json`) names each project's tracker `root`, the `repo` and `doc_ref` its mission docs are read at, the identity project keys, tmux sockets and agent markers, and for `barrier` the Agent Mail store, the round's mail project key and the timebox per barrier phase; nothing host-specific is built in.

**Spot-check.** Beads closed between `--since` and now, ordered by `sha256(seed:id)`, first `ceil(rate × n)` (rate 0.1). The same seed and tracker give the same sample; the chief re-runs each sampled close.

**Scoring.** `score` reads prediction documents (`fleet-round.predictions/v1`, or a report's `predictions[]`) and `fleet-round.measured/v1` values. `expect_min`/`expect_max` score the shortfall, `expect` a number scores absolute error within `tolerance`, an object of shares scores the mean absolute share error (HIT when every share is within tolerance), a string scores 0/1. Per author: measured count, hits, hit rate and mean normalized error (error divided by the expectation when it exceeds 1). Unmeasured predictions are listed, never scored.

## Barrier timer

`barrier` replaces watching the round thread. Directors post their report (the format above) to Agent Mail thread `fleet-round-<N>` in the project key `barrier.mail_project`; any sender may post, and the report's own `ROUND`, `PROJECT` and `PHASE` lines say whose report it is. Barrier phases close these report phases: `INSIGHT` → `insight`, `AGREE` → `agree`, `SORT` → `execute`. The deadline is `--opened-at` plus `barrier.hours[PHASE]`.

Per configured project, from the thread's messages whose first `ROUND`/`PROJECT`/`PHASE` lines match:

| Verdict | When |
|---|---|
| `ACCEPTED` | The latest report sent by the deadline is ACCEPTED by `validate` (claims recomputed from the project's tracker). |
| `REJECTED` | That report is REJECTED or UNVERIFIED; the reasons are the validator's. |
| `LATE` | No on-time report was accepted, and one arrived after the deadline. |
| `MISSING` | No report. |
| `UNKNOWN` | Agent Mail's store or the project's tracker could not be read. |

Barrier state: **MET** when every project is ACCEPTED (it can be met early), **OPEN** before the deadline otherwise, **MISSED** after the deadline when any project missed, **UNKNOWN** when only unreadable projects stand between it and MET. Exit: 0 MET, 1 MISSED, 3 any source unavailable (whatever else holds; never MET on unknown), 4 OPEN, 2 usage.

**State.** `--state` is the private round dir (`chmod 700`). `barrier-state.json` there records each report's validation once, when first seen, so later tracker work cannot flip it, and each decided barrier's per-project outcome. `misses in a row` counts a project's consecutive missed barriers; the same blocker (verdict, plus the rejection reasons with numbers ignored) at two consecutive barriers reports the project as **ESCALATE**. Re-running a barrier updates its record, never adds a second one.

**Waking seats (ompkit-axpa).** The timer writes files but wakes nobody unless the config opts in: `barrier.deliver: true` (default false), a top-level `chief: {session, pane}`, and per project `director: {session, pane}` (see `config.example.json`). After judging, the timer sends via `omp-kit send`: a report newly REJECTED (first seen, not from the validation cache) wakes that project's director only — never the chief — with the reasons and `fix and resend to thread fleet-round-<N>`; a barrier first seen MET or MISSED, or a project newly ESCALATE, wakes the chief exactly once with the one-line state and the barrier md path (`--out-md`, or "no barrier md written"). Dedup keys live in `barrier-state.json` under `notified`, so a rerun on unchanged state sends nothing; only `OK`/`DELIVERED` counts as proved — anything else throws, records nothing, and exits 2, so the next run retries it.

**Sources.** Agent Mail's SQLite store (`barrier.agent_mail_db`, opened readonly; `am robot thread` has only relative ages, so it cannot judge a deadline) and each project's tracker via `collect` (`--raw PROJECT=raw.json` replays one). No network: nothing polls GitHub, and `doc_ref` is read as a local ref.

**Running it every 10 minutes.** `references/barrier.launchd.plist` is a template; the kit never installs it. When a phase opens, render it for that round and phase and load it; when the next phase opens, boot it out and render the next one:

```sh
SKILL=<skill dir>; DIR=<private round dir>; PLIST=~/Library/LaunchAgents/com.omp-kit.fleet-round-barrier.plist
sed -e "s|@BUN@|$(command -v bun)|g" -e "s|@SKILL_DIR@|$SKILL|g" -e "s|@CONFIG@|$DIR/fleet.json|g" \
    -e "s|@ROUND@|0|g" -e "s|@PHASE@|INSIGHT|g" -e "s|@OPENED_AT@|2026-10-12T14:00:00Z|g" \
    -e "s|@ROUND_DIR@|$DIR|g" -e "s|@PATH@|$PATH|g" "$SKILL/references/barrier.launchd.plist" > "$PLIST"
plutil -lint "$PLIST" && launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl bootout "gui/$(id -u)/com.omp-kit.fleet-round-barrier"   # phase over
```

Each run writes `barrier-<N>-<PHASE>.json` and `.md` (atomically) and appends its table to `barrier.launchd.log`, all in the round dir with umask 077. The timer only reports: it never sends mail or pane input.

## Never

- Never write to a tracker, send to a pane, or send Agent Mail. `collect` runs br with `--no-auto-import --no-auto-flush`, and reads identity files directly because Agent Mail's resolver may adopt and rewrite them. `barrier` reads Agent Mail's store readonly; its only writes are its state and output files in the round dir.
- Never report PASS for something not observed. Extend `references/evidence.md` with an REA capture before trusting a new field.

## Verification

`bun test tests/cli/fleet-round.test.ts` (planted negatives for each check and each barrier verdict, a clean positive control, the real capture fixture). Regexes: `nice -n 10 bun <regex-engineering skill>/scripts/conformance.mjs references/regex-conformance.json`.
