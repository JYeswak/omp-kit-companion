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
| 4 | off switch per job: uninstalled, or a disabled flag; off means no run and no receipt | WIRED: `service run` checks `readJobOff` first per job (fleet-watch migrated); OFF writes no receipt | `service run <job>` with `<job>.off` present |
| 5 | RunAtLoad false | RESOLVED: defs are `runAtLoad: false`; enforced by `contract-run-at-load` (see below) | `contract-run-at-load` (`src/service-contract.ts`, wired into `checkService`) |
| 6 | ProcessType Background | IMPLEMENTED in renderer | NEW: `contract-processtype` |
| 7 | explicit absolute PATH/HOME from config | IMPLEMENTED in renderer | NEW: `contract-env`, `contract-systemd-env` |
| 8 | no secrets or secret paths in the plist/unit (PUB1) | IMPLEMENTED by convention only | NEW: `contract-no-secrets`, `contract-systemd-no-secrets` (reuses canonical `looksSecret`, `src/mcp-sources.ts`) |
| 9 | single-flight lock: overlap exits SKIPPED-OVERLAP | WIRED: `service run` acquires per-job lock first; second exits SKIPPED-OVERLAP (code 4) with receipt; every return releases | planted e2e overlap in `service-fleet.test.ts` |
| 10 | load gate: 1-min load > 2.5x cores writes SKIPPED-LOAD, no work; heavy steps via `omp-kit heavy` at nice 10 | WIRED: `service run` gates on entry (real loadavg, `OMP_KIT_LOAD_OVERRIDE` test seam); skip writes receipt, no work | planted e2e high-load in `service-fleet.test.ts` |
| 11 | per-run time cap: kill past the cap, record TIMEOUT | WIRED for subprocess jobs (`omp-watch` via `runWithCap`+SIGKILL, per-job caps below cadence); in-process jobs are bounded by design, supervisor TimeoutStartSec covers installs | planted e2e TIMEOUT in `service-fleet.test.ts`; live `/bin/sleep` killed at cap |
| 12 | one receipt per run (job, version, start, duration, exit, outcome counts) feeding VALUE1 | PARTIAL: `scratch-reaper` + default jobs write `JobReceipt`; `load-watch`, `kit-update`, `fleet-watch` do not | MISSING: `contract-receipt` (runtime; holder wires) |
| 13 | a failed action names path + reason in stderr and receipt | MISSING for `scratch-reaper` (`SCRATCH_APPLY_FAILED` counts only; live: exit 1 every run, unnamed) | Owned by REAP1 (`rz5.118`, blocks SVC1): fix lands there, this doc asserts it |
| 14 | logs rotated by doctor | IMPLEMENTED (`--fix` renames oversized own logs; `oversizedOwnLogs`, 50 MB threshold) | `log-dir-logs` |
| 15 | launchd macOS / systemd user timers Linux | IMPLEMENTED (si4 tracks Linux) | `unit-present`, `unit-matches-renderer`, `loaded` (linux) |
| 16 | one schedule owner per machine; doctor flags double scheduling | MISSING | MISSING: `contract-double-schedule` (runtime; holder wires) |
| 17 | fleet view: `status --all` / `list` report loaded, last exit, run age, run count, matching `launchctl print` | FIXED: parser accepts declared `--all`; rows carry loaded/lastExit/runs/last_run_at (box-2 commit) | `service status --all`, `service list` |

## Resolved: RunAtLoad

The contract says RunAtLoad false. `KNOWN_JOBS` rendered `<true/>` for four jobs
(scratch-reaper, fleet-watch, fleet-lessons, load-watch); the defs are now
`runAtLoad: false` and `contract-run-at-load` enforces it. Installed plists
rendered before the flip report drift (`plist-matches-renderer`) until
reinstalled; `contract-env` may also FAIL on those stale installs (they carry
`~`-rooted PATH entries the current renderer no longer emits).

## Box 2 (fixed)

`service status --all` / `doctor --all` reached their handlers after a generic
parser exemption (a subcommand declaring `--all` accepts the flag in place of
its positional); list/status rows carry loaded, lastExit, runs and receipt
last_run_at. Proven by `tests/cli/service-fleet.test.ts` including a
live-install planted test.

## Wiring (landed)

`checkService` concats `checkPlistContract` over the installed (or freshly
rendered) plist; `checkServiceLinux` concats `checkSystemdContract` over the
installed unit (or `renderedService`). Live proof: `service doctor kit-update`
reports all six `contract-*` checks. `service doctor --all` on Josh's machine
still needs stale installs reinstalled (drifted plists report
`plist-matches-renderer` until `--fix` rewrites them).

## Jobs shipping through this contract

Each row ships in its own bead, whose acceptance names SVC1: value-table
(VALUE1 `rz5.110`), ecosystem-dogfood (VALUE2 `rz5.111`), mission-scoreboard
(MP5 `rz5.97`), adoption-replay (ADOPT1 `rz5.107`), skill-gap-mining (SM1
`ompkit-4gak`), load-watch (LOAD2 `ompkit-w559`), learning-digest (MP7
`rz5.99`), prompt-grade (PROMPT1 `rz5.105`), fleet-watch (already defined).
