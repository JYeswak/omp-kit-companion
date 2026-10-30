# SENDFAST1 send latency (ompkit-fp72.135.3.84)

Measured 2026-10-30T01:3xZ to 01:47Z by PeachLeopard's build worker (Claude, Opus family) on an Apple M3 Ultra,
macOS 26.5.2, Bun 1.4.3, checkout `main`. The commits under test are `c325ce74e7` (lever 1: steer a busy keyless seat) and
`1f460ae7bb` (lever 2: 50 ms stat-gated proof read). The base was `4d8fef8a73`.

## Keys

```
sendfast_p50_refused_live_s: 0.071
sendfast_p95_refused_live_s: 0.073
sendfast_p95_busy_s: UNMEASURED_LIVE (fixture 0.053; the one live busy send refused FOREGROUND_OMP_MISSING before admission, zero sends)
sendfast_p95_idle_s: UNMEASURED_LIVE (fixture 0.055)
```

The busy-seat live case could not be measured. Acceptance [c] needs 20 live sends per case, and only the refused case
has them. The bead stays open on [c] and on the [live] readback.

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

Lead seat `tern:1756641624081`, one send. The seat was checked first: `tern inspect` read `working: true`, and the
seat's kit-composer-state record read `EMPTY`.

```
bun run src/cli.ts send sendfast-live tern:1756641624081 'SENDFAST1 live measure ompkit-fp72.135.3.84, no action' --json
-> rc 2, OBSERVATION_UNKNOWN "seat not provably idle (FOREGROUND_OMP_MISSING); zero sends", real 0.11 s
```

Cause, which predates this bead and is outside both levers: `tern process 1756641624081 --json` reports
`foreground.name = "18.13.3"` and `argv[0] = ".../Application Support/Tern/omp/versions/18.13.3"`.
`plane-tern.ts commandIsOmp` accepts only a process name or argv[0] basename of `omp`. A seat that runs Tern's bundled
OMP build is therefore never identified, and the send refuses with zero effects before any admission. A busy-seat live
number needs that identification fixed first. It was not changed here because it is a separate OMP-identity safety
decision.

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
