---
name: fleet-restart
description: "Restarts every OMP agent pane in a tmux fleet onto the current omp-kit, plugin links and MCP servers, then hands off and re-dispatches with operator approval before any send. Use for 'restart the fleet', 'fleet-wide restart', 'restart all agents on the latest kit', 're-dispatch after restart'. Covers snapshot, align, gated /restart with per-pane verify, handoff, chief restart, flywheel re-dispatch, callback check."
license: MIT
distribution: subscribers
---

# Fleet restart

> One repeatable run from "restart the fleet" to a verified, re-dispatched fleet. Every step that touches a pane or a profile is planned, shown to the operator, approved, then executed by the script; the script refuses the mistakes the 2026-10-11 restart made.

Worked example and source of truth: `~/Developer/omp-kit/docs/handoffs/fleet-restart-20261011.md` and `omp-test/var/agent-tmp/chief-rea.95985/restart-log.json`. Tracker: ompkit-bj08.13 (restart tool), ompkit-fp72.* (gaps found that day).

## When to use

Triggers: "restart the fleet", "fleet-wide restart", "restart all agents on the latest kit", "re-dispatch after restart". Run it from the chief pane.

## When NOT to use

- **One stuck pane.** Restart that pane by hand with its live flags. Routing: `vibing-with-ntm`.
- **Installing or upgrading OMP itself.** The kit never installs OMP. Routing: `omp-kit doctor`, operator.
- **Planning the next work.** Re-dispatch here only sends the first message. Routing: `flywheel-end-to-end`, `jeff-planning-enhanced`.

## Hard rules (each one broke on 2026-10-11)

1. **Copy flags from the live process, never from the screen.** The chief rebuilt commands from the on-screen model; replaying its plan through this script refuses 24 of 32 rows (lost `--profile`, `--config`, `--thinking high`, `--auto-approve`; added a `--model` the process never had). Use `/restart` (re-execs in place, keeps argv). The respawn fallback builds the command from live args and `send` re-checks it.
2. **Detect agents by process, not model name.** An agent pane is one whose tmux process tree holds `bun …/.bun/bin/omp` or `bun …/pi-coding-agent/dist/cli.js`, excluding `__omp_worker*`. A model-name regex missed Sonnet, Muse and GLM panes, and the old plan read a worker daemon's args as the agent's.
3. **Never restart a busy pane.** Spinner in the status bar means mid-turn; the row is `QUEUE_BUSY` and is restarted at its turn boundary. An unreadable status bar is `HOLD_UNKNOWN_STATE` (fail closed). `send` re-reads the screen right before each send.
4. **ntm needs the fleet socket.** Without `TMUX_TMPDIR=/Users/josh/.tmux-sockets` (or `$TMUX`) ntm reports "no tmux sessions running". `env` checks it; `send --apply` refuses without it.
5. **No message or keystroke reaches a pane without operator approval.** On 2026-10-11 the chief sent director messages before Josh approved, and Josh had to interrupt all six. `send --apply` needs an approval file bound to the manifest's sha256 and carrying the operator's words verbatim. Write that file only from an operator message in this conversation; the script binds the approval to the bytes but cannot prove a human wrote it.
6. **Plugin links must point at the active release before any restart.** `omp-kit update --apply` (CLI) never relinks, and kits before companion 38868de report stale links as UNCHANGED (RELINK1, ompkit-fp72.18). `plan` refuses with `ALIGN_STALE` until every link resolves to `releases/<omp-kit --version>`.
7. **Skip what is not yours.** The chief pane, the protected pane `uds--burn-down:0.0` (%31), shell and user panes, and any pane whose cwd is `/private/tmp` or `/tmp` (`HOLD_CWD`: the operator moves it into its repo). A stale user pane is a HEALTH warning, not a block.
8. **One callback grammar.** Until ompkit-fp72.10 lands, every first message asks for `DONE|BLOCKED <bead> <sha> <evidence>; NEXT <item>`, the line kit-callback parses.

## Setup

```bash
SKILL=<directory holding this SKILL.md>      # e.g. ~/.local/opt/omp-kit/releases/<v>/skills/fleet-restart
FR="python3 $SKILL/scripts/fleet_restart.py"
RUN=/Users/josh/Developer/omp-test/var/agent-tmp/fleet-restart-$(date +%Y%m%d).$$
mkdir -p "$RUN"; printf 'pid=%s\nlabel=fleet-restart\npurpose=fleet restart run\n' $$ > "$RUN/.owner"; export TMPDIR="$RUN"
export TMUX_TMPDIR=/Users/josh/.tmux-sockets
python3 "$SKILL/scripts/selftest.py"          # every gate must still bite; stop on FAIL
$FR env                                      # exit 2 = TMUX env/socket missing
```

