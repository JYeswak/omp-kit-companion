# SENDFAST1 send latency (ompkit-fp72.135.3.84)

Measured 2026-10-30T01:3xZ to 02:2xZ by PeachLeopard's build worker (Claude, Opus family) on an Apple M3 Ultra,
macOS 26.5.2, Bun 1.4.3, checkout `main`.

SENDFAST1 commits:
- `c325ce74e7`: steer a busy keyless seat.
- `1f460ae7bb`: 50 ms stat-gated proof read.
- `7173214e9b`: a working seat whose branch ends in injected context reads BUSY for the steer.
- `67731a3d5f`: the active leaf follows the unique child chain below a stale `activeLeafId` hint.

SENDOMP1 (`effdad51a8`, `bdf5d443b8`) is also at HEAD. The base was `4d8fef8a73`.

## Keys (live, `bun run src/cli.ts send`, HEAD `67731a3d5f`, one owned throwaway seat; nearest-rank p95)

```
sendfast_n_refused: 20
sendfast_p50_refused_s: 0.072
sendfast_p95_refused_s: 0.076
sendfast_n_idle: 20
sendfast_p50_idle_s: 2.171
sendfast_p95_idle_s: 2.373
sendfast_n_busy: 20
sendfast_p50_busy_s: 0.720
sendfast_p95_busy_s: 2.251
```

Against the bead's budget (refusal within 0.5 s; a proven send p95 within 3 s):
- **Refused:** within budget.
- **Busy:** p95 is within budget. 19 of the 20 busy sends were proven; one was NOT_DELIVERED `TERN_COMPOSER_BUSY` in
  3.24 s (see the composer-record finding below).
- **Idle:** 19 of 20 proven, with max 2.483 s, so the proven p95 is within budget. The other was refused
  `SEAT_REBOUND` in 0.244 s with zero sends, which is within the 0.5 s refusal budget. About 2.1 s of every idle send
  is OMP's own pre-turn auto-thinking call (see below).
- Every case is broken down send by send below; nothing is averaged away.

## Fixture scenarios (owned fake Tern surface, real timers, real session file)

Harness: `proveTernCliSend` with an owned fake `tern` surface (inspect, process, ps, am, paste, keys) and a real
session file. On Enter, OMP is simulated by journaling the entry 50 ms later, as a steering entry on a busy seat. The
composer verdict is injected. The CLI's own `untilDeliveredMs` default (300 s) applies. Busy seats use a mid-turn journal: the
assistant is awaiting a tool call. Times are wall clock per call. p95 is nearest-rank.

| Scenario | Before (base) | After lever 1 | After lever 2 |
|---|---|---|---|
| refused target (`tern:999999999`, not in inspect) | p50 0 ms / p95 0 ms, `REFUSED/OBSERVATION_UNKNOWN` (20) | 0 / 0 ms, same (20) | 0 / 0 ms, same (20) |
| idle seat, EMPTY composer | p50 1002 / p95 1010 ms, `OK/PROVEN` (20) | 1003 / 1004 ms, `OK/PROVEN` (20) | **53 / 55 ms**, `OK/PROVEN` (20) |
| busy seat, EMPTY composer | over the 5000 ms harness cap in 3 of 3 runs. The code waits up to 300 s, then returns `NOT_DELIVERED/UNTIL_DELIVERED_EXHAUSTED` with nothing pasted | 1004 / 1023 ms, `OK/PROVEN_STEERED` (20) | **52 / 53 ms**, `OK/PROVEN_STEERED` (20) |
| busy seat, DRAFT composer | over the 5000 ms cap in 3 of 3 runs (designed 300 s) | 3003 / 3004 ms, `NOT_DELIVERED/TERN_COMPOSER_BUSY` with a drop copy and nothing pasted (5) | 3003 / 3004 ms, same (5) |

What each lever removed:
- Hotspot 1, the 300 s turn-boundary wait, applied to every keyless message. Lever 1 removed it: a BUSY seat with an
  EMPTY composer record is pasted at once. DRAFT and UNKNOWN composers wait at most `TERN_STEER_BOUND_MS` (3 s).
