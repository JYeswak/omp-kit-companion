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
| 9 | single-flight lock: overlap exits SKIPPED-OVERLAP | SOURCE: per-job kernel-serialized claim updates; live or unknown holders are never age-stolen; release is fenced to the acquired nonce and directory identity. Installed qualification remains `rz5.113.1`. | `service-run.test.ts` and `service-run-admission.test.ts`: aged live keeper, unknown probe, replaced claim, same-clock reacquisition, and competing owned processes |
| 10 | load gate: 1-min load > 2.5x cores writes SKIPPED-LOAD, no work; heavy steps via `omp-kit heavy` at nice 10 | WIRED: `service run` gates on entry (real loadavg, `OMP_KIT_LOAD_OVERRIDE` test seam); skip writes receipt, no work | planted e2e high-load in `service-fleet.test.ts` |
| 11 | per-run time cap: kill past the cap, record TIMEOUT | WIRED for subprocess jobs (`omp-watch` via `runWithCap`+SIGKILL, per-job caps below cadence); in-process jobs are bounded by design, supervisor TimeoutStartSec covers installs | planted e2e TIMEOUT in `service-fleet.test.ts`; live `/bin/sleep` killed at cap |
| 12 | one receipt per run (job, version, start, duration, exit, outcome counts) feeding VALUE1 | PARTIAL: `scratch-reaper` + default jobs write `JobReceipt`; `load-watch`, `kit-update`, `fleet-watch` do not | MISSING: `contract-receipt` (runtime; holder wires) |
| 13 | a failed action names path + reason in stderr and receipt | MISSING for `scratch-reaper` (`SCRATCH_APPLY_FAILED` counts only; live: exit 1 every run, unnamed) | Owned by REAP1 (`rz5.118`, blocks SVC1): fix lands there, this doc asserts it |
| 14 | logs rotated by doctor | IMPLEMENTED (`--fix` renames oversized own logs; `oversizedOwnLogs`, 50 MB threshold) | `log-dir-logs` |
| 15 | launchd macOS / systemd user timers Linux | IMPLEMENTED (si4 tracks Linux) | `unit-present`, `unit-matches-renderer`, `loaded` (linux) |
| 16 | one schedule owner per machine; doctor flags double scheduling | MISSING | MISSING: `contract-double-schedule` (runtime; holder wires) |
| 17 | fleet view: `status --all` / `list` report loaded, last exit, run age, run count, matching `launchctl print` | FIXED: parser accepts declared `--all`; rows carry loaded/lastExit/runs/last_run_at (box-2 commit) | `service status --all`, `service list` |

## Fleet lesson report producer

`service run fleet-lessons` runs the existing `omp-kit.fleet-lessons/v1`
producer in a keeper-bound, capped child; it does not substitute the matcher.
Cross-repository groups can create open `uphill,lesson` intake beads only in
the configured intake tracker, which must also be registered by a configured
repository. This check precedes producer writes.

Native intake and grade-marker reads request the complete inventory. Malformed
records, partial pages, nonzero offsets and inconsistent supplied totals are
not an authoritative empty inventory: intake creation is held and the report
names the failed input. Classifier shadow output remains advisory; `mode = "off"`
disables that optional request.

The compiled-CLI fixture exercises real native intake creation/readback,
replay deduplication and registered-only writes. Missing planning inputs still
produce a `BLOCKED` report and failed job receipt, not a healthy planning claim.
Fixture evidence does not qualify an installed release or authorize activation;
the broader learning and skill-admission criteria remain separate.

## Single-flight state and upgrade boundary

Each job keeps its claim in `<job>.lock/pid` under the private jobs directory.
The claim contains the keeper PID, acquisition time and a random per-acquisition
token. The token distinguishes two acquisitions by the same PID in one clock
tick; it is not a kernel process-start timestamp.

`<job>.gate.sqlite` supplies SQLite's cross-process `BEGIN IMMEDIATE` writer
lock around claim mutations. It stores no SQL authority or schema. Keep this
inode: unlinking it would split current and incoming callers into different
locks. A busy gate or an unreadable claim fails closed as `SKIPPED-OVERLAP`;
that result does not prove a job body ran.

Only `ESRCH` establishes a dead PID eligible for reclaim. Age, `EPERM`,
malformed records and old records without a token do not authorize takeover.
Legacy or unverifiable state needs owner reconciliation under quiescence,
not an automatic age-based deletion. A releasing handle cannot remove a
replacement claim, and SQLite rollback does not undo filesystem effects
already performed if a mutation fails.

The source regressions exercise owned fixtures and the actual source CLI
timeout path. They do not establish an installed binary's source binding,
authorize service activation or qualify production scratch reclamation.


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

## Fleet-watch render inputs

When `OMP_KIT_FLEET_WATCH_CONFIG` is set while rendering `fleet-watch`, the
launchd plist and systemd unit carry the resolved absolute config path, so the
preflighted custom file is the one the scheduled job reads. When unset, the
job uses the default path under `HOME`. `--dry-run` includes the rendered
definition as a preview only; it does not write the config or install the
service.

The service contract reports `HOME`, `PATH`, and (for systemd) `TMPDIR`
separately, so a path failure is attributed to the field that failed.

## Jobs shipping through this contract

Each row ships in its own bead, whose acceptance names SVC1: value-table
(VALUE1 `rz5.110`), ecosystem-dogfood (VALUE2 `rz5.111`), mission-scoreboard
(MP5 `rz5.97`), adoption-replay (ADOPT1 `rz5.107`), skill-gap-mining (SM1
`ompkit-4gak`), load-watch (LOAD2 `ompkit-w559`), learning-digest (MP7
`rz5.99`), prompt-grade (PROMPT1 `rz5.105`), fleet-watch (already defined).
