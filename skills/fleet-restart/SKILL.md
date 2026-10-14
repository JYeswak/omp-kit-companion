---
name: fleet-restart
description: "Restarts OMP agent panes onto the target build with sessions and advisors kept. Use for 'restart the fleet', 'fleet-wide restart', 'restart all agents on the latest kit', 're-dispatch after restart', 'herdr omp pane'."
license: MIT
distribution: subscribers
---

# Fleet restart

> One approved run from "restart the fleet" to a fleet on the target OMP build, with its watchers back, its sessions kept and its advisors on. `run --plan` shows the operator everything the run will touch. One approval bound to that plan's sha256 lets `run --apply` do the rest and write a report. The script refuses the mistakes the 2026-10-11 restart made.

Worked example: `~/Developer/omp-kit/docs/handoffs/fleet-restart-20261011.md`. Tracker: ompkit-bj08.13 (restart tool), ompkit-fp72.19.1 (autonomous run), ompkit-uxr3 (defects fixed here), ompkit-fp72.* (gaps found that day).

## When to use

Triggers: "restart the fleet", "fleet-wide restart", "restart all agents on the latest kit", "re-dispatch after restart". Run it from the chief pane.

## When NOT to use

- **One stuck pane.** Restart that pane by hand with its live flags. Routing: `vibing-with-ntm`.
- **Installing or upgrading OMP itself.** The kit never installs OMP. Routing: `omp-kit doctor`, operator.
- **A herdr pane whose foreground argv is not `omp`.** Shell panes and `__omp_worker*` stay out. An `omp` herdr pane is in the run (rule 16). It is not a tmux session named `skill-library-growth`.
- **Planning the next work.** Re-dispatch here only sends the first message. Routing: `flywheel-end-to-end`, `jeff-planning-enhanced`.

## Hard rules (each one broke on a real restart)