## Procedure

Each stage ends at a named gate. Gates marked **OPERATOR** need the operator's explicit go in this conversation.

### 1. SNAPSHOT (read-only)

```bash
$FR snapshot --out "$RUN/snapshot"           # inventory.json, panes/<s.w.p>.md (2000 lines), pane-status.json
```

Add closes-today and last-report per session if the operator wants a sitrep. Nothing is sent.

### 2. GATE: plan and approval **OPERATOR**

```bash
$FR plan --inventory "$RUN/snapshot/inventory.json" --out "$RUN/plan.json"   # exit 3 = ALIGN_STALE
```

Show the operator: target kit version, count per action (`RESTART`, `QUEUE_BUSY`, `HOLD_*`, `SKIP_*`), every `HOLD_*` row, the director list you propose (pane position is not a role: `uds--burn-down:0.1` is a worker, `control-plane:0.1` runs UDS), and stages 3–8 below. Get one go for align + restart. Messages (stage 7) get their own approval.

### 3. ALIGN: kit, plugin links, MCP baseline

```bash
V=<target version>
gh release download v$V --repo JYeswak/omp-kit-companion --dir "$RUN/rel$V"
omp-kit update --plan --version $V --index "$RUN/rel$V/release-index.json" --archive "$RUN/rel$V/omp-kit-v$V-darwin-arm64-none.tar" --json
omp-kit update --apply --yes --version $V --index "$RUN/rel$V/release-index.json" --archive "$RUN/rel$V/omp-kit-v$V-darwin-arm64-none.tar" --json   # after the stage-2 go
A=$(omp-kit --version | awk '{print $2}')
omp-kit apply plugin --plan  --store ~/.local/opt/omp-kit/releases/$A --profiles all --include-default --json
omp-kit apply plugin --apply --yes --store ~/.local/opt/omp-kit/releases/$A --profiles all --include-default --json
$FR align                                    # exit 0 = every link -> releases/$A
```

If `align` still lists stale links (kit older than 38868de reports them UNCHANGED), say so to the operator and use the interim relink, then re-run `align`:

```bash
$FR align --relink                           # plan: link, old_target, new_target
$FR align --relink --apply --approved-by <operator> --undo "$RUN/relink-undo.json"   # atomic replace; undo command inside the record
```

MCP baseline (record the receipt id):

```bash
omp-kit test --mcp --profiles default,claude,codex,muse,glm,grok --servers rea \
  --call 'rea:binary_session:{"expected_package_version":"<rea version>"}' \
  --expect 'rea:"alignment":\{"state":"aligned"' --json
```

Gate: `align` exit 0 and every MCP server CALLABLE. Otherwise stop and report; never restart onto a half-aligned install.

### 4. RESTART + VERIFY

```bash
$FR plan --inventory <fresh snapshot or omit for live> --out "$RUN/plan.json"   # re-plan after align
$FR manifest restart --plan "$RUN/plan.json" --out "$RUN/restart-manifest.json"
$FR send --manifest "$RUN/restart-manifest.json"                               # dry run: exact ntm argv per pane
$FR approval-template --manifest "$RUN/restart-manifest.json" > "$RUN/restart-approval.json"   # fill approved_by + verbatim quote
$FR send --manifest "$RUN/restart-manifest.json" --apply --approval "$RUN/restart-approval.json" --log "$RUN/restart-log.json"
sleep 20
$FR verify --plan "$RUN/plan.json" --sent-log "$RUN/restart-log.json" --expect-mcp rea-agents=<rea version>
```

`verify` passes a pane only when: same omp pid (re-exec in place), MCP child pids changed, flags equal ignoring `--resume`, MCP versions as expected, idle prompt. Exit 5 lists failures; fix each by hand from its live flags, then re-verify.

