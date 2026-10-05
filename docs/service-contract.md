---
status: current
---

# SVC1 service job contract (box 1)

Bead: `ompkit-rc-epic-land-fix-release-dogfood-rz5.113`. Every recurring piece of
the plan ships as an `omp-kit service` job (launchd on macOS, systemd user
timers on Linux), not a hand-rolled cron or a pane loop. This doc is the
contract; `service doctor` enforces it item by item.

## Contract items and their doctor checks

| # | Contract item | Status | Doctor check (`service doctor`) |
|---|---|---|---|
| 1 | install = render, diff, backup, bootstrap, verify, with receipt; `--dry-run` previews | IMPLEMENTED (`src/service.ts` `installService`, `planInstall`; cli `serviceCommand`) | `plist-present`, `plist-valid`, `plist-matches-renderer`, `loaded`, `binary-resolves` |
| 2 | uninstall restores (backup kept, bootout verified) | IMPLEMENTED (`uninstallService`, `uninstallSystemd`) | `plist-present` / `unit-present` after the fact |
| 3 | refuses a label loaded from another plist unless `--replace` | IMPLEMENTED (`LABEL_LOADED_ELSEWHERE`, both platforms) | `loaded` (path-mismatch FAIL) |
| 4 | off switch per job: uninstalled, or a disabled flag; off means no run and no receipt | PARTIAL: only `fleet-watch` has one (`.off` file, `src/cli.ts` `serviceCommand`) | MISSING: `contract-off-switch` (runtime; needs `service.ts`/`cli.ts` holder) |
| 5 | RunAtLoad false | CONFLICT (see below) | NEW: `contract-run-at-load` (`src/service-contract.ts`) |
| 6 | ProcessType Background | IMPLEMENTED in renderer | NEW: `contract-processtype` |
| 7 | explicit absolute PATH/HOME from config | IMPLEMENTED in renderer | NEW: `contract-env`, `contract-systemd-env` |
| 8 | no secrets or secret paths in the plist/unit (PUB1) | IMPLEMENTED by convention only | NEW: `contract-no-secrets`, `contract-systemd-no-secrets` (reuses canonical `looksSecret`, `src/mcp-sources.ts`) |
| 9 | single-flight lock: overlap exits SKIPPED-OVERLAP | MISSING (`service run` has no lock) | MISSING: `contract-single-flight` (runtime; holder wires) |
| 10 | load gate: 1-min load > 2.5x cores writes SKIPPED-LOAD, no work; heavy steps via `omp-kit heavy` at nice 10 | MISSING in `service run` (census exists: `runLoadWatch`) | MISSING: `contract-load-gate` (runtime; holder wires) |
| 11 | per-run time cap: kill past the cap, record TIMEOUT | MISSING (systemd has `TimeoutStartSec=600` only) | NEW static half: `contract-systemd-timeout`; MISSING runtime half |
| 12 | one receipt per run (job, version, start, duration, exit, outcome counts) feeding VALUE1 | PARTIAL: `scratch-reaper` + default jobs write `JobReceipt`; `load-watch`, `kit-update`, `fleet-watch` do not | MISSING: `contract-receipt` (runtime; holder wires) |
| 13 | a failed action names path + reason in stderr and receipt | MISSING for `scratch-reaper` (`SCRATCH_APPLY_FAILED` counts only; live: exit 1 every run, unnamed) | Owned by REAP1 (`rz5.118`, blocks SVC1): fix lands there, this doc asserts it |
| 14 | logs rotated by doctor | IMPLEMENTED (`--fix` renames oversized own logs; `oversizedOwnLogs`, 50 MB threshold) | `log-dir-logs` |
| 15 | launchd macOS / systemd user timers Linux | IMPLEMENTED (si4 tracks Linux) | `unit-present`, `unit-matches-renderer`, `loaded` (linux) |
| 16 | one schedule owner per machine; doctor flags double scheduling | MISSING | MISSING: `contract-double-schedule` (runtime; holder wires) |
| 17 | fleet view: `status --all` / `list` report loaded, last exit, run age, run count, matching `launchctl print` | BROKEN (see below) | Box 2, not this box |

## Open conflict: RunAtLoad

The contract says RunAtLoad false. The renderer emits `<true/>` for four jobs
(`scratch-reaper`, `fleet-watch`, `fleet-lessons`, `load-watch`;
`src/service.ts` `KNOWN_JOBS`). `contract-run-at-load` enforces the contract
text, so those four jobs go FAIL until either the defs change to
`runAtLoad: false` (one-line each in `KNOWN_JOBS`, holder applies) or the
contract is amended with a reason. No silent third option.

## Known defect for box 2 (recorded, not fixed here)

`service status --all` and `service doctor --all` never reach their handlers:
the generic parser (`src/cli.ts` argument check) refuses any command with a
declared `argument` when no positional is given, before `--all` is considered.
Reproduced on repo main: `status needs JOB`, overall `NOT_RUN`. The schema
already documents `--all` (`src/commands.ts` service `status`/`doctor`), so the
fix is a parser exemption, owned by whoever takes box 2 (needs `src/cli.ts`,
held by SunnyIbis to ~20:18Z).

## Wiring (for the `src/service.ts` holder)

```ts
import { checkPlistContract, checkSystemdContract } from "./service-contract.ts";
// launchd path, after the existing checks:
checks.push(...checkPlistContract(input.job.name, input.installed?.text ?? input.rendered));
// linux path, after the existing checks:
checks.push(...checkSystemdContract(input.job.name, input.renderedService ?? installed ?? ""));
```

Plus the four `runAtLoad: false` def edits above. Then `service doctor --all`
on Josh's machine must show every installed job PASS (modulo the runtime
MISSING rows, which stay open until boxes 4-9 land).

## Jobs shipping through this contract

Each row ships in its own bead, whose acceptance names SVC1: value-table
(VALUE1 `rz5.110`), ecosystem-dogfood (VALUE2 `rz5.111`), mission-scoreboard
(MP5 `rz5.97`), adoption-replay (ADOPT1 `rz5.107`), skill-gap-mining (SM1
`ompkit-4gak`), load-watch (LOAD2 `ompkit-w559`), learning-digest (MP7
`rz5.99`), prompt-grade (PROMPT1 `rz5.105`), fleet-watch (already defined).