1. **`/restart` cannot change versions.** OMP's `/restart` re-execs `process.execPath`: a Tern pane re-runs its own `…/Tern/omp/versions/<x.y.z>` file and a bun pane re-runs the bun-global package. On 2026-10-13 the fleet ran four builds (18.9.1 bun, 18.9.2, 18.10.2, 18.10.3). The target is the realpath of the login shell's `omp` (`zsh -lc 'command -v omp'`). A pane gets `RESTART` (`/restart`, same pid) only when its running executable (`lsof` txt) already is the target and it is not a bun launch. Every other pane gets `RESPAWN`.
2. **Copy flags from the live process, never from the screen.** On 2026-10-11, 24 of 32 screen-built commands were wrong. Respawn runs `tmux respawn-pane -k -t <pane> -c <cwd> "zsh -lc 'cd <cwd> && omp <live flags> --resume <session file>[ --advisor]; exec zsh -l'"`. `<live flags>` must keep `--profile`. `<live flags>` = the process argv minus argv[0] and minus any `--resume`/`-r`/`--restore` pair. `omp` is the plain login-shell command, never a versioned path or bun. `send` refuses a row whose flags differ from the live process or whose `--resume` is not the saved file. Unknown launch affinity, or a relaunch that drops a live `--profile` (including `ntm respawn` when affinity is unknown), is `HOLD_PROFILE`, not a send: that start is the default profile and `<profile>/agent/WATCHDOG.yml` does not load. Do not guess a profile when the session file is not under `~/.omp/profiles/<name>/`. A herdr relaunch whose session file is under that directory adds `--profile <name>` and records it in `added` (rule 16). The script does not emit `HOLD_PROFILE` yet; the chief still must not send that row.
3. **Detect agents by process, not model name.** An agent pane holds `bun …/.bun/bin/omp`, `bun …/pi-coding-agent/dist/cli.js` or a Tern compiled `omp`, excluding `__omp_worker*`.
4. **Never restart a busy pane, never touch a composer with text.** A spinner means mid-turn: the run polls busy panes every 30 s up to `--busy-timeout-min` and acts at the turn boundary; still busy → `QUEUED_BUSY`, zero sends. Text typed or queued in the composer → `HOLD_COMPOSER`: `/restart` would be submitted with it and a respawn would discard it. An unreadable status bar or composer layout is a hold (fail closed). Every send re-reads the screen first.
5. **ntm needs the fleet socket.** `check-env` checks `TMUX_TMPDIR=/Users/josh/.tmux-sockets` (or `$TMUX`); every apply refuses without it.
6. **One operator approval per run, bound to the run manifest.** `run --apply` refuses unless the approval file carries the sha256 of `run-manifest.json`, the operator's name and their words verbatim. Re-planning or editing the manifest changes the sha and voids the approval. Write the approval only from an operator message in this conversation; the script binds bytes, it cannot prove a human wrote them. Re-dispatch messages (stage 7) get their own approval.
7. **Plugin links must point at the active release before any restart.** `run --plan` refuses with `ALIGN_STALE`, and `run --apply` re-checks align and the target in preflight.
8. **Skip what is not yours.** The chief pane is never touched by the run; the report prints its exact respawn command for the operator to run last. Also skipped: `DEFAULT_PROTECT` (`uds--burn-down:0.0`), shell panes, `/tmp` cwds. A protected pane runs only when `--unprotect <pane>` is given at plan and apply and the approval's `unprotect` list names it.
9. **Respawn preconditions.** Each failure is a hold with zero sends: idle status line, empty composer (`HOLD_COMPOSER`), no git child (`SKIP_GIT`/`HOLD_GIT`: SIGHUP mid-git leaves a holder-less `index.lock`), one session file found (`HOLD_NO_SESSION`, `HOLD_SESSION_AMBIGUOUS`). Unsaved scratch is not a hold and not a save. The report names each owned scratch dir newer than the last push as lost. A respawn kills that pid and scratch-reaper then deletes the dir. Unknown launch affinity, or a command that drops live `--profile`, is `HOLD_PROFILE` (rules 2 and 11); the script does not emit it yet, and the chief still must not send. The dir named exactly `omp.<pid>` is the process's own TMPDIR (compile caches, locks, runners); it is listed as `runtime_scratch` and is not a loss record, since the new process makes `omp.<newpid>`. `omp.<otherpid>` is ordinary work and is named as lost, not held. Never rewrite `.owner` or rename a dir to hide the loss: the reaper requires the name to end in `.<pid>`.
10. **Watchers pause, then always resume.** Pane actors would nudge panes mid-restart, and state mutators would install a kit or reap a respawned pane's scratch. The run boots out the registry's `pause: true` jobs and resumes exactly those in a `finally` block, even after an exception. A dead-man LaunchAgent resumes them if the run process dies.
11. **Advisors come back, never toggle.** `/restart` keeps argv, including `--profile`, and loads `<profile>/agent/WATCHDOG.yml` when `advisor.enabled` is true. `--advisor` and `--config` are not required for that load. Codex and muse already have `advisor.enabled: true` and a Haiku `WATCHDOG.yml`. A runtime-only advisor is off after `/restart`. A respawn adds `--advisor` unless the profile config enables it. If the advisor badge is still missing and `--profile` was kept, the run sends exactly `/advisor on` (idempotent) once. Bare `/advisor` toggles; `send` refuses it. A relaunch that drops `--profile` does not load that roster; it is `HOLD_PROFILE`, not a send, and `/advisor on` does not repair it. The badge is the 👁 (or 🙈 once the advisors yielded the turn) right after the model name. The `+ 👁 <cost>` spend segment after 📁 never counts: OMP restores it from the transcript on resume even with the advisor off.
12. **Verify version and session, both modes.** Running executable realpath == target (`VERSION_OK`, else `VERSION_STALE` = failure), the same session `.jsonl` open (`SESSION_KEPT`, else `SESSION_LOST` = failure), flags equal ignoring `--resume`, idle prompt. `RESTART` keeps the pid; `RESPAWN` must show a new one. The screen model before and after is recorded. OMP's `/restart` keeps the launch `--model` (cli/flag-tables.ts `restartArgv`), and so does our respawn, so a runtime model switch reverts. That shows as a `MODEL_CHANGED before -> after` warning in `report.md` and the run output, never a failure.
13. **Re-validate live right before every respawn.** A respawn row is checked against the live pane at the moment of the send: run waves, busy panes reaching their turn boundary, and manual `send`. The checks are:
    - the omp pid equals the saved one (`HELD_DRIFT`);
    - the saved session file is still open (`HOLD_SESSION_CHANGED`);
    - no git child (`HOLD_GIT`);
    - held scratch is copied out of reaper roots and each dirty repo is pinned on `refs/preserve` before any send. A preserve failure refuses the run.
    - the command still carries the live `--profile` (`HOLD_PROFILE`); unknown affinity is the same hold, not a send.

    Manual `send` refuses a respawn row it cannot re-validate (`REFUSED_NO_REVALIDATION`). Never respawn from a stale `save.json`.