- Hotspot 2 was the 1000 ms proof poll grid. Lever 2 removed it: the proof is read every 50 ms within the same 20 s
  deadline, and the session file is re-read only when its size grew.
- Hotspot 3, the pane-lock retry loop, was left unchanged. It only costs time under contention for one pane, and no
  scenario here contends.

## Live measurement (`bun run src/cli.ts send ...`, not the installed kit)

Refused target: 20 timed runs through hyperfine (`-N -i --runs 20`). An earlier single smoke run returned the same
verdict, for 21 refused sends in total.

```
hyperfine -N -i --runs 20 "bun run src/cli.ts send sendfast-probe tern:999999999 'SENDFAST1 refused-target probe' --json"
-> rc 2 every run, OBSERVATION_UNKNOWN INSPECT_PANE_ROW_MISSING_OR_DUPLICATE
-> wall p50 70.7 ms, p95 73.1 ms, max 73.8 ms (mean 70.9 ms ± 1.4 ms)
```

Lead seat `tern:1756641624081`, one send (01:4xZ). The seat was checked first: `tern inspect` read `working: true`, and the
seat's kit-composer-state record read `EMPTY`.

```
bun run src/cli.ts send sendfast-live tern:1756641624081 'SENDFAST1 live measure ompkit-fp72.135.3.84, no action' --json
-> rc 2, OBSERVATION_UNKNOWN "seat not provably idle (FOREGROUND_OMP_MISSING); zero sends", real 0.11 s
```

Cause: `tern process 1756641624081 --json` reports `foreground.name = "18.13.3"` and
`argv[0] = ".../Application Support/Tern/omp/versions/18.13.3"`, and `plane-tern.ts commandIsOmp` accepted only `omp`.
SENDOMP1 (ompkit-fp72.135.3.85, `effdad51a8` and `bdf5d443b8`) fixes that identification separately.

### SilverCondor's busy goal-mode seat (Main's live send, diagnosed read-only)

Main's send to `tern:2572436302200833` (argv[0] `omp`, muse profile) returned in 3.12 s. The result was
NOT_DELIVERED with code UNTIL_DELIVERED_EXHAUSTED, `queue_states` QUEUED then EXPIRED, and the detail "seat
remained working with unproven session state (SESSION_ORACLE_STATE_UNKNOWN) through the 3000 ms until-delivered
bound". Nothing was pasted. The seat was never pasted into during this diagnosis.

I replayed the seat's session file (265 MB, decided from the 8 MiB bounded tail exactly as the observer reads it),
cutting it at each of the last 1500 records. Every cut decides BUSY (an assistant `toolUse` awaiting its tools)
except cuts where the branch ends in context OMP injected for the model to answer next:
- 2× `custom_message` kit-flywheel-guard
- 2× `custom_message` mid-run-todo-nudge
- 2× `compaction`
- 2× a `custom`-role message (eval-state-context)

In each of those, `sessionJournalDecision` is UNKNOWN, so even with the steer opt-in the seat read
SESSION_ORACLE_STATE_UNKNOWN. One such window lasted 26 s: a guard `custom_message` was journaled at 02:01:27.788Z and
the next assistant message at 02:01:53.494Z, which is longer than the 3 s steer bound.

Fix, commit `7173214e9b`: the opt-in (`turnInFlightIsBusy`) also reads such a seat as BUSY when Tern reports it
working. The evidence is the same as for the other mid-turn states: Tern's live flag plus a journal whose branch is
mid-turn (context the model has not answered yet). Pasting into an EMPTY composer is the same native steer either way.

Kept refused:
- Tern not working.
- Any observer without the opt-in.
- A finished turn (terminal stop) waiting on an async job.

Test: `bun test tests/cli/plane-tern.test.ts -t SENDFAST1.context`. Two planted negatives fail when restored:
- dropping the context clause;
- accepting every unknown oracle state.

### Throwaway seats (02:0xZ, no fleet seat messaged)