`QUEUE_BUSY` panes: one bounded background `ntm wait <session> --pane=<N> --until=complete --timeout=5m --json` per pane, reaped on its end (idle/timeout is never DONE). At the boundary: re-plan, then `manifest restart --only <pane>` → dry run → a new approval file for the new manifest (quote the operator's stage-2 go; it covered this pane) → send → verify. `/restart` unavailable? `manifest respawn` builds `cd <cwd> && omp <live flags>`; `send` refuses any row whose flags differ from the live process.

### 5. HANDOFF

```bash
$FR handoff --plan "$RUN/plan.json" --snapshot "$RUN/snapshot" --out ~/Developer/omp-kit/docs/handoffs/fleet-restart-$(date +%Y%m%d).md
```

Then fill the open sections from evidence: verify result, queued panes, HEALTH/INIT state per repo, beads awaiting INTEGRATE, open PRs, defects found this run (file each as a bead). Save it through the omp-kit save path.

### 6. CHIEF RESTART **OPERATOR**

The chief never restarts itself mid-turn and never restarts its own pane from a script. Tell the operator the handoff path; the operator restarts the chief. The new chief reads the handoff first, then continues at stage 7.

### 7. RE-DISPATCH per flywheel-end-to-end **OPERATOR**

```bash
$FR manifest messages --plan "$RUN/plan.json" --handoff <handoff.md> --snapshot "$RUN/snapshot" \
  --staged-dir "$RUN/staged" --directors <s:w.p> [--directors …] --out "$RUN/messages-manifest.json"
```

Show the operator the staged files (`$RUN/staged/*.txt`). Directors get: read handoff + own row + snapshot → HEALTH (`flywheel doctor --repo <repo> --json`, `ntm health <session> --json`) → INTEGRATE (verify, close or reopen pushed beads) → DISPATCH from `br ready`. Workers get: own row + snapshot → next bead from own `br ready` frontier. Both end with the callback line (rule 8).

After the operator's go: `approval-template` → fill → `send --role director --apply …`. Workers only after each director's HEALTH callback: `send --role worker --apply …` (same manifest and approval). A staged file edited after approval is refused.

### 8. VERIFY callbacks and sitrep

- Every director replies with one callback line; DONE needs a sha on origin/main, BLOCKED needs the blocker. A prose-only reply is not a callback; ask once, then record it as BLOCKED.
- Read the fleet only through the parser, never by eye: `python3 $SKILL/scripts/sitrep.py --repo <tracker repo with no agent pane> --out "$RUN/sitrep.json"`. It returns, per agent pane: state, flags, MCP versions and the last parsed callback. Per repo it returns open, in-progress and ready counts, closes today, and main CI. Every number in the handoff sitrep must trace to a field of that JSON (its `sha256` names the receipt). `python3 $SKILL/scripts/sitrep.py --selftest` must pass first.
- Two traps the parser handles: `br list --json` without `--status` omits closed beads (so a close count built on it is always 0), and real callbacks carry `;` inside the evidence (the split is on the last `; NEXT`).
- Append the sitrep to the handoff: restarted/verified counts, callbacks received, beads closed or reopened, panes still queued, defects filed.

## Done-bar

A fresh chief, given only this skill, takes a live fleet from snapshot to verified restart and approved re-dispatch on a new day: `verify` exit 0 for every SENT pane, zero sends without an approval file, the handoff committed, every director callback recorded. Baseline is the 2026-10-11 run (24 of 32 screen-built commands wrong, messages sent before approval). Current proof is static: `python3 scripts/selftest.py` (41 gates, each with a planted negative or paired control) plus read-only live `env`/`align`/`snapshot`/`plan`/dry-run `send`. The fresh-agent materialization run is still open.

## Anti-patterns

| Failure | Why it fails | Fix |
|---|---|---|
| Launch command typed from the status bar | The screen shows a model, not the argv; flags vanish silently | `/restart`, or `manifest respawn` from live args |
| Agent list from model-name regex | New model names (Sonnet, Muse, GLM) fall through | Process tree: `bun …/omp` or `…/cli.js`, minus `__omp_worker` |
| `/restart` into a spinning pane | Interrupts the turn and loses unsaved work | `QUEUE_BUSY`; restart at the turn boundary |
| Trusting `omp-kit update` postcheck for plugin links | CLI update never relinks; older kits call stale links UNCHANGED | `apply plugin`, then `align` until exit 0 |
| Sending director messages while the plan is pending | Operator must interrupt every pane | Stage, show, approve, then `send --apply` |
| Counting "sent" as "restarted" | ntm delivery is not a re-exec | `verify` with `--sent-log`: new MCP child pids, same flags, idle |
| Two callback grammars in one fleet | kit-callback drops the other as IDLE | One line: `DONE\|BLOCKED <bead> <sha> <evidence>; NEXT <item>` |