14. **Canary first, then a circuit breaker.** `--canary N` (default 1, fixed at plan time) sends and verifies N idle panes first, a RESPAWN pane preferred. The run continues only if every canary is VERIFIED with its advisor back where it was on. After that, the first `FAILED`, `SESSION_LOST` or `VERSION_STALE` verdict trips the breaker; `ADVISOR_FAILED` trips it too with `--strict-advisor`, and always on a canary. Once tripped:
    - no new send starts, and panes already sent finish verifying;
    - the remaining panes become `HOLD_BREAKER`;
    - the watchers resume, `report.md` names the trigger (`BREAKER: <pane> <verdict>`), and the run exits 6.

    `--resume-run` after a breaker stop sends nothing, and does not even retry a lost send, unless it is given `--continue-after-breaker` and the approval carries `continue_after_breaker: true`.
15. **One callback grammar.** Every first message asks for `DONE|BLOCKED <bead> <sha> <evidence>; NEXT <item>`, the line kit-callback parses.

16. **Herdr omp panes are restartable. They are not tmux.** Inventory with `herdr agent list` and `herdr pane process-info --pane <id>`. A row is in the run when the foreground argv is `omp` and not `__omp_worker`. Pane ids are `w2:p1`, not tmux `%id`. Never send a herdr row through ntm, tmux, or `TMUX_TMPDIR`. Operator approval gates every send. Holds match the tmux path: busy, blocked, composer text (`HOLD_COMPOSER`), no session file (`HOLD_NO_SESSION`), git child (`HOLD_GIT`). Unsaved scratch is lost, not a hold. Zero sends while any real hold is set. Measured 2026-10-14, not a send list: `w2:p1` and `w2:p3` are `omp --resume=<muse session file>` with no `--profile`; `w2:p2` is `--profile codex`; `w2:p5` is `--profile muse`; `w4:p1` is `--profile grok`. Two modes, same as tmux. Compare the running executable to the login-shell target. Same executable: submit omp `/restart` with `herdr pane send-keys <id> /restart Enter` only when `herdr agent explain` says idle and the composer read (`herdr pane read <id>`) is empty. `herdr agent prompt` is not the slash path until a probe shows it executes `/restart` instead of chatting. Do not run that probe. Different executable: `/restart` cannot change builds. Submit `herdr pane send-keys <id> /exit Enter`, wait until `herdr pane process-info --pane <id>` no longer shows omp, then `herdr pane run <id> omp <live flags> --resume <saved session file>`. `herdr agent start --kind omp` is not this step: its executable is herdr's pin, not the login-shell target, and that pin was not measured. If the live argv has no `--profile` but the session file is under `~/.omp/profiles/<name>/`, the relaunch adds `--profile <name>` and records it in `added`. `w2:p1` and `w2:p3` otherwise come back on the default profile and `<profile>/agent/WATCHDOG.yml` does not load. `/restart` keeps argv and does not add that flag. The tmux script does not send these commands; the chief runs them after approval.

## Setup

Call the script by its full path in every command. Never put the launcher in a shell variable: an unset launcher variable once ran `/usr/bin/env` and printed every secret (ompkit-uxr3).

```bash
SKILL=<directory holding this SKILL.md>      # e.g. ~/.local/opt/omp-kit/releases/<v>/skills/fleet-restart
RUN=/Users/josh/Developer/omp-test/var/agent-tmp/fleet-restart-$(date +%Y%m%d).$$
mkdir -p "$RUN"; printf 'pid=%s\nlabel=fleet-restart\npurpose=fleet restart run\n' $$ > "$RUN/.owner"; export TMPDIR="$RUN"
export TMUX_TMPDIR=/Users/josh/.tmux-sockets
python3 "$SKILL/scripts/selftest.py"                              # every gate must bite; stop on FAIL
python3 "$SKILL/scripts/fleet_restart.py" check-env               # exit 2 = TMUX env/socket missing
```

## Procedure: the autonomous run

Stage 0 (kit, plugin links, MCP baseline) is unchanged: see **Manual stages → ALIGN** below. Herdr omp panes are a second inventory (rule 16). Do not point the tmux run at them. After approval, the chief runs the rule 16 herdr commands. Then:

### 1. PLAN (read-only)