Each seat was an owned Tern session: `tern new session <name> --cwd <owned scratch> --keep-open -- env
AGENT_NAME=GoldenGull AGENT_MAIL_PROJECT=<scratch> omp --profile codex --model anthropic/claude-haiku-5-5`. It had a
throwaway Agent Mail identity, GoldenGull in the scratch project, and a `tern-<block>` pane identity file.

Sends were `bun run src/cli.ts send <session> tern:<block> 'SENDFAST1 <case> i/20 for ompkit-fp72.135.3.84, no
action, no reply needed' --json`, run sequentially. Wall time is measured per process. Untimed, just before each send,
the harness read two things: Tern's `working` flag, and the observer's own state (`observeTernSeat` with the steer
opt-in).

**Counted run, at HEAD `67731a3d5f` (every SENDFAST1 fix plus SENDOMP1), seat `sendfast-live3`, `tern:8681799647494147`:**

- **Refused (`tern:999999999`):** 20 hyperfine runs (`-N -i --runs 20`), all rc 2 OBSERVATION_UNKNOWN
  `INSPECT_PANE_ROW_MISSING_OR_DUPLICATE`. p50 0.072 s, p95 0.076 s, max 0.086 s. One more send checked the verdict.
- **Busy:** a read task first, then 20 back-to-back sends. Tern's flag read `working: true` before every send.
  - 18 were observed BUSY and PROVEN_STEERED.
  - Send 3 was observed IDLE (the seat finished a turn between the two reads) and was PROVEN in 2.25 s.
  - Send 2 was NOT_DELIVERED `TERN_COMPOSER_BUSY` after 3.24 s: the composer record read DRAFT through the 3 s steer
    bound. Nothing was pasted, a drop copy was written, and the journal holds no entry with that marker.
  - p50 0.720 s, p95 2.251 s, max 3.239 s.
- **Idle:** before each send the harness waited until Tern's flag read `working: false` on two reads 1 s apart.
  - Every send was observed IDLE. 19 were PROVEN at 2.110-2.483 s.
  - Send 17 was refused `SEAT_REBOUND` ("session file changed since observation") in 0.244 s with zero sends. OMP
    appended a `memory` `model_usage` at 02:16:18.281Z, between the observation and the eligibility read. The idle
    path requires the exact observed bytes, and the refusal is that safety check working.
  - p50 2.171 s, p95 2.373 s, max 2.483 s.

Why a busy send took 0.6-2.2 s: OMP's own journal timestamps place each steering USER entry 0.02-0.05 s before the send
returned. The rest is the time OMP takes to take up the steer.

Why an idle send takes about 2.1 s: before journaling the USER entry, OMP writes two `auto-thinking` `model_usage`
entries at about +1.85 s and +2.15 s, then the entry itself at about +2.15 s. The kit proves it within 0.05 s of that
write. The idle floor is OMP's pre-turn auto-thinking call, not the kit.

Composer-record finding (send 2, not fixed here): `extensions/kit-composer-state.ts` publishes the record every 5 s
(`COMPOSER_INTERVAL_MS`) and on agent_start, agent_end and session_switch, never on composer edits. A DRAFT reading
can therefore outlive the 3 s steer bound. Over 40 busy sends at `7173214e9b` and `67731a3d5f` this happened once, and
the send was refused safely.

**Earlier counted run on the same seat, at `7173214e9b` (before the leaf fix):**
- **Busy:** 20/20 observed BUSY and PROVEN_STEERED. p50 0.701 s, p95 2.245 s, max 4.325 s.
- **Idle:** 20/20 observed IDLE and PROVEN. p50 2.182 s, p95 2.291 s, max 2.348 s.

Not counted:
- **First seat, `--profile codex-lean` (`tern:8679574854434819`):** every request failed with "You have reached your
  specified API usage limits ... 2026-11-01". It was closed unused.
- **Busy prompts.** `sleep 120`, and then a CPU-bound two-minute loop, were both refused by the seat's own fleet guard
  (`NO_WAIT_REFUSED`, J-2026-10-18-43). The busy case therefore uses the seat busy for real.
