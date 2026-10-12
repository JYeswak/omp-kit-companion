# omp-kit

<div align="center">

![Yuzu testing omp rule behavior](visual/hero.jpg)

[![CI](https://github.com/JYeswak/omp-kit-companion/actions/workflows/ci.yml/badge.svg)](https://github.com/JYeswak/omp-kit-companion/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/JYeswak/omp-kit-companion)](https://github.com/JYeswak/omp-kit-companion/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Test OMP rules, preview every change, apply with receipts.**

</div>

A tested rule pack, five guard extensions, four skills, and a guarded CLI for
an existing OMP install. Every change
the CLI makes is planned first, written with a receipt, and reversible with
`omp-kit undo`.

```sh
# Resolve the newest published release at run time, then dry-run the installer.
KIT_VERSION=$(curl -fsSL https://api.github.com/repos/JYeswak/omp-kit-companion/releases/latest | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"].removeprefix("v"))')
KIT_INDEX="https://github.com/JYeswak/omp-kit-companion/releases/download/v$KIT_VERSION/release-index.json"
KIT_RAW="https://raw.githubusercontent.com/JYeswak/omp-kit-companion/v$KIT_VERSION/installer"
KIT_INSTALLER=$(mktemp -d)
curl -fsSL -o "$KIT_INSTALLER/install.sh" "$KIT_RAW/install.sh"
curl -fsSL -o "$KIT_INSTALLER/install.py" "$KIT_RAW/install.py"
sh "$KIT_INSTALLER/install.sh" --version "$KIT_VERSION" --index "$KIT_INDEX" --dry-run
sh "$KIT_INSTALLER/install.sh" --version "$KIT_VERSION" --index "$KIT_INDEX"
```

Release history lives in [CHANGELOG.md](CHANGELOG.md); every release body on
GitHub is the matching CHANGELOG section.

## TL;DR

**The problem.** OMP's stream-triggered rules (TTSR) are regular expressions
that interrupt an agent mid-turn. A rule that never fires looks exactly like a
rule that works, and a rule that fires on harmless text burns turns. Hand-edited
profiles, rule copies under `~/.agents/rules`, and per-profile `ttsr.*`
settings drift apart, and nothing records who changed what.

**The solution.** omp-kit ships a rule pack where every rule has authored fire
and near-miss cases, and a CLI that runs those cases through OMP's own matcher.
Installation into OMP profiles goes through `--plan`, then `--apply --yes`,
and every applied change leaves a receipt that `omp-kit undo` can reverse.
Around that core sit diagnostics for 30 named scopes, opt-in guard extensions
for multi-agent fleets, service jobs, and a self-updating release channel.

### Why use omp-kit

| Need | What omp-kit does |
|---|---|
| Know a rule fires | `omp-kit test` runs every authored case through the installed OMP matcher (G1 registration, G2 payload, G3 prefixes); `--full` adds the isolated live stage (G4) |
| Change profiles safely | `apply rules\|policy\|extensions\|plugin\|mcp` print a plan; `--apply --yes` writes, records a receipt, and reads each changed key back |
| Reverse a change | `omp-kit undo RUN_ID --yes` restores one receipt and refuses if a file changed since |
| See what is broken | `omp-kit doctor --scope NAME` covers 30 components, from OMP identity to leaked secrets |
| Keep agents in bounds | `fleet-guard`, `kit-save-guard`, `kit-flywheel-guard`, `kit-guard-optin`, `kit-callback` extensions |
| Stay current | The `kit-update` service installs each published release and relinks the plugin |
| Script it | Every command takes `--json` and returns one envelope; `omp-kit schema --json` describes it |

## Features

### Tested rule pack

`rules/` holds the shipped rules; `cases/cases.tsv` holds their seven-column
fire and near-miss cases. Count them and split them by class:

```sh
ls rules/*.md | wc -l
bun scripts/rule-class.ts rules/*.md
```

The pack in this tree has 30 rules: 16 `reminder`, 11 `tripwire`, 1 `always`
(`kit-standing-law`), 1 `router` (`rs-unsafe-added-router`, which loads the
unsafe-code skills when `unsafe` appears in a Rust file), and 1 `canary`
(`zz-canary-scope-probe`, a discovery probe). Tripwires cover unverified "done"
claims, evidence-free bead closes, `--no-verify`, plaintext secrets, hand edits
that turn the pack off, test skips, GitHub Actions polling, and scratch written
into durable locations. Reminders cover shell traps such as `$?` after a pipe
into `head`, force-push without `--force-with-lease`, pattern kills, and
embedded `(?i)` flags that never fire in a JS RegExp. Rules pulled from the pack
live in `retired/` with one reason per row in `retired/REASONS.tsv`.

```sh
omp-kit test --json                       # bundled pack, G1-G3
omp-kit test --full --json                # plus the isolated live stage
omp-kit test --mutants --json             # mutation adequacy of rule conditions
omp-kit test --metamorphic --json         # metamorphic relations over the cases
omp-kit corpus --sessions /absolute/sessions --json   # real fire rates from local transcripts
```

### Guarded apply, receipts, undo

Each `apply` subcommand plans by default. `--apply` requests the change and
`--yes` confirms it non-interactively.

```sh
omp-kit apply rules --plan --json
omp-kit apply policy --plan --json        # per-profile ttsr.* through native `omp config get/set`
omp-kit apply extensions --plan --json
omp-kit audit --json                      # receipt chronology
omp-kit why RUN_ID --json                 # one run explained
omp-kit undo RUN_ID --yes                 # restore one verified receipt
```

Receipts live under the private state root (`$XDG_STATE_HOME/omp-kit`, else
`~/.local/state/omp-kit`, mode 0700). `undo` refuses while another receipt or
update is pending, refuses an already-undone receipt, and refuses when a
postimage changed after the apply.

### Doctor: 30 diagnostic scopes

`omp-kit doctor --scope NAME` inspects one component read-only and reports
`OK`, `DEGRADED`, `DRIFT`, `UNVERIFIED`, `FAIL`, or `NOT_RUN` per finding, with
a next step. The full scope table is in the [Command reference](#command-reference).

```sh
omp-kit doctor --scope settings          # per-profile TTSR keys via native `omp config get`
omp-kit doctor --scope extensions        # extension imports that would fail to load
omp-kit doctor --scope services          # launchd/systemd jobs that are failing
omp-kit doctor --scope public-files      # missing CODEOWNERS, templates, dependabot
omp-kit doctor --scope mcp --sources     # MCP servers configured in other harnesses
```

### Secrets scan

`doctor --scope secrets` hashes every readable Infisical value to SHA-256,
tokenizes files under your shell rc files, LaunchAgents, `~/.config`,
`~/.local/bin`, `~/.codex`, `~/.claude`, `~/.omp`, `~/.local/share` and the
tmux environment, and reports the file and the vault NAME of any match. Values
are never printed. When Infisical is unreachable the result is `UNVERIFIED`,
never `PASS`.

```sh
omp-kit doctor --scope secrets --json
omp-kit doctor --scope secrets --staged   # staged blobs of the current repo
cp scripts/pre-commit-secret-scan.sh "$(git rev-parse --git-path hooks)/pre-commit"
```

The pre-commit hook blocks on exit 1 (a staged file holds a vault value). If
the scan cannot run (Infisical unreachable, exit 3, or `omp-kit` missing) it
prints a warning and lets the commit through. `OMP_KIT_BIN` overrides the
command it runs.

### Guard extensions

The repo is an OMP plugin. `package.json` declares five extensions:

| Extension | Hooks | Behavior |
|---|---|---|
| `kit-guard-optin.ts` | `tool_call` | Loads the guard from `KIT_GUARD_SRC` for repos that commit `.omp/kit-guard.json`. Opted in with the guard missing blocks every tool call |
| `fleet-guard.ts` | `tool_call` | Blocks writes outside `var/agent-tmp` (for example `/tmp` or `$HOME`), branch and worktree creation, tracked edits without an exclusive Agent Mail reservation, and reservation TTLs over the cap for paths in `.omp/hot-paths` |
| `kit-save-guard.ts` | session and tool hooks | Tracks files written by write/edit/ast_edit; at turn end blocks at most twice for unsaved repo work, then warns once. Never commits, stashes, or pushes |
| `kit-flywheel-guard.ts` | `session_compact`, `tool_call` | After compaction, tells the agent to re-read the nearest `AGENTS.md` and its in-progress bead; blocks `br close` / `bd close` on a bead assigned to the caller (`SELF_CLOSE_REFUSED`) |
| `kit-callback.ts` | `agent_end` | For worker panes listed in `fleet-watch.json`, sends the last `DONE`/`BLOCKED` line (or an `IDLE` excerpt) to the coordinator pane through `ntm send`. Never blocks |

Installing the plugin loads all five. `omp-kit apply extensions` installs only
the two listed in `policy/extensions.json` (`kit-guard-optin.ts` and
`fleet-guard.ts`) into the profiles you select:

```sh
omp-kit apply extensions --plan --profiles all --json
omp-kit apply extensions --apply --yes --profiles all
```

### Skills

`skills/` ships four OMP skills:

- **omp-native:** use native OMP tooling first: `omp ttsr list/test/scan`,
  plugin links, and read-only settings.
- **jeff-planning-enhanced:** the fleet planning protocol (plan, review,
  beads, polish), scored with `omp-kit planning score`.
- **fleet-restart:** restarts every OMP pane in a tmux fleet onto the current
  kit, plugin links and MCP servers, then hands off and re-dispatches with
  operator approval before any send. `scripts/fleet_restart.py` has `env`,
  `snapshot`, `align`, `plan`, `manifest`, `send` (dry-run by default),
  `approval-template`, `verify` and `handoff`; `scripts/sitrep.py` reports
  per-pane state, flags, MCP versions and last callback plus per-repo counts and
  CI.
- **fleet-round:** the lock-step fleet round protocol and a read-only
  validator for its reports. `scripts/fleet-round.ts` has `collect`,
  `snapshot`, `check`, `validate`, `spot-check` and `score`: it recomputes
  each director's claims from br, git, tmux and Agent Mail identity files,
  checks the round-0 pass bar, and reports UNKNOWN, never PASS, for anything
  it cannot observe.

```sh
python3 skills/fleet-restart/scripts/sitrep.py --selftest
bun skills/fleet-round/scripts/fleet-round.ts check --config fleet.json --project app --focus app-e1,app-e2,app-e3
omp-kit planning score --json
```

### Fleet operations

```sh
omp-kit send SESSION PANE "message" --json   # proves delivery; needs a bead id or --no-bead-reason
omp-kit fleet flush-pending --json           # plan: queued bands, frozen turns
omp-kit scratch plan --json                  # reap report over scratch roots
omp-kit ci status --json                     # cached CI, never calls GitHub
omp-kit heavy --label cli-tests -- bun test tests/cli   # load-admitted, nice 10
```

`send` wraps `ntm`, polls for a marker, retries once, and drops undelivered
messages into the state root; the exit code reports delivery (`OK`,
`PENDING_SUBMIT`, `NOT_DELIVERED`), not whether the send call ran. Fleet Watch
is an opt-in service that nudges idle workers and escalates to the coordinator;
see [docs/fleet-watch.md](docs/fleet-watch.md).

### Service jobs and kit updates

`omp-kit service` manages nine launchd (macOS) or systemd (Linux) jobs, labeled
`com.omp-kit.<name>`: `omp-watch`, `scratch-reaper` (every 6 h), `kit-update`
(every 300 s), `fleet-watch` (120 s), `fleet-lessons` (6 h), `load-watch`
(60 s), `ci-poller` (60 s), `claude-save` (1 h), and `fleet-flush` (60 s).
Install previews a diff first and keeps a backup.

```sh
omp-kit service list --json
omp-kit service install kit-update --dry-run --json
omp-kit update --plan --version X.Y.Z --index /absolute/release-index.json --archive /absolute/omp-kit.tar --json
```

`update` never infers "latest": it takes an exact version and absolute local
index and archive paths, then reruns the matcher and live post-checks after
applying. The `kit-update` service is the path that follows new releases
automatically; see [Release and update flow](#how-it-works).

### OMP source cache

OMP installed through Tern ships compiled code without the TypeScript the
matcher needs. omp-kit fetches `@oh-my-pi/pi-coding-agent` at the exact
installed OMP version into `$HOME/.local/opt/omp-kit/omp-src/<version>` (or
`OMP_KIT_OMP_SRC_CACHE`) with `bun add --exact --ignore-scripts`, checks npm
integrity, and keeps the two newest versions. An entry is used only with its
`.verified.json` receipt and matching files. `OMP_KIT_OMP_SRC_FETCH=0` stops new
fetches.

```sh
omp-kit --info     # shows the OMP launcher, its version proof and the source cache entry
```

## Quick example

```sh
omp-kit status --json                       # what is installed; changes nothing
omp-kit test --json                         # prove the pack against your OMP
omp-kit apply rules --plan --json           # preview the rule install
omp-kit apply rules --apply --yes           # install it with a receipt
omp-kit audit --json                        # find the receipt id
omp-kit undo RUN_ID --yes                   # put everything back
omp-kit doctor --scope settings             # per-profile TTSR state
omp-kit robot-docs guide                    # guidance for agents driving the CLI
```

## Design philosophy

**Plan before apply.** Every mutating command defaults to a plan. Writes need
`--apply`, and non-interactive writes also need `--yes`.

**Receipts and undo.** Each mutation is recorded as a receipt in the private
state root. `undo` restores from that receipt and refuses when a file changed
since; a failed restore is reported as `PARTIAL_UNDO`, never hidden.

**Fail closed.** Anything the CLI cannot observe is `UNVERIFIED` or `NOT_RUN`,
never `PASS`. A fresh HOME reports `UNVERIFIED` until rules are applied; an
unreachable vault makes the secrets scan `UNVERIFIED`; a stale CI cache is
`UNAVAILABLE`. Exit codes are fixed: 0 success, 1 finding, 2 usage or blocked,
3 unavailable, 4 retryable (and 75 for a deferred `heavy` job).

**Native OMP first.** Rule tests run through OMP's matcher, settings go through
`omp config get/set`, and rules load through OMP's plugin loader. The
[native-OMP guide](docs/native-omp.md) teaches those primitives directly.

**Never installs OMP.** omp-kit reads your OMP setup and proposes changes. It
does not install OMP, models, providers, or profiles, and it never enables
policy or extensions by implication.

## Comparison

| | omp-kit | Plain OMP rules (`ttsr`) | Hand-written AGENTS.md text | Generic pre-commit hooks / sandboxing |
|---|---|---|---|---|
| Fires mid-turn, before the agent acts | Yes (OMP TTSR plus `tool_call` extensions) | Yes | No; the model may ignore it | Hooks fire at commit; sandboxes block at the OS boundary |
| Each rule has fire and near-miss cases | Yes, run by `omp-kit test` | You write and run `omp ttsr test` yourself | No | Hook test suites vary |
| Rule changes reviewed against old witnesses | `omp-kit review rules` | No | No | No |
| Profile changes previewed and undoable | Plan, receipt, `undo` | Manual edits | n/a | n/a |
| Fleet coordination (reservations, callbacks, sends) | Yes | No | Prose only | No |
| Secret scan against your real vault | `doctor --scope secrets`, pre-commit hook | No | No | Pattern scanners (e.g. gitleaks) match shapes, not your vault values |
| Isolation from the host | None; it is not a sandbox | None | None | Sandboxes isolate; hooks do not |
| Setup cost | Installer plus OMP | Built in | A text file | Per-repo hook setup |

Use plain `ttsr` for a handful of personal rules. Use omp-kit when the rules
must be proven, shared across profiles, or audited. Neither replaces a sandbox.

## Installation

Requirements: an existing OMP install with `omp` on PATH (for `status` and
`test`), plus Python 3 and `curl` for the installer (the version one-liner uses
`str.removeprefix`, so Python 3.9 or newer). Linux builds need
GNU libc. `gh` is optional; when a release ships a Sigstore bundle the installer
verifies it with `gh attestation verify`, otherwise it prints
`warning: no attestation bundle; hash-only verification`.

### 1. Latest release installer (recommended)

```sh
KIT_VERSION=$(curl -fsSL https://api.github.com/repos/JYeswak/omp-kit-companion/releases/latest | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"].removeprefix("v"))')
KIT_INDEX="https://github.com/JYeswak/omp-kit-companion/releases/download/v$KIT_VERSION/release-index.json"
KIT_RAW="https://raw.githubusercontent.com/JYeswak/omp-kit-companion/v$KIT_VERSION/installer"
KIT_INSTALLER=$(mktemp -d)
curl -fsSL -o "$KIT_INSTALLER/install.sh" "$KIT_RAW/install.sh"
curl -fsSL -o "$KIT_INSTALLER/install.py" "$KIT_RAW/install.py"
sh "$KIT_INSTALLER/install.sh" --version "$KIT_VERSION" --index "$KIT_INDEX" --prefix "$HOME/.local/opt/omp-kit" --dry-run
sh "$KIT_INSTALLER/install.sh" --version "$KIT_VERSION" --index "$KIT_INDEX" --prefix "$HOME/.local/opt/omp-kit"
export PATH="$HOME/.local/opt/omp-kit/bin:$PATH"
```

`install.sh` needs `install.py` beside it, which is why both are fetched. To
avoid the raw downloads, clone the tag instead:
`git clone --depth 1 --branch "v$KIT_VERSION" https://github.com/JYeswak/omp-kit-companion.git`
and run `sh omp-kit-companion/installer/install.sh` with the same flags.

The installer downloads only the archive for your platform, checks the archive
SHA-256, manifest SHA-256, every file hash and USTAR safety, then writes
`PREFIX/releases/<version>/` and points `PREFIX/bin/omp-kit` at it. It never
installs OMP, Bun, models, profiles, or shell startup edits, and it refuses
plain HTTP indexes, relative prefixes, and an existing release directory whose
bytes differ. Upgrading by hand is the same commands with the new version.

### 2. Rules and extensions as an OMP plugin

```sh
omp plugin install "github:JYeswak/omp-kit-companion#v$KIT_VERSION"
omp plugin list
```

This loads `rules/` and all five extensions through OMP's plugin loader. See
[docs/usage.md](docs/usage.md) for how plugin rules rank against native rules
and `~/.agents/rules` copies, and `omp-kit migrate --plan` to move legacy
copies onto plugin layering.

### 3. From source

```sh
git clone https://github.com/JYeswak/omp-kit-companion.git
cd omp-kit-companion
bun install
bun src/cli.ts --help
omp plugin link "$PWD" && omp plugin list
```

A source checkout reports `kit` and `manifest` as `FAIL` because it is not a
verified release (see [Limitations](#limitations)). Contributor checks are in
[AGENTS.md](AGENTS.md).

## How it works

### Release and update flow

Every green commit on `main` that carries release notes becomes the next patch
release:

1. Each change adds a fragment under `changelog.d/` (or a `[no-changelog]`
   reason in the commit message). The pre-push gate and the release workflow
   both enforce it.
2. When CI passes on `main`, the release train folds the `changelog.d/`
   fragments into `CHANGELOG.md` under `## [Unreleased]`, promotes that heading
   to `## [X.Y.Z] - DATE`, sets the `package.json` version, commits
   `chore: bump version to X.Y.Z`, and tags `vX.Y.Z`.
3. `release.yml` builds and certifies the ship set (`darwin-arm64-none`,
   `linux-arm64-gnu`, `linux-x64-gnu`) and publishes a GitHub release whose
   body is that CHANGELOG section.
4. A green commit with no notes is not released. Red CI is never tagged, one
   train runs at a time, and the newest green commit wins.
5. On machines running the `kit-update` service with
   `OMP_KIT_UPDATE_POLL=github`, each 300-second tick asks GitHub (through
   `gh`) for the newest release, downloads it only when it is newer than the
   live install, applies it under an update receipt, and relinks the plugin
   (`apply plugin --apply`). A failed postcheck keeps the prior version.

The manual cut and rehearsal are documented in
[docs/release-procedure.md](docs/release-procedure.md).

### What a check proves

`omp-kit test` reports proof classes: G1 registration, G2 whole-payload match,
G3 prefix behavior, G4 isolated live blocking. `status` separately reports
installed files, project shadowing, and the effective profile, and says which
of those it could not observe.

## Quick start

1. Install the kit (above) and confirm OMP is on PATH: `omp --version`.
2. Inspect what is present. Nothing here writes:

```sh verified rc=0 contains='"ok":true'
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
"$KIT" status --json
```

3. Prove the shipped rules match as intended on your OMP:

```sh verified rc=0 contains='"status":"PASS"'
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
"$KIT" test --json
```

4. Preview the rule install:

```sh verified rc=0 contains='"action":"PLAN"'
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
"$KIT" apply rules --plan --json
```

5. Apply it, then confirm the receipt:

```sh
omp-kit apply rules --apply --yes
omp-kit audit --json
```

`--json` only formats output; only `--apply` with confirmation changes
anything. On a fresh HOME the overall status stays `UNVERIFIED` until rules are
applied. `omp-kit quickstart` prints the same safe first commands.

## Command reference

Every command accepts `--json` (one envelope: `ok`, `tool_version`, `data`,
`meta`, `warnings`, `commands`, `errors`) and `omp-kit help COMMAND` prints its
grammar. Mutating commands need `--apply` and, non-interactively, `--yes`.

| Command | Usage | What it does | Example |
|---|---|---|---|
| `omp-kit status` | `status` | Kit and OMP presence; changes nothing | `omp-kit status --json` |
| `omp-kit test` | `test [--full] [--record] [--rules DIR --cases FILE] [--integrations] [--mcp] [--metamorphic] [--mutants] [--repeat N]` | Matcher conformance, external packs, live fixtures, per-profile integration and MCP proofs, mutation and flake checks | `omp-kit test --json` |
| `omp-kit doctor` | `doctor [--scope NAME] [--project PATH] [--profile NAME] [--staged] [--deep --yes]` | Read-only diagnosis of one scope (table below) | `omp-kit doctor --scope lsp --json` |
| `omp-kit health` | `health` | Strict monitoring status | `omp-kit health --json` |
| `omp-kit apply` | `apply rules\|policy\|extensions\|plugin\|mcp [--plan\|--apply]` | Plan or apply a kit component with a receipt | `omp-kit apply rules --plan --json` |
| `omp-kit repair` | `repair --scope rules\|policy\|extensions\|state\|github [--plan\|--apply --yes]` | Reversible repair of one scope | `omp-kit repair --scope rules --plan --json` |
| `omp-kit migrate` | `migrate [--plan\|--apply --yes]` | Move legacy `~/.agents/rules` copies to plugin layering; edited copies are kept and flagged | `omp-kit migrate --plan --json` |
| `omp-kit undo` | `undo RUN_ID [--yes]` | Restore one verified receipt | `omp-kit undo RUN_ID --yes` |
| `omp-kit audit` | `audit` | Receipt chronology | `omp-kit audit --json` |
| `omp-kit why` | `why RUN_ID` | Explain one recorded run | `omp-kit why RUN_ID --json` |
| `omp-kit update` | `update [--plan\|--apply] --version X.Y.Z --index PATH --archive PATH` or `update --reconcile RECEIPT --yes [--prefix PATH]` | Guarded kit update from local index and archive; never infers latest | `omp-kit update --plan --version X.Y.Z --index /abs/release-index.json --archive /abs/omp-kit.tar --json` |
| `omp-kit review` | `review rules\|reduce` | Compare two rule versions on the union of their witnesses, or minimize a reproduced false fire | `omp-kit review rules --incumbent-rules /old/rules --incumbent-cases /old/cases.tsv --candidate-rules /new/rules --candidate-cases /new/cases.tsv --json` |
| `omp-kit corpus` | `corpus --sessions ABS_DIR [--out ABS_FILE] [--plan]` | Per-rule fire rates over local session transcripts; never uploads | `omp-kit corpus --sessions /absolute/sessions --json` |
| `omp-kit lsp` | `lsp setup --plan [--project PATH] [--file PATH]` | Language-server readiness; never installs or starts servers | `omp-kit lsp setup --plan --json` |
| `omp-kit memory` | `memory audit --store-root PATH --yes` | Separately consented audit of a Mnemopi store | `omp-kit memory audit --store-root /private/isolated/mnemopi --yes --json` |
| `omp-kit planning` | `planning score\|convert` | Score planning evidence; convert a plan into native beads (dry run into a fresh `--db`, or `--apply` to a tracker) | `omp-kit planning score --fleet --json` |
| `omp-kit mission` | `mission validate [--project PATH]` | Check `.omp/mission.toml` fields and check hashes: `VALID`, `UNREGISTERED`, `INVALID` | `omp-kit mission validate --json` |
| `omp-kit load` | `load watch` | Write one load census sample to the state root | `omp-kit load watch --json` |
| `omp-kit heavy` | `heavy [--label LABEL] [--no-wait] -- COMMAND [ARG ...]` | Run one load-admitted command at nice 10; exit 75 when deferred | `omp-kit heavy --label cli-tests -- bun test tests/cli` |
| `omp-kit service` | `service list\|install\|uninstall\|status\|doctor\|logs\|run` | Manage the kit's launchd/systemd jobs; reads foreign jobs, never rewrites them | `omp-kit service list --json` |
| `omp-kit send` | `send SESSION PANE MESSAGE [--no-bead-reason TEXT] [--drop-dir PATH]` | Send to a fleet pane and prove it landed | `omp-kit send omp-test %54 "status update" --json` |
| `omp-kit fleet` | `fleet flush-pending [--apply --yes]` | Find idle panes with queued input and frozen turns; `--apply` submits only safe queued bands | `omp-kit fleet flush-pending --json` |
| `omp-kit scratch` | `scratch plan\|release DIR\|apply [--apply --yes]` | Release, quarantine and delete scratch; idle 72 h goes to quarantine, quarantine expires after 7 days | `omp-kit scratch plan --json` |
| `omp-kit infra` | `infra pin\|check\|promote\|undo` | Pin the gate toolchain, test a candidate binary, and let a human promote it | `omp-kit infra pin --json` |
| `omp-kit ci` | `ci status` | Cached CI status per repo; `UNAVAILABLE` when the cache is older than 180 s | `omp-kit ci status --json` |
| `omp-kit examples` | `examples [memory-off\|mnemopi-manual\|model-roles\|mcp\|omp-watch\|skill-set --from-history DAYS]` | Read-only profile recipes; never activates a profile | `omp-kit examples skill-set --from-history 7 --json` |
| `omp-kit quickstart` | `quickstart` | Safe first commands and their limits | `omp-kit quickstart` |
| `omp-kit help` | `help [TOPIC]` | Grammar for a command | `omp-kit help update` |
| `omp-kit completion` | `completion bash\|zsh\|fish` | Shell completion | `omp-kit completion zsh` |
| `omp-kit capabilities` | `capabilities` | Only the commands runnable right now | `omp-kit capabilities --json` |
| `omp-kit schema` | `schema` | Envelope, command data, exit codes and grammar | `omp-kit schema --json` |
| `omp-kit robot-docs` | `robot-docs guide` | Automation guidance from the live grammar | `omp-kit robot-docs guide` |

### Subcommands

| Subcommand | What it does | Example |
|---|---|---|
| `apply rules` | Install or update kit-owned rules | `omp-kit apply rules --apply --yes` |
| `apply policy` | Per-profile TTSR keys via native `omp config set`, with profile backup and read-back; `--profiles NAMES\|all`, `--include-default` | `omp-kit apply policy --plan --json` |
| `apply extensions` | Install `kit-guard-optin.ts` and `fleet-guard.ts` into selected profiles | `omp-kit apply extensions --plan --profiles all --json` |
| `apply plugin` | Link the installed kit package into covered profiles; `--regex-budget-report` disables slow rules in named profiles only | `omp-kit apply plugin --plan --store /abs/kit-release --regex-budget-report /abs/regex-budget.out --profiles all --include-default --json` |
| `apply mcp` | Import MCP servers from claude, cursor, codex, project or a file into profiles' `mcp.json`, or edit servers already there (`--env-command`, `--enable`) | `omp-kit apply mcp --from claude --servers z3-prover --profiles all --plan --json` |
| `repair --scope rules` / `policy` / `extensions` | Reversible repair of that component | `omp-kit repair --scope policy --plan --json` |
| `repair --scope state` | Restore the private state root to mode 0700, nothing else | `omp-kit repair --scope state --plan --json` |
| `repair --scope github` | Rewrite `hosts.yml` from the Infisical fine-grained token | `omp-kit repair --scope github --plan --json` |
| `service list` / `status [JOB\|--all]` | Known jobs with installed and loaded state | `omp-kit service status --all --json` |
| `service install JOB` | Render, diff, back up, bootstrap, verify; `--replace` takes over a label loaded from another plist | `omp-kit service install omp-watch --dry-run --json` |
| `service uninstall JOB` | Bootout and move the plist to backup; `--purge-logs` deletes logs | `omp-kit service uninstall omp-watch --apply --yes --json` |
| `service doctor [JOB\|--all]` | Read-only checks; `--fix --apply --yes` reinstalls drifted jobs and rotates logs | `omp-kit service doctor --all --json` |
| `service logs JOB` | Print out or err logs (`--errors`, `-n N`) | `omp-kit service logs omp-watch -n 50` |
| `service run JOB` | Run one job now and write a receipt | `omp-kit service run omp-watch --json` |
| `infra pin` | Pinned toolchain versions and drift (`--file PATH`) | `omp-kit infra pin --json` |
| `infra check` | Run the ladder with a candidate binary first on PATH: `PASS`, `FAIL`, `INCONCLUSIVE`; refuses above 1.5x cores unless `--wait` or `--force` | `omp-kit infra check --tool bun --candidate X.Y.Z --binary /abs/bun --json` |
| `infra promote` | Certify a checked candidate into the pin file (`--human --apply --yes`) | `omp-kit infra promote --tool bun --candidate X.Y.Z --binary /abs/bun --human --apply --yes` |
| `infra undo` | Restore the pin file from a promote backup | `omp-kit infra undo --receipt PATH --apply --yes` |
| `scratch plan` / `release DIR` / `apply` | Report, mark one task directory finished, or quarantine and delete per plan | `omp-kit scratch release /repo/var/agent-tmp/omp.123 --json` |
| `examples memory-off` / `mnemopi-manual` / `model-roles` / `mcp` / `omp-watch` / `skill-set` | Versioned, unverified recipes for manual use; `omp-watch` renders the service file without installing it | `omp-kit examples omp-watch --json` |
| `planning convert` | Fenced Markdown plan to native beads: `CLEAN`, `FINDINGS`, `REFUSED`, `UNAVAILABLE` | `omp-kit planning convert --plan PLAN.md --mission core8 --dry-run --db var/agent-tmp/plan-run --json` |
| `review reduce` | Minimize a public-synthetic false fire without weakening its benign context | `omp-kit review reduce --rules /abs/rules --fixture /abs/fixture.json --json` |

### Doctor scopes

| Scope | What it reports | Example |
|---|---|---|
| `--scope kit` | Release rule inventory, manifest, and packaged planning skill | `omp-kit doctor --scope kit` |
| `--scope omp` | OMP launcher identity and its source package | `omp-kit doctor --scope omp` |
| `--scope rules` | Installed, effective, project, and retired rules against the manifest | `omp-kit doctor --scope rules` |
| `--scope policy` | Per-profile TTSR keys through native `omp config get` | `omp-kit doctor --scope policy` |
| `--scope settings` | Per-key TTSR status for the selected profiles | `omp-kit doctor --scope settings` |
| `--scope extensions` | Extension listing and imports that would fail to load | `omp-kit doctor --scope extensions` |
| `--scope router` | Router skill tooling presence | `omp-kit doctor --scope router` |
| `--scope profile` | On-disk settings, with the limits of what they prove | `omp-kit doctor --scope profile` |
| `--scope lsp` | Language-server configuration layers; `--deep --yes` probes TypeScript in a private fixture | `omp-kit doctor --scope lsp --file src/cli.ts` |
| `--scope project-loading` | Startup inputs a project would load | `omp-kit doctor --scope project-loading --project PATH` |
| `--scope work` | Git state and stale reserved edits across `OMP_KIT_WORK_ROOTS` | `omp-kit doctor --scope work --root ~/Developer` |
| `--scope sessions` | Running OMP sessions: `CURRENT`, `STALE`, or `UNVERIFIED` against the install | `omp-kit doctor --scope sessions` |
| `--scope load` | Load average and memory pressure: `OK` or `CONTENDED` | `omp-kit doctor --scope load` |
| `--scope memory` | Memory configuration readiness for a profile | `omp-kit doctor --scope memory --profile NAME` |
| `--scope mcp` | MCP readiness for a profile; `--sources` lists servers in other harness configs | `omp-kit doctor --scope mcp --profile NAME` |
| `--scope context` | Context inventory for a profile and project | `omp-kit doctor --scope context --profile NAME` |
| `--scope browsers` | Browser processes and leftover automation clones | `omp-kit doctor --scope browsers` |
| `--scope services` | launchd jobs: running, idle, failing, path mismatch; `--services FILE` checks a required-jobs list | `omp-kit doctor --scope services` |
| `--scope regex-tools` | Regex engineering tools on PATH | `omp-kit doctor --scope regex-tools` |
| `--scope dicklesworthstone` | Installed agent tools (`ntm`, `am`, `caam`, ...) behind their latest release | `omp-kit doctor --scope dicklesworthstone` |
| `--scope beads` | Acceptance criteria kept in their dedicated field | `omp-kit doctor --scope beads --project PATH` |
| `--scope reservations` | Exclusive Agent Mail holds past the age limit | `omp-kit doctor --scope reservations --project PATH` |
| `--scope identity` | Pane identities that are missing, shared, or stale | `omp-kit doctor --scope identity --project PATH` |
| `--scope flywheel` | Fleet practice grades from git and the tracker (`BEADS_DB`) | `omp-kit doctor --scope flywheel --project PATH` |
| `--scope fleet` | Live panes and Agent Mail: `DIRECTOR_DOING_WORK`, `COMMUNICATION_PURGATORY`, frozen turns, stale steering | `omp-kit doctor --scope fleet` |
| `--scope derived` | Literal facts in config files that a probe should replace | `omp-kit doctor --scope derived --project PATH` |
| `--scope layout` | Deviations from the standard repo layout | `omp-kit doctor --scope layout --project PATH` |
| `--scope public-files` | Missing standard public files | `omp-kit doctor --scope public-files --project PATH` |
| `--scope github` | Read-only GitHub capability probes | `omp-kit doctor --scope github` |
| `--scope secrets` | Files holding an Infisical value, by file and vault name; `--staged` for the pre-commit hook | `omp-kit doctor --scope secrets --staged` |

`doctor` also takes rules-calibration flags (`--corpus-report`, `--labels`,
`--seed`, `--sample-size`, `--noisy-lower-bound`) for reading an F2 corpus
report without writing.

## Architecture

```
  rules/*.md  cases/cases.tsv  extensions/*.ts  skills/*  policy/*.json
        │                                │
        ▼                                ▼
  ┌──────────────────────┐      ┌───────────────────────────┐
  │ plugin package       │      │ omp-kit CLI (bun-compiled)│
  │ package.json "omp"   │      │ status/test/doctor/apply  │
  └──────────┬───────────┘      └──────┬─────────────┬──────┘
             │ omp plugin install/link │ native omp  │ receipts, logs,
             ▼                         ▼ config/ttsr ▼ census, send-drop
  ┌──────────────────────────────────────┐   ┌──────────────────────────┐
  │ OMP profiles: rules, ttsr.* policy,  │   │ state root               │
  │ extensions, mcp.json                 │   │ $XDG_STATE_HOME/omp-kit  │
  └──────────────────────────────────────┘   └──────────────────────────┘
                                                 ▲
  service jobs (launchd/systemd): omp-watch, kit-update, fleet-watch,
  scratch-reaper, ci-poller, load-watch, fleet-lessons, claude-save, fleet-flush

  green main + changelog.d ──► release train ──► tag vX.Y.Z ──► release.yml
      ──► GitHub release (index + archives) ──► kit-update poll ──► update + relink plugin
```

## Configuration

| Name | Purpose | Default |
|---|---|---|
| `XDG_STATE_HOME` | State root for receipts, census, logs; must be absolute | `~/.local/state` → `omp-kit/` |
| `$XDG_CONFIG_HOME/omp-kit/ttsr-profiles.json` | Profiles `apply policy` manages | absent: every named profile |
| `~/.config/omp-kit/fleet-watch.json`, `OMP_KIT_FLEET_WATCH_CONFIG` | Fleet Watch sessions | none; the service refuses without it |
| `$XDG_CONFIG_HOME/omp-kit/load.json` | `heavy` slots and maximum wait | 2 slots |
| `config/planning-score.toml`, `<repo>/.omp/planning-score.toml` | Planning score tuning and fleet list | kit defaults |
| `config/lessons.toml` | fleet-lessons job | kit defaults |
| `config/beads-policy.template.yaml` | Strict `.beads/policy.yaml` template, copied by hand | n/a |
| `.omp/infra-pins.toml` | Toolchain pins for `infra` | kit copy, `--file` overrides |
| `.omp/mission.toml` | Mission record for `mission validate` | n/a |
| `.omp/kit-guard.json` | Per-repo opt-in for `kit-guard-optin` | absent: off |
| `.omp/fleet-guard.json` | Opt out of fleet-guard's branch rule | absent: rule on |
| `.omp/hot-paths` | Paths whose reservation TTL is capped | none |
| `KIT_GUARD_SRC` | Guard source for `kit-guard-optin` | unset: opted-in repos block all tool calls |
| `OMP_KIT_UPDATE_ENABLED`, `_POLL`, `_REPO`, `_INDEX`, `_ARCHIVE`, `_VERSION`, `_SOURCE_TAG` | kit-update job, read at `service install` | disabled |
| `OMP_KIT_OMP_SRC_CACHE`, `OMP_KIT_OMP_SRC_FETCH` | OMP source cache root, fetch switch | `~/.local/opt/omp-kit/omp-src`, fetch on |
| `OMP_KIT_SECRET_SCAN_ROOTS`, `_REPOS`, `_TMUX_ENV`, `_UNREACHABLE`, `OMP_KIT_SECRET_DIGESTS_FILE` | Secrets scan inputs | built-in roots |
| `OMP_KIT_WORK_ROOTS`, `OMP_KIT_WORK_STALE_EDIT_MINUTES` | `doctor --scope work` | `~/Developer` |
| `OMP_KIT_CI_REPOS`, `OMP_KIT_GITHUB_API` | ci-poller repos and API | this repo, api.github.com |
| `OMP_KIT_SCRATCH_ROOTS` | Scratch roots | `TMPDIR` and `/tmp` scan |
| `OMP_KIT_BEAD_PREFIXES` | Bead id prefixes `send` recognizes | tracker prefixes |
| `OMP_KIT_SERVICES_DIRS` | Extra job directories for `doctor --scope services` | none |
| `OMP_KIT_ATTEST_OWNER`, `GH_BIN` | Installer attestation owner and `gh` binary | `JYeswak`, `gh` |
| `OMP_KIT_BIN` | Command the pre-commit hook runs | `omp-kit` |
| `TMUX_TMPDIR` | tmux socket directory; required by fleet-watch | none |
| `AGENT_MAIL_STORAGE_ROOT` | Agent Mail store for reservations and fleet scopes | unset: `UNVERIFIED` |
| `BEADS_DB` | Tracker database for `doctor --scope flywheel` | `<project>/.beads/beads.db` |

Example files:

```jsonc
// $XDG_CONFIG_HOME/omp-kit/ttsr-profiles.json: unique profile names, "default" allowed.
// An empty, duplicated, or invalid list fails closed (PROFILE_LIST_UNVERIFIED).
["default", "work"]
```

```jsonc
// $XDG_CONFIG_HOME/omp-kit/load.json: slots 1..64, max_wait_s in seconds
{ "slots": 2, "max_wait_s": 600 }
```

```jsonc
// ~/.config/omp-kit/fleet-watch.json (full reference: docs/fleet-watch.md)
{
  "enabled": true,
  "intervalSeconds": 120,
  "noDecisionChecks": 5,
  "sessions": [
    {
      "session": "feature-workers",       // worker tmux session
      "coordinatorSession": "orchestrator",
      "coordinatorPane": "%54",
      "repo": "<repo-path-on-this-dispatcher>",
      "workerPanes": ["%1", "%2"],
      "readyCommand": "br ready --json"
    }
  ]
}
```

Turn on automatic updates (the environment is captured into the job file):

```sh
OMP_KIT_UPDATE_ENABLED=1 OMP_KIT_UPDATE_POLL=github OMP_KIT_UPDATE_REPO=JYeswak/omp-kit-companion \
  omp-kit service install kit-update --apply --yes
```

## Troubleshooting

| Error | Meaning | Fix |
|---|---|---|
| `OMP_UNAVAILABLE` | No supported `omp` launcher on PATH | Install OMP your usual way and put `omp` on PATH; omp-kit will not install it |
| `REQUIRED_FINDING_FAILED: Release rule inventory cannot be verified` | `doctor --scope kit` ran from a source tree or a damaged install | Use an intact, verified release from the installer |
| `PENDING_RECOVERY` / `PARTIAL_UNDO` | A receipt or inverse mutation needs recovery; nothing was rolled back or deleted | Run `omp-kit audit --json`, check the postimages, then `omp-kit update --reconcile RECEIPT --yes` for an update or `omp-kit undo RECEIPT --yes` |
| `INVALID_STATE_ROOT` | `XDG_STATE_HOME` is relative or not canonical | Set an absolute `XDG_STATE_HOME` or unset it; `omp-kit repair --scope state` fixes only the mode |
| `KIT_UPDATE_JOB_CONFIG` | kit-update has neither a static tuple nor poll settings | Set `OMP_KIT_UPDATE_POLL=github` with `OMP_KIT_UPDATE_REPO=owner/repo`, or the four static inputs, or leave the job off |
| `BUNDLED_RUNTIME_UNAVAILABLE` | The release is missing `scripts/ttsr-harness.ts` or its resources | Reinstall an intact release and rerun |
| `REGEX_BUDGET_REPORT_INVALID` | `--regex-budget-report` has no valid `JSON_REPORT=` line | Capture the full `scripts/regex-budget.ts` output, even on nonzero exit |
| `FLEET_WATCH_CONFIG_MISSING` / `FLEET_WATCH_TMUX_TMPDIR_MISSING` | Fleet Watch has no config or no tmux socket directory | Create `~/.config/omp-kit/fleet-watch.json` and export `TMUX_TMPDIR` before installing the service |
| `installer: refused: archive SHA-256 mismatch or size limit` | The downloaded archive does not match the index | Re-download; do not bypass the check |
| `BEAD_REQUIRED` from `send` | A work dispatch cites no bead id | Add the bead id or pass `--no-bead-reason TEXT` |

## Limitations

- **Source checkouts:** running `bun src/cli.ts` reports `kit` and `manifest`
  as `FAIL` and the version as `unreleased`; only an installed release can be
  verified.
- **Case gate versus live blocking:** `omp-kit test` proves registration,
  whole-payload matches and prefix behavior. Only the isolated live stage
  (`--full`) checks that a rule blocks. Stored TTSR values do not prove that a
  running OMP session loaded or enforced the policy.
- **Shadowing:** project-local rules can shadow installed global rules.
- **No sandbox:** passing rules prove the tested pack on the tested OMP, not
  your effective profile, and extensions do not isolate anything.
- **Platforms:** releases ship `darwin-arm64-none`, `linux-arm64-gnu` and
  `linux-x64-gnu`. Intel macOS (`darwin-x64-none`) is a CI probe only; the
  installer maps it but no archive is published.
- **Homebrew:** `packaging/homebrew/omp-kit.rb` is pinned to an old release
  and the tap is not published, so it is not an install path.
- **kit-callback config path:** the extension reads
  `~/.config/omp-kit/fleet-watch.json` directly and ignores
  `OMP_KIT_FLEET_WATCH_CONFIG`.
- **`update` is manual-input only:** it needs an exact version plus local index
  and archive; only the `kit-update` poll follows new releases, and it needs
  `gh`.
- **Several doctor scopes need context:** `mcp`, `memory` and `context` need
  `--profile`; `reservations` and `fleet` need `AGENT_MAIL_STORAGE_ROOT`; and
  `flywheel` needs a tracker database.

What was tried and did not work is in [NEGATIVE_EVIDENCE.md](NEGATIVE_EVIDENCE.md);
what is planned is in [ROADMAP.md](ROADMAP.md).

## FAQ

**Does omp-kit install or update OMP?**
No. It reads the OMP you have, refuses with `OMP_UNAVAILABLE` when there is
none, and leaves OMP updates to your OMP install method. The
[compatibility matrix](docs/omp-compatibility.md) lists the OMP releases each
certification tested.

**Do I need both the installer and the plugin?**
The plugin alone gives you the rules and extensions inside OMP. The installer
gives you the CLI for testing, diagnosis, receipts, services and updates. Most
setups use both.

**How do I see which release I have and what changed?**
`omp-kit --info` prints the installed version and paths. What changed in each
release is in [CHANGELOG.md](CHANGELOG.md) and on the GitHub release page.

**Can I write my own rules and test them the same way?**
Yes. Put rules in a directory and cases in the seven-column TSV format, then
run `omp-kit test --rules /abs/rules --cases /abs/cases.tsv --json`. `review
rules` compares a candidate against the incumbent's witnesses. The
[usage guide](docs/usage.md) covers the format.

**Does anything run in the background?**
Only service jobs you install with `omp-kit service install`. The CLI itself is
not a daemon.

**How do agents drive it?**
`omp-kit robot-docs guide`, `omp-kit capabilities --json` and
`omp-kit schema --json` describe the grammar, the runnable commands, and the
envelope. Repository rules for agents working on the kit are in
[AGENTS.md](AGENTS.md).

**Where do I report a bug or a vulnerability?**
Bugs: [CONTRIBUTING.md](CONTRIBUTING.md). Sensitive reports:
[SECURITY.md](SECURITY.md).

## About Contributions

Bug reports and focused proposals are welcome through GitHub issues. A pull request is a proposal, not an automatic merge commitment; the maintainer may independently implement a change after review. Do not post session logs, local absolute paths, credentials, or private model transcripts. Use `CONTRIBUTING.md` for the workflow and `SECURITY.md` for sensitive reports.

Maintained by [JYeswak](https://github.com/JYeswak).

## License

MIT. See [LICENSE](LICENSE).

<!-- verified-ttsr-docs:start -->
Minimum supported OMP: 18.4.2.
Last verified against OMP 18.4.9 on 2026-10-01 by `bun test
tests/cli/docs.test.ts`. Refresh with `sh scripts/docs-footer.sh`; the
OMP certification workflow re-runs the same check against each new OMP
release before it becomes the certified version.
<!-- verified-ttsr-docs:end -->