```bash
python3 "$SKILL/scripts/fleet_restart.py" run --run "$RUN" --plan [--wave 3] [--busy-timeout-min 30] [--canary 1] [--strict-advisor] [--only <pane>]... [--unprotect <pane>]
```

The chief pane defaults to `$TMUX_PANE` (`--chief` overrides). `--only <pane>` (repeatable, name or `%id`) limits the manifest to those panes, for a hand-picked canary; an unknown pane refuses the plan (`ONLY_NOT_IN_PLAN`). `--canary` and `--strict-advisor` are recorded in the manifest, so the approval covers them; `--apply` may repeat them but never change them (`CANARY_NOT_IN_MANIFEST`, `STRICT_ADVISOR_NOT_IN_MANIFEST`). The plan writes `$RUN/snapshot/` (stage-1 snapshot, 2000 lines per pane), `$RUN/plan.json`, `$RUN/save.json` and `$RUN/run-manifest.json`, and prints the target, counts, holds and the chief's respawn command. Exit 3 means the plan was refused: `ALIGN_STALE`, `TARGET_UNKNOWN`, `CHIEF_UNKNOWN`, `HOLD_UNCLASSIFIED`, `ONLY_NOT_IN_PLAN`, or `PRIOR_RUN_DEADMAN_INSTALLED` (a previous run's dead-man is still loaded; resume that run first).

### 2. GATE: show the operator **OPERATOR**

From the printed JSON, show: target path and version, versions running now, agent panes, panes per mode (`RESTART`, `RESPAWN`), panes waiting for their turn boundary (`QUEUE_BUSY`), advisor-on panes, session files found, every hold by kind (`SKIP_*`, `HOLD_*`), watchers to pause, unclassified watchers. Get one go for the run.

### 3. APPROVAL

```bash
python3 "$SKILL/scripts/fleet_restart.py" approval-template --manifest "$RUN/run-manifest.json" > "$RUN/approval.json"
```