- **Second seat, `sendfast-live2`, `tern:8681052323184643`, at `1f460ae7bb`: 61 sends.**
  - 1 pipeline check: idle, PROVEN 2.05 s.
  - 20 sends where `tern wait --until idle` did not wait, because that flag takes `idle=MS`: 19 PROVEN_STEERED,
    p50 0.725 s.
  - 20 busy: all PROVEN_STEERED, p50 0.660 s, p95 0.974 s.
  - 20 idle: sends 1-9 PROVEN at about 2.1 s.
  - **The 20.8 s send (idle 10/20).** OMP did journal the USER entry (`bcc3f162`, marker `kit-send-eae1f56fd731`),
    but the proof read UNCERTAIN `ENTRY_OFF_ACTIVE_BRANCH` for the whole 20 s deadline. The result was PENDING_CONSUME
    `PROOF_TIMEOUT`, the pending record was kept and a drop copy was written. The message was delivered; the kit could
    not prove it.
  - **Sends 11-20.** Each returned in about 0.23 s as PENDING_CONSUME `SUPPRESSED_PENDING` with zero sends. This is the
    designed rule (one unproven attempt per seat incarnation, never auto-resent), so none of those 10 messages was
    delivered. They are not latency samples.
  - **Cause, fixed in `67731a3d5f`.** `plane-tern.ts activeLeaf()` took the last `model_usage.activeLeafId` hint
    (`b4e742ec`, written on two auto-thinking usages forked beside a `memory` usage) as the leaf, even after the
    branch grew 7 entries below it. The pre-send key pinned that stale leaf, and the new entry's parent chain ran
    through pre-cursor entries.
  - **Replay at `67731a3d5f`.** Cutting that same journal just before `bcc3f162` gives leaf `4bc0bb35`, and the
    entry is PROVEN at offset 162079.
  - The suppression rule itself is unchanged: `bun test tests/cli/send.test.ts -t "B5-7|AM58562-4|INV03|F5:"` gives
    8 pass.

### SilverCondor's 265 MB journal: the 19.49 s steered send (profiled read-only, 02:3xZ)

Main sent from source HEAD to `tern:2572436302200833`, SilverCondor's busy goal-mode seat (muse profile, journal about
265 MB). The send returned `OK` PROVEN_STEERED, but the whole call took 19.49 s.

I profiled it read-only: a scratch harness replayed every read phase of the send against the live seat and file.
- It used `tern inspect`, `tern process`, `ps`, `am resolve-pane` and file reads only. Paste, keys and ctl were
  refused in the harness, and nothing was written to the seat or its journal.
- With the steer opt-in the seat observed BUSY and was IDENTIFIED. The journal parsed KNOWN with leaf `7c2b98bb`.

| Phase | Time |
|---|---|
| observe (two inspects, two process reads, two `ps`, two 8 MiB tail reads) | 105 ms |
| identify (observes again, plus `am resolve-pane`) | 126 ms |
| eligibility read + parse (8 MiB tail; includes the `activeLeaf` walk) | 5 + 12 ms |
| pre-paste re-read and proof check | 5 ms |
| proof read, per 50 ms tick (stat, ranged tail read, `proveTernEntry`) | about 5 ms |

The kit's own read path on the 265 MB journal is therefore about 0.3 s.

**Where the 19 s went.** Main's steering USER entry is marker `kit-send-cffe75742f80`. Its text names
`ompkit-kup44.4`, and it is the only kit-send marker in the journal's last 32 MB. It was journaled at
02:31:38.566Z. Just before it in the journal:
- −60.28 s: an assistant `toolUse` that started a `bash` call;
- −0.26 s: that call's `toolResult`;
- 0.00 s: Main's entry, `steering: true`.

The paste landed about 41 s into a 60 s tool call. OMP holds a queued steer until the current tool call ends and
only then journals it. The kit proved the entry on its next 50 ms tick and returned.

**Conclusion.** On a busy seat, the journal proof's latency equals the time left in the seat's current tool call.
This is OMP's time, not the kit's, so no kit change was made. The throwaway seats' busy numbers above were fast because
their tool calls were short. How `fast` should read for a seat in a long tool call is a question for Joshua. The
bead's budget and the keys above are unchanged.

## Commands and results

- `nice -n 10 bun test tests/cli/send.test.ts -t SENDFAST1`: 6 pass, 0 fail.
- `nice -n 10 bun test tests/cli/send.test.ts -t SENDFAST1.proof`: 2 pass, 0 fail.
- Planted negatives:
  - Restoring the busy wait (`BUSY` waits with an uncapped 300 s bound) makes the PROVEN_STEERED test time out at its
    2000 ms bound, and the DRAFT test fails too.
  - Restoring `TERN_PROOF_POLL_MS = 1000` fails both proof tests at about 1005 ms.
  - A stat gate that never re-reads fails the on-disk proof test at its 2000 ms bound.
- `nice -n 10 bun test` on each file, once, after both commits:
  - send.test 84 pass.
  - plane-tern 78 pass.
  - send-tern-paste 11 pass.
  - send-tern-route 16 pass.
  - setup-tools 9 pass.
  - send-admission 2 pass.
  - send-completion 10 pass.
  - send-consumed 10 pass.
  - send-dispatch 4 pass.
  - send-payload-guard 9 pass.
  - send-serialization 6 pass.
  - send-slash 3 pass.
  - send-target 5 pass.
  - 0 fail in every file.
- `nice -n 10 bun test tests/cli/plane-tern.test.ts -t SENDFAST1.context`: 1 pass. Two planted negatives fail when
  restored: dropping the context clause, and accepting every unknown oracle state.
- `nice -n 10 bun test tests/cli/plane-tern.test.ts -t SENDFAST1.leaf`: 3 pass. Each planted negative fails when
  restored:
  - The hint taken as the leaf, which is the old code: test 1 gives UNCERTAIN `ENTRY_OFF_ACTIVE_BRANCH`.
  - The newest entry taken as the leaf: test 2 turns the sibling-branch marker into PROVEN.
  - The last child taken at a fork: test 3 fails.
  - The sibling and fork fixtures are parsed outside the file's tail-equivalence corpus. A bounded tail cut so narrow
    that it has lost the hint sees only the non-active branch's last message and decides BUSY. That limitation
    predates this change; the linear fixture stays in the corpus.
- After `67731a3d5f`, each file that imports `plane-tern.ts`, once:
  - plane-tern 85 pass.
  - send-tern-paste 11 pass.
  - send-tern-route 16 pass.
  - send 84 pass.
  - setup-tools 9 pass.
  - 0 fail.

## Callers checked

- `proveTernCliSend` is called only by `src/cli.ts:3198`, which passes `untilDeliveredMs` only when `--until-delivered`
  is given. The 300 s default stays and is now named `TERN_TURN_BOUNDARY_WAIT_MS`, because keyed ctl turns and
  `/goal set` still need a turn boundary. `tests/cli/send-tern-route.test.ts` ("busy queued then delivered", keyed
  seat) depends on it. A keyless message caps every wait at `TERN_STEER_BOUND_MS`.
- `deliverToTernSeat` is called by `proveTernCliSend` and by `src/intake-deliver.ts:132`, which passes no
  `untilDeliveredMs`. A busy keyless intake target now steers when its composer record is EMPTY, where before it refused
  `SEAT_BUSY`. Keyed seats are unchanged.
- `observeTernSeat` and `identifyTernSeat` gained an optional third argument, so existing callers are unchanged. The
  in-flight BUSY reading is opt-in (`turnInFlightIsBusy`) and used only by the steerable send.
- `src/report-inject-job.ts` passes `untilDeliveredMs` to `proveSend`, the tmux path, which is untouched.
- Nothing under `extensions/` or `scripts/` calls either function.
- Rejected design: an fs watch on the session file. Bun 1.4.3's `fs.watch` delivered no event for a file or a
  directory on this host, while node's fired within 52 ms. A watch would be dead code in the kit's runtime.