Fill `approved_by` and `quote` (the operator's words verbatim). For `--unprotect`, the operator must name the pane and it goes in the approval's `unprotect` list. `continue_after_breaker` stays `false` unless the operator, after reading a breaker report, approves continuing (rule 14).

### 4. APPLY

```bash
python3 "$SKILL/scripts/fleet_restart.py" run --run "$RUN" --apply --approval "$RUN/approval.json" [same --unprotect as the plan]
```

Order, each step appended to `$RUN/ledger.jsonl`:

1. **Preflight**: approval bound to the manifest sha, `check-env`, `selftest.py` green, align not stale, target unchanged since the plan, no unclassified watcher. Any miss refuses before anything changes.
2. **Save** → `$RUN/save.json`, per agent pane:
   - live argv, cwd, profile and model;
   - running executable and version (`lsof` txt);
   - session file (the one `*.jsonl` open directly under `sessions/<slug>/`; `__advisor*` and subagent transcripts excluded), with size and mtime;
   - advisor: `on` from the badge after the model name in the live status bar (rule 11), never scrollback; `source` is `flag` for `--advisor` in argv, `config` when the profile's `config.yml` sets `advisor.enabled: true`, else `runtime`; the WATCHDOG.yml/.yaml rosters at user and project scope, with sha256;
   - work scratch dirs whose `.owner` pid is the omp pid (newest file and mtime), `runtime_scratch` (`omp.<pid>`), the repo's last push (from `update by push` reflog entries), the dirs that hold (`held_scratch`), repo dirt count.
3. **Watchers pause**: dead-man first, then `launchctl bootout` of each loaded `pause: true` job → `$RUN/watchers-paused.json`.
4. **Canary** (rule 14): `--canary` idle panes, a RESPAWN pane first, each sent and verified alone; any failure trips the breaker before the waves.
5. **Idle panes, one process each, after the canary.** The canary is still one pane, verified alone. If it passes, each remaining idle pane gets its own process (`PANE_FANOUT` on stderr and in the ledger). A cancel file or `SIGTERM` stops a child before it sends. A child that already sent finishes verify. Tests stay on the serial wave path.
6. **Busy panes** at their turn boundary, same steps including the live re-validation; still busy at the timeout → `QUEUED_BUSY`, zero sends.
7. **Scratch reap**: `omp-kit scratch apply --apply --yes`, only after preserve succeeded. Dead-owner scratch is deleted, including dirs whose owner pid a respawn in this run just killed. The copy under `$RUN/preserve` and the `refs/preserve/fleet-restart/` pin are the save. Live-owner scratch is left. A reap failure is recorded as `SCRATCH_REAP` and does not fail a verified restart.
8. **Watchers resume** in `finally` → `$RUN/watchers-resumed.json`; dead-man removed.
9. **WATCHDOG drift**: re-hash the saved rosters and report changes; never rewrite them.
10. **Report** → `$RUN/report.json` and `$RUN/report.md`, with:
   - per pane: mode, result, version, session and advisor;
   - the `BREAKER:` line;
   - `MODEL_CHANGED` warnings;
   - a respawn fallback for any failed `/restart` pane;
   - the chief's respawn command.

Only `/restart`, `/advisor on` and the checked respawn reach agent panes. Exit 6 if any pane is `FAILED`, `SESSION_LOST`, `VERSION_STALE` or `ADVISOR_FAILED`, if the breaker tripped, or if the run raised. Exit 7 if refused.

### 5. REPORT and continue

Read `$RUN/report.md` to the operator. Then **HANDOFF** (stage 5), **CHIEF RESPAWN** (stage 6), **RE-DISPATCH** (stage 7) and **CALLBACKS** (stage 8) below, all with `--run "$RUN"` so they read the stage-1 snapshot.

### Interrupted run: `--resume-run`

```bash
python3 "$SKILL/scripts/fleet_restart.py" run --run "$RUN" --apply --approval "$RUN/approval.json" --resume-run
```

Continues from `ledger.jsonl` with the original `save.json`; re-saving now would read restarted panes as the "before" state.

- Each acted-on pane gets one `VERDICT` ledger event, written only after the pid, flags, idle, session and version checks. `VERIFY`, `SESSION` and `VERSION` are evidence events. On resume only a `VERDICT` is terminal.
- A pane with a `VERDICT` keeps it and is never re-sent. Failures (`VERSION_STALE`, `SESSION_LOST`, `FAILED`) stay failures in the report and the exit code. Holds and `QUEUED_BUSY` stay as they were; re-plan to act on them. If a verified pane's advisor step is missing, it is finished.
- A pane with `VERIFY` but no `VERDICT` (crash mid-verify) re-runs every check without re-sending, then writes its `VERDICT`.
- A pane that was `SENT` with no `VERIFY` is checked live first. An effect is visible when a respawn left a new pid, or a `/restart` left new MCP child pids or changed argv; such a pane is verified as is.
- Otherwise the pane is `SEND_LOST` and gets one retry. A second loss fails it.
- After a breaker stop, `HOLD_BREAKER` verdicts are terminal like the rest, and a lost send is not retried. Only `--resume-run --continue-after-breaker`, with `continue_after_breaker: true` in the approval, reopens the `HOLD_BREAKER` panes. That command refuses without the approval (`CONTINUE_NOT_APPROVED`), without `--resume-run`, or when no breaker tripped. The reopened panes go through the canary again, and the breaker is re-armed.

A plain `--apply` on an applied run refuses with `RUN_ALREADY_APPLIED`.

## Watchers

`watchers.json` (next to this file) maps each launchd label to `class` (`pane-actor`, `state-mutator`, `reader`), `pause` and `why`.

| Pause during the run | Keep running (readers) |
|---|---|
| Pane actors: `com.omp-kit.fleet-watch`, `com.omp-kit.fleet-flush` | `com.omp-kit.ci-poller`, `com.omp-kit.load-watch`, `com.omp-kit.claude-save` |
| State mutators: `com.omp-kit.kit-update`, `com.omp-kit.scratch-reaper`, `com.omp-kit.omp-watch` | `com.jyeswak.fleet-scheduler`, `ai.zeststream.skill-scheduler-watchdog`, `ai.zeststream.herdr-loop-watch`, `ai.zeststream.skill-discovery-watcher` |

Discovery reads every `~/Library/LaunchAgents/*.plist`; an unreadable plist is reported, not fatal. A loaded job missing from the registry is `HOLD_UNCLASSIFIED` when its ProgramArguments, or a script file they name, contain `send-keys`, `respawn-pane`, `ntm send` or `omp-kit send`. That blocks the run until the operator classifies it in `watchers.json`. The same job unloaded is reported as `UNCLASSIFIED_NOT_LOADED`.

```bash
python3 "$SKILL/scripts/fleet_restart.py" watchers snapshot                                  # read-only classification
python3 "$SKILL/scripts/fleet_restart.py" watchers pause --run "$RUN" [--ttl-min 90]         # dry run; writes watchers-pause-plan.json
python3 "$SKILL/scripts/fleet_restart.py" watchers pause --run "$RUN" --apply --approval <approval for watchers-pause-plan.json>
python3 "$SKILL/scripts/fleet_restart.py" watchers resume --run "$RUN" [--if-expired] --apply
```

**Dead-man.** Before any bootout, pause installs `com.omp-kit.fleet-restart-resume.<run>` (StartInterval 300). It runs `watchers resume --run <run> --if-expired --apply`:

- Before `expires_at` (pause time + TTL) it does nothing. The run's TTL is max(90, busy timeout + 60) minutes.
- After it, it bootstraps exactly the rows this run booted out, verifies each with `launchctl print`, then removes itself and its plist. A job that was unloaded before the pause stays unloaded.
- Resume is idempotent.
- If the dead-man cannot be loaded, pause refuses and boots nothing out.

## Manual stages (fallback)

Use these when the run refuses on something the operator decides by hand, or to redo one pane.

### ALIGN: kit, plugin links, MCP baseline

```bash
V=<target version>
gh release download v$V --repo JYeswak/omp-kit-companion --dir "$RUN/rel$V"
omp-kit update --plan --version $V --index "$RUN/rel$V/release-index.json" --archive "$RUN/rel$V/omp-kit-v$V-darwin-arm64-none.tar" --json
omp-kit update --apply --yes --version $V --index "$RUN/rel$V/release-index.json" --archive "$RUN/rel$V/omp-kit-v$V-darwin-arm64-none.tar" --json   # after the operator's go
A=$(omp-kit --version | awk '{print $2}')
omp-kit apply plugin --plan  --store ~/.local/opt/omp-kit/releases/$A --profiles all --include-default --json
omp-kit apply plugin --apply --yes --store ~/.local/opt/omp-kit/releases/$A --profiles all --include-default --json
python3 "$SKILL/scripts/fleet_restart.py" align                                              # exit 0 = every link -> releases/$A
```

Stale links on a kit older than 38868de (reported UNCHANGED): run `align --relink` (plan), then `align --relink --apply --approved-by <operator> --undo "$RUN/relink-undo.json"`, then `align` again. MCP baseline: `omp-kit test --mcp --profiles default,claude,codex,muse,glm,grok --servers rea --call 'rea:binary_session:{"expected_package_version":"<rea version>"}' --expect 'rea:"alignment":\{"state":"aligned"' --json`. Never restart onto a half-aligned install.

### SNAPSHOT, PLAN, SAVE (read-only)

```bash
python3 "$SKILL/scripts/fleet_restart.py" snapshot --out "$RUN/snapshot"
python3 "$SKILL/scripts/fleet_restart.py" plan --inventory "$RUN/snapshot/inventory.json" --out "$RUN/plan.json"   # exit 3 = ALIGN_STALE
python3 "$SKILL/scripts/fleet_restart.py" save --run "$RUN" [--inventory "$RUN/snapshot/inventory.json"]
```

### One pane or a few **OPERATOR**

Choose the mode from `save.json`: `/restart` only when the pane's `exe_real` is the target and `bun` is false; otherwise respawn.

```bash
python3 "$SKILL/scripts/fleet_restart.py" manifest restart --plan "$RUN/plan.json" --only <pane> --out "$RUN/m.json"                        # /restart
python3 "$SKILL/scripts/fleet_restart.py" manifest respawn --plan "$RUN/plan.json" --save "$RUN/save.json" --only <pane> --out "$RUN/m.json"  # respawn
python3 "$SKILL/scripts/fleet_restart.py" send --manifest "$RUN/m.json"                                                                      # dry run
python3 "$SKILL/scripts/fleet_restart.py" approval-template --manifest "$RUN/m.json" > "$RUN/m-approval.json"
python3 "$SKILL/scripts/fleet_restart.py" send --manifest "$RUN/m.json" --apply --approval "$RUN/m-approval.json" --log "$RUN/m-log.json"
python3 "$SKILL/scripts/fleet_restart.py" verify --plan "$RUN/plan.json" --sent-log "$RUN/m-log.json" --mode <restart|respawn> --expect-mcp rea-agents=<rea version>
```

Manual `verify` checks pid, MCP children, flags and idle. It does not check the version: compare `lsof -a -p <new omp pid> -d txt -Fn` against the target by hand. A respawn that added `--advisor` shows that flag as a difference in manual `verify`; the autonomous run accounts for it. Respawn rows refuse `HOLD_NO_SESSION`, `HOLD_SESSION_AMBIGUOUS`, `HOLD_SCRATCH_OWNER`, and `HOLD_PROFILE` panes. Do not build a tmux manifest for a herdr pane. If the advisor was on, `--profile` was kept, and the badge is gone, a manifest row with `text: "/advisor on"` goes through the same send. `send` refuses any other keystroke text.

### 5. HANDOFF

```bash
python3 "$SKILL/scripts/fleet_restart.py" handoff --run "$RUN" --out ~/Developer/omp-kit/docs/handoffs/fleet-restart-$(date +%Y%m%d).md
```

`--run` reads `plan.json` and the stage-1 snapshot from the run manifest; a different `--snapshot` is refused (`SNAPSHOT_NOT_STAGE1`). Fill the open sections from `report.md` and evidence: queued panes, HEALTH/INIT per repo, beads awaiting INTEGRATE, open PRs, defects (one bead each). Save it through the omp-kit save path.

### 6. CHIEF RESPAWN **OPERATOR**

The run never touches the chief. Tell the operator the handoff path and give them the chief's respawn command from `report.md`; the operator runs it last. If the report names lost scratch, that work was not saved. The reaper deletes it once the old pid is gone. Do not hold the restart for it. The new chief is already up. It reads the handoff first, then continues at stage 7. Do not send from memory.

### 7. BRING-UP then RE-DISPATCH **OPERATOR**

```bash
python3 "$SKILL/scripts/fleet_restart.py" manifest messages --run "$RUN" --handoff <handoff.md> \
  --staged-dir "$RUN/staged" --directors <s:w.p> [--directors …] --out "$RUN/messages-manifest.json"
```

Bring-up order. The chief is already up. Herdr omp panes use rule 16 commands in this same order, not ntm. Do not send a step until the operator approves that step.

1. Chief reviews the fleet report `$RUN/report.md` and the sitrep: `python3 "$SKILL/scripts/sitrep.py" --repo <tracker repo with no agent pane> --out "$RUN/sitrep.json"` (after `python3 "$SKILL/scripts/sitrep.py" --selftest`).
2. Watchers stay off until each director has its mission. If the run's `finally` already resumed them, pause them again with `watchers pause --run "$RUN" --apply` and an approval for that pause plan before any director send. The dead-man still covers a dead chief.
3. Bring each director up. The first message is the mission copied from `<repo>/.flywheel/MISSION.md`, not from memory. A missing file, or a file that still has unfilled `{{...}}` tokens from `templates/flywheel-install/MISSION.md.tmpl`, is `HOLD_MISSION`, not a send. Herdr: `herdr agent prompt` with that file's text, only when `herdr agent explain` says idle and the composer read is empty. It is not the `/restart` path.
4. Workers come up last, with the profile Haiku WATCHDOG roster (`<profile>/agent/WATCHDOG.yml` when `advisor.enabled` is true). Same holds as the tmux path and rule 16.
5. Then `watchers resume --run "$RUN" --apply`.
6. Then the fleet is live.

Show the operator the staged files. The generator writes the kit tick order INIT → RESEARCH → PLAN → BEADS → DISPATCH → VALIDATE → INTEGRATE → LEARN, with VALIDATE before INTEGRATE. Do not rewrite that file back to HEALTH then INTEGRATE then DISPATCH.

- Directors follow the kit tick order INIT → RESEARCH → PLAN → BEADS → DISPATCH → VALIDATE → INTEGRATE → LEARN. VALIDATE is before INTEGRATE; a callback with no validation receipt is not INTEGRATE-ready. Do not teach a detector pick-order. HEALTH (`flywheel doctor --repo <repo> --json`, `ntm health <session> --json`) is the restart read inside INIT, not a jump to INTEGRATE.
- For a new build, the agent-flywheel.com arc is plan, beads, launch, implement, harden, ship (https://agent-flywheel.com/complete-guide). Kit wins on conflict.
- Workers get: own row + snapshot → next bead from own `br ready`.

After the operator's go for a step: `approval-template` → fill → send that step only. Directors before workers. A `HOLD_MISSION` director is not sent. A staged file edited after approval is refused.

### 8. VERIFY callbacks and sitrep

- Every director replies with one callback line; DONE needs a sha on origin/main, BLOCKED needs the blocker. A prose-only reply is not a callback; ask once, then record BLOCKED.
- Read the fleet through the parser: `python3 "$SKILL/scripts/sitrep.py" --repo <tracker repo with no agent pane> --out "$RUN/sitrep.json"` (after `python3 "$SKILL/scripts/sitrep.py" --selftest`). Every number in the handoff sitrep traces to a field of that JSON.
- Traps the parser handles: `br list --json` without `--status` omits closed beads; real callbacks carry `;` inside the evidence (split on the last `; NEXT`).

### 9. DAILY MEASURE **OPERATOR**

Separate from this restart, and only after the fleet is live. The chief's next loop mines cass for the day and turns each blocker into a research or hardening bead. Do not implement that miner in the restart tool.

Existing reads: the sitrep command in stage 7, and `cass timeline --today --json` for the day's session window. `cass lessons list` reads lessons already mined from commits, beads, and proofs. It does not create beads from session blockers.

UNVERIFIED: no command was found that turns the day's cass blockers into research or hardening beads. Checked `cass --help`, `cass timeline --help`, and `cass lessons --help` on 2026-10-14.


## Done-bar

A fresh chief, given only this skill, takes a live fleet from `run --plan` to a run report on a new day, with no message or keystroke outside the approved run.

- Every acted-on pane is `VERIFIED` with `VERSION_OK` and `SESSION_KEPT`.
- Every advisor that was on is back on.
- Every herdr omp pane is restarted or relaunched by rule 16, not skipped and not sent through ntm.
- The watchers are back and the report is written.
- The handoff is committed and the chief is respawned by the operator.
- Every director callback is recorded.
- Watchers stayed off until each director had `<repo>/.flywheel/MISSION.md`; `HOLD_MISSION` panes were not sent; workers came up last with the profile Haiku WATCHDOG roster; watchers resumed; then the fleet was live.

Current proof is static plus read-only live. `python3 scripts/selftest.py` gates bite on planted negatives; launchctl, ntm, tmux, lsof and the clock are fakes. Live, `check-env`, `watchers snapshot`, `save` and `run --plan` have run read-only. The first live `run --apply` and the fresh-agent materialization run are still open. Do not call the run reliable until a live apply's `report.json` shows it.

## Anti-patterns

| Failure | Why it fails | Fix |
|---|---|---|
| `/restart` to move a pane to a new OMP | It re-execs the same build (execPath) | Mode by running executable: respawn every pane not on the target |
| Respawn with the versioned path or bun | Pins the old build again | Plain `omp` from `zsh -lc` (the login shell's target) |
| Launch command typed from the status bar, or respawn that drops live `--profile` | Unknown launch affinity starts the default profile; `<profile>/agent/WATCHDOG.yml` does not load | `<live flags>` must keep `--profile`; else `HOLD_PROFILE`, not a send |
| A launcher kept in a shell variable | Unset across tool calls it ran `/usr/bin/env` and printed secrets | Full path every time; the subcommand is `check-env` |
| Restarting with fleet-watch/fleet-flush live | They nudge panes mid-restart; kit-update installs mid-run | `run` pauses the registry's `pause: true` jobs, resumes in `finally`, dead-man backs it |
| Bare `/advisor` to bring the advisor back | It toggles: an advisor already on goes off | `/advisor on` only when the badge is missing; respawn adds `--advisor` |
| Respawn without `--resume` | A fresh session drops the conversation | `--resume <saved session file>`, checked at send |
| Sending into a composer with typed text | `/restart` submits the text; respawn discards it | `HOLD_COMPOSER` |
| Handoff/messages from a post-restart snapshot | Restarted panes show an empty screen | `--run "$RUN"`: the stage-1 snapshot from the manifest |
| Counting "sent" as "restarted" | Delivery is not a re-exec, and a re-exec is not a new version | Verify pid, flags, idle, `VERSION_OK`, `SESSION_KEPT` |
| Approval reused after re-planning | The fleet the operator saw is not the fleet being restarted | Approval binds the run manifest sha; re-plan means re-approve |
| Sending a herdr omp pane through ntm, or using `herdr agent start` / `herdr agent prompt` as the restart | `herdr agent start --kind omp` pins herdr's omp, and prompt is not the slash path | Rule 16: `herdr pane send-keys <id> /restart Enter` or `/exit Enter`, then `herdr pane run` for a different build |
