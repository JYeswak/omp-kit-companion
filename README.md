# omp-kit

<div align="center">

![Yuzu testing omp rule behavior](visual/hero.jpg)

[![CI](https://github.com/JYeswak/omp-kit-companion/actions/workflows/ci.yml/badge.svg)](https://github.com/JYeswak/omp-kit-companion/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/JYeswak/omp-kit-companion)](https://github.com/JYeswak/omp-kit-companion/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Test OMP rules, preview every change, apply with receipts.**

</div>

<!-- kit-release:start -->
Current release: v0.2.80
<!-- kit-release:end -->

A tested rule pack, 12 guard extensions, five skills, and a guarded CLI with
50 top-level commands for an existing OMP install.

```sh
# Resolve the newest published release at run time, then dry-run the installer.
# Requires `gh` authenticated (run `gh auth login` first; in automation export
# GH_TOKEN): attestation fetch and verification refuse without it. See
# [Installation](#installation) for the canonical block.
KIT_VERSION=$(curl -fsSL https://api.github.com/repos/JYeswak/omp-kit-companion/releases/latest | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"].removeprefix("v"))')
if [ -z "$KIT_VERSION" ]; then
  echo "install: could not resolve the latest omp-kit release: the GitHub API request failed (unauthenticated requests are rate-limited to 60/hour)." >&2
  echo "install: run 'gh auth login' (or export GH_TOKEN) and retry, or resolve the version with: gh api repos/JYeswak/omp-kit-companion/releases/latest --jq .tag_name" >&2
  echo "install: nothing was downloaded." >&2
  exit 1
fi
KIT_INDEX="https://github.com/JYeswak/omp-kit-companion/releases/download/v${KIT_VERSION}/release-index.json"
KIT_RAW="https://raw.githubusercontent.com/JYeswak/omp-kit-companion/v${KIT_VERSION}/installer"
KIT_INSTALLER=$(mktemp -d "${TMPDIR:-/tmp}/omp-kit-installer.XXXXXXXX")
curl -fsSL -o "$KIT_INSTALLER/install.sh" "$KIT_RAW/install.sh"
curl -fsSL -o "$KIT_INSTALLER/install.py" "$KIT_RAW/install.py"
sh "$KIT_INSTALLER/install.sh" --version "$KIT_VERSION" --index "$KIT_INDEX" --prefix "$HOME/.local/opt/omp-kit" --dry-run
sh "$KIT_INSTALLER/install.sh" --version "$KIT_VERSION" --index "$KIT_INDEX" --prefix "$HOME/.local/opt/omp-kit"
export PATH="$HOME/.local/opt/omp-kit/bin:$PATH"
```

## TL;DR

**The problem.** OMP's stream-triggered rules (TTSR) are regular expressions
that interrupt an agent mid-turn. A rule that never fires looks exactly like a
rule that works, and a rule that fires on harmless text burns turns. Hand-edited
profiles, rule copies under `~/.agents/rules`, and per-profile `ttsr.*`
settings drift apart, and nothing records who changed what.

**The solution.** omp-kit ships a rule pack where every rule has authored fire
and near-miss cases, and a CLI that runs those cases through OMP's own matcher.
Fleet guards, services and the update channel are opt-in.

### Why use omp-kit

| Need | What omp-kit does |
|---|---|
| Know a rule fires | `omp-kit test` runs every authored case through the installed OMP matcher (G1 registration, G2 payload, G3 prefixes); `--full` adds the isolated live stage (G4) |
| Change profiles safely | `apply rules\|policy\|extensions\|plugin\|mcp` print a plan; `--apply --yes` writes, records a receipt, and reads each changed key back |
| Reverse a change | `omp-kit undo RUN_ID --yes` restores one receipt and refuses if a file changed since |
| See what is broken | `omp-kit doctor --scope NAME` covers 39 scopes, from OMP identity to leaked secrets |
| Keep agents in bounds | `fleet-guard`, `kit-save-guard`, `kit-flywheel-guard`, `kit-agent-mail-guard`, `kit-guard-optin`, `kit-callback` extensions |
| Stay current | The `kit-update` service installs each published release and relinks the plugin |
| Script it | Every command takes `--json` and returns one envelope; `omp-kit schema --json` describes it |

## Features

### Tested rule pack

`rules/` holds the pack. `cases/cases.tsv` has eight columns: `rule`, `expect`,
`source`, `tool`, `path`, `snippet`, `note`, `reference_facts`. The last is empty
or a JSON `{"tracked":{"relative/path":"content"}}` map.
Count them and split them by class:

```sh
ls rules/*.md | wc -l
bun scripts/rule-class.ts rules/*.md
```

The pack has 27 rules: 13 `reminder`, 11 `tripwire`, 1 `always`
(`kit-standing-law`), 1 `router` (`rs-unsafe-added-router`), and 1 `canary`
(`zz-canary-scope-probe`). The router loads unsafe-code skills for Rust `unsafe`;
the canary tests discovery. Tripwires cover unverified "done", unevidenced closes,
`--no-verify`, secrets, configuration mutation, copied runtime facts, test skips and Actions polling.
Reminders cover pipe exit status, silenced stderr before filter pipelines, and
force-push without `--force-with-lease`, pattern kills and unsupported embedded
JS regex flags. Retired rules and reasons live in `retired/` and
`retired/REASONS.tsv`.

```sh
omp-kit test --json                       # bundled pack, G1-G3
omp-kit test --full --json                # plus the isolated live stage
```

For installed live proofs in caller-owned scratch, set `OMP_KIT_CASE_CWD` to the
absolute caller workspace and `OMP_KIT_TEST_WORK_ROOT` to an existing directory
under that workspace's `var/agent-tmp/`. The directory and its regular, non-symlink
`.owner` marker must belong to the current user; the marker's multiline `repo=`
field must name that workspace. Runtime HOME, XDG, Bun and scenario data remain
inside private children of that root. An invalid supplied root is refused, never
silently redirected to system temporary storage.

`omp-kit test --integrations --profile claude --json` executes the packaged
profile matrix. A completed command is not a claim that every integration is
wired: inspect each matrix verdict and `realOmpIntegrity`, including reported
limitations, before using the result as profile evidence.

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

### Doctor: 39 diagnostic scopes

`omp-kit doctor --scope NAME` inspects one component read-only and reports
`OK`, `DEGRADED`, `DRIFT`, `UNVERIFIED`, `FAIL`, or `NOT_RUN` per finding, with
a next step. The full scope table is in the [Command reference](#command-reference).

```sh
omp-kit doctor --scope settings          # per-profile TTSR keys via native `omp config get`
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

The repo is an OMP plugin. `package.json` declares 12 extensions:

| Extension | Hooks | Behavior |
|---|---|---|
| `kit-guard-optin.ts` | `tool_call` | Loads the guard from `KIT_GUARD_SRC` for repos with `.omp/kit-guard.json`; a missing guard blocks every tool call |
| `fleet-guard.ts` | `tool_call` | Always on: refuses `plutil -extract|-convert|-replace|-insert|-remove` without `-o` (rewrites the input plist) (`PLUTIL_IN_PLACE`). Opt-in: forbidden scratch writes and source copies, branches and worktrees, writes outside `var/agent-tmp/` without the caller's exclusive reservation (`WRITE_OWN_*`), `AGENT_MAIL_BYPASS`/`AGENT_MAIL_GUARD_MODE` (`BYPASS_ENV`), overlong hot-path reservations |
| `kit-save-guard.ts` | session and tool hooks | Opt-in only: tracks session writes, reprompts at most twice for unsaved work, then warns. Never commits, stashes or pushes |
| `kit-flywheel-guard.ts` | `session_compact`, `tool_call` | After compaction, re-reads `AGENTS.md` and the in-progress bead; refuses a self-close (`SELF_CLOSE_REFUSED`), `blocked` without an open fix (`BLOCK_REFUSED`) and a close that strands a blocked bead (`BLOCK_RELEASE_REQUIRED`) |
| `kit-agent-mail-guard.ts` | `tool_call`, `tool_result` | Opt-in: refuses mail not sent as the seat, off-list subjects, untyped `ack_required`, long or secret bodies, bulk reads |
| `kit-composer-state.ts` | session and turn hooks | Opt-in: publishes whether the seat's composer holds a draft (never its text), so reloads and arms read the seat, not its screen |
| `kit-inbox-wake.ts` | session start, timer | Opt-in: delivers the seat's own new Agent Mail in process at its next step, so mail wakes a busy seat |
| `kit-callback.ts` | `agent_end` | For `fleet-watch.json` worker panes, sends the last `DONE`/`BLOCKED` line to the coordinator via `ntm send`. Never blocks |
| `secret-output-guard.ts` | `tool_call`, `tool_execution_end` | Redacts secret-shaped tool output (gh token shapes, keychain passwords, `cf-secret` values, binding tokens) before emission; safe metadata passes through byte-identical |

Installing the plugin loads all twelve. `omp-kit apply extensions` installs only
the two listed in `policy/extensions.json` (`kit-guard-optin.ts` and
`fleet-guard.ts`) into the profiles you select:

```sh
omp-kit apply extensions --plan --profiles all --json
omp-kit apply extensions --apply --yes --profiles all
```

### Skills

`skills/` ships five OMP skills:

- **omp-kit-native:** fleet situations mapped to the native verb that handles
  them (waiting, verification, publishing, CI state, scratch, sends, doctor,
  receipts) instead of hand-rolled loops; file a bead for any missing verb.
- **omp-native:** use native OMP tooling first: `omp ttsr list/test/scan`,
  plugin links, and read-only settings.
- **jeff-planning-enhanced:** the fleet planning protocol (plan, review,
  beads, polish), scored with `omp-kit planning score`.
- **fleet-restart:** restarts every OMP pane in a tmux fleet onto the target OMP
  build, kit, plugin links and MCP servers as one approved run. `run --plan`
  writes a manifest; `run --apply` (approval bound to its sha256) pauses the
  pane-acting watchers, saves sessions and advisor state, `/restart`s panes on
  the target build and respawns the rest with `--resume`, verifies version and
  session, re-applies advisors, resumes the watchers and reports.
  `scripts/fleet_restart.py` also has `check-env`, `watchers`, `save`,
  `snapshot`, `align`, `plan`, `manifest`, `send` (dry-run by default),
  `approval-template`, `verify` and `handoff`; `scripts/sitrep.py` reports
  per-pane state, flags, MCP versions and last callback plus per-repo counts and
  CI.
- **fleet-round:** the lock-step fleet round protocol and a read-only
  validator for its reports. `scripts/fleet-round.ts` has `collect`,
  `snapshot`, `check`, `validate`, `spot-check`, `score` and `barrier`: it
  recomputes each director's claims from br, git, tmux and Agent Mail identity
  files, checks the round-0 pass bar, reports UNKNOWN, never PASS, for anything
  it cannot observe, and at each barrier reports per project whether its report
  arrived on time and was accepted, escalating a repeated blocker.

```sh
python3 skills/fleet-restart/scripts/selftest.py
python3 skills/fleet-restart/scripts/sitrep.py --selftest
bun skills/fleet-round/scripts/fleet-round.ts check --config fleet.json --project app --focus app-e1,app-e2,app-e3
omp-kit planning score --json
```

### Fleet operations

```sh
omp-kit send SESSION PANE "message" --json   # proves delivery; needs a bead id or --no-bead-reason
omp-kit fleet flush-pending --json           # plan: queued bands, frozen turns
omp-kit fleet respawn --json                 # plan: stale-plugin panes
omp-kit scratch plan --json                  # reap report over scratch roots
omp-kit scratch index-lock --repo DIR --json  # plan: stale index.lock verdict
omp-kit ci status --json                     # cached CI, never calls GitHub
omp-kit heavy --label cli-tests -- bun test tests/cli   # load-admitted, nice 10
```

`send` proves delivery (tmux via `ntm`; `tern:<block>` natively, given
`--window-key EP`) and drops undelivered messages into
the state root; the exit code is delivery (`OK`, `PENDING_SUBMIT`, `NOT_DELIVERED`). Fleet Watch
is an opt-in service that nudges idle workers and escalates to the coordinator;
see [docs/fleet-watch.md](docs/fleet-watch.md).

### Reviewed installed-template imports

The import gate uses host Node and global TypeScript to distinguish real imports
from inert examples. Genuine dangling imports and parser failures refuse.
Installed-layout templates require an explicit digest-bound project mapping, not
a directory exemption. Only an authorized operator activates reviewed data;
source support alone does not unfreeze historical commits.
See [commit import hooks](docs/commit-imports.md) for prerequisites, parser limits,
mapping fields, activation commands and read-only verification.

### Service jobs and kit updates

`omp-kit service` manages twelve launchd (macOS) or systemd (Linux) jobs, labeled
`com.omp-kit.<name>`: `omp-watch`, `scratch-reaper` (6 h), `scratch-pressure` (60 s),
`kit-update` (300 s), `fleet-watch` (120 s), `fleet-lessons` (6 h), `load-watch`
(60 s), `ci-poller` (60 s), `claude-save` (1 h), `fleet-flush` (60 s), and the
daemons `cc` and `loop-sentinel`.
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

A `PARTIAL` update keeps its receipt-bound `undo` command even if interruption
prevents a full postcheck. `postcheck_detail` keeps the original cause and any
current stage; no report failures means an empty list, not a successful
postcheck. Private paths and credential shapes are redacted before truncation.

OMP source cache details (fetch, verify, disable) live in [docs/omp-source-cache.md](docs/omp-source-cache.md).

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

**Plan before apply.** Guarded apply and repair commands default to a plan.
Their writes need `--apply`, and non-interactive writes also need `--yes`.
Append-only `lessons add` and `checkin` record their explicit invocation;
publishing those records additionally requires `--commit --bead ID`.

**Receipts and undo.** Each mutation is recorded as a receipt in the private
state root. `undo` restores from that receipt and refuses when a file changed
since; a failed restore is reported as `PARTIAL_UNDO`, never hidden.
Lesson records are append-only, not undo receipts. If publication fails after
a normal save, the rows and local commit remain available for convergence.

**Fail closed.** Anything the CLI cannot observe is `UNVERIFIED` or `NOT_RUN`,
never `PASS`. A fresh HOME reports `UNVERIFIED` until rules are applied; an
unreachable vault makes the secrets scan `UNVERIFIED`; a stale CI cache is
`UNAVAILABLE`. Exit codes are fixed: 0 success, 1 finding, 2 usage or blocked,
3 unavailable, 4 retryable, 77 when a check could not run (and for `heavy`: 75 when a job is deferred, 69 when
no disk observer is available — strict `sbh` missing, or OS `statfs` unreadable).

**Native OMP first.** Rule tests run through OMP's matcher, settings go through
`omp config get/set`, and rules load through OMP's plugin loader. The
[native-OMP guide](docs/native-omp.md) teaches those primitives directly.

**Never installs OMP.** omp-kit reads your OMP setup and proposes changes. It
does not install OMP, models, providers, or profiles, and it never enables
policy or extensions by implication.

## Comparison

Moved to [docs/comparison.md](docs/comparison.md).

## Installation

Requirements: an existing OMP install with `omp` on PATH (for `status` and
`test`), plus Python 3, GitHub CLI (`gh`) and `curl` for the installer (the version
one-liner uses `str.removeprefix`, so Python 3.9 or newer). `gh` must be
authenticated before you install: run `gh auth login` first (in automation,
export `GH_TOKEN` from `gh auth token`). Attestation fetch and verification use
`gh`, so a logged-out `gh` refuses as `KIT_ATTESTATION_BUNDLE_UNAVAILABLE`
(exit 2) instead of installing. Linux builds need
GNU libc. Installer and kit updates require a verifying Sigstore/SLSA bundle:
GitHub Actions issuer, `JYeswak/omp-kit-companion` release workflow and the selected
tag's authoritative source commit must match. Missing bundles, verifier or online
tag authority refuse as `KIT_ATTESTATION_*`; there is no hash-only activation.
Tool list with install and verify commands: [docs/setup.md](docs/setup.md).

### 1. Latest release installer (recommended)

```sh
KIT_VERSION=$(curl -fsSL https://api.github.com/repos/JYeswak/omp-kit-companion/releases/latest | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"].removeprefix("v"))')
if [ -z "$KIT_VERSION" ]; then
  echo "install: could not resolve the latest omp-kit release: the GitHub API request failed (unauthenticated requests are rate-limited to 60/hour)." >&2
  echo "install: run 'gh auth login' (or export GH_TOKEN) and retry, or resolve the version with: gh api repos/JYeswak/omp-kit-companion/releases/latest --jq .tag_name" >&2
  echo "install: nothing was downloaded." >&2
  exit 1
fi
KIT_INDEX="https://github.com/JYeswak/omp-kit-companion/releases/download/v${KIT_VERSION}/release-index.json"
KIT_RAW="https://raw.githubusercontent.com/JYeswak/omp-kit-companion/v${KIT_VERSION}/installer"
KIT_INSTALLER=$(mktemp -d "${TMPDIR:-/tmp}/omp-kit-installer.XXXXXXXX")
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

The online installer downloads only the archive for your platform and its bundle
from GitHub's attestation store. It checks archive SHA-256, manifest SHA-256,
every file hash, USTAR safety and provenance before writing
`PREFIX/releases/<version>/` and pointing `PREFIX/bin/omp-kit` at it. Offline
archives require an adjacent `<archive>.sigstore.json`; source-tag authority still
requires network access. The updater uses this same verifier before extraction.
It never installs OMP, Bun, models, profiles, or shell startup edits, and it refuses
plain HTTP indexes, relative prefixes, and an existing release directory whose
bytes differ. Upgrading by hand is the same commands with the new version.

### 2. Rules and extensions as an OMP plugin

```sh
omp plugin install "github:JYeswak/omp-kit-companion#v$KIT_VERSION"
omp plugin list
```

Fleet tool/save guards require the nearest repo's `.omp/fleet.json` with `{"enabled":true}`; stock repos stay unchanged. See
[docs/usage.md](docs/usage.md) for how plugin rules rank against native rules
and `~/.agents/rules` copies, and `omp-kit migrate --plan` to move legacy
copies onto plugin layering.

### 3. From source

```sh
git clone https://github.com/JYeswak/omp-kit-companion.git
cd omp-kit-companion
bun install --frozen-lockfile --ignore-scripts
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
grammar. Guarded apply operations need `--apply` and, non-interactively, `--yes`.

`lessons add` and `checkin` append to `.omp/lessons.jsonl`. Their `--commit`
mode requires a clean lesson path and shared `main`, runs normal commit/push
hooks, and never adopts another writer's staged or working lesson rows.
Check-ins without `--done` require complete native activity coverage; an
unavailable source refuses before writing. Use repeatable `--done` for an
explicit report rather than inventing zero activity.

| Command | Usage | What it does | Example |
|---|---|---|---|
| `omp-kit status` | `status` | Kit and OMP presence; runtime `effective_rules` is `NOT_RUN` (use `doctor --scope rules --json`); changes nothing | `omp-kit status --json` |
| `omp-kit lessons` | `lessons add --class CLASS --what TEXT --evidence TEXT [--kind KIND] [--project PATH] [--commit --bead ID]` | Append an evidence-backed lesson; optionally save its clean path on shared main and fast-forward publish | `omp-kit lessons add --class MISSING_EDGE --what w --evidence e` |
| `omp-kit fleet-lessons` | `fleet-lessons [--project PATH]... [--json]` | Read current lesson advice, preserved history and unresolved references without intake, classification or service effects | `omp-kit fleet-lessons --project . --json` |
| `omp-kit checkin` | `checkin [--done TEXT]... [--blocked TEXT]... [--next TEXT]... [--project PATH] [--commit --bead ID]` | Record verified own activity or explicit items; refuses unavailable automatic coverage | `omp-kit checkin --done br-123 --next 'Verify the consumer' --bead br-123 --commit --json` |
| `omp-kit test` | `test [--full] [--record] [--rules DIR --cases FILE] [--integrations] [--mcp] [--metamorphic] [--mutants] [--repeat N]` | Matcher conformance, external packs, live fixtures, per-profile integration and MCP proofs, mutation and flake checks | `omp-kit test --json` |
| `omp-kit doctor` | `doctor [--scope NAME] [--project PATH] [--profile NAME] [--staged] [--deep --yes]` | Read-only diagnosis of one scope (table below) | `omp-kit doctor --scope lsp --json` |
| `omp-kit health` | `health` | Strict monitoring status | `omp-kit health --json` |
| `omp-kit apply` | `apply rules\|policy\|extensions\|plugin\|mcp [--plan\|--apply]` | Plan or apply a kit component with a receipt | `omp-kit apply rules --plan --json` |
| `omp-kit activation` | `activation opt-out --item ITEM --reason TEXT [--by NAME]` | Record a safeguard opt-out with a reason | `omp-kit activation opt-out --item service:kit-update --reason 'no launchd' --json` |
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
| `omp-kit mission` | `mission validate\|anchor [--project PATH]` | Check `.omp/mission.toml` fields and check hashes; `anchor` compares the live-doc Mission statement with the record (`AGREE`/`DRIFT`) | `omp-kit mission anchor --json` |
| `omp-kit preflight` | `preflight commit\|claim\|in-review\|close [BEAD]` | Every finding an act faces, with fix, at once; changes nothing | `omp-kit preflight close x` |
| `omp-kit verify` | `verify BEAD --export SHA` | Non-author close: replay each box's command on the export, judge by named outcome, tick, gate, close | `omp-kit verify x` |
| `omp-kit slice-verify` | `slice-verify --overlay PATH [--test FILE...]` | Base-vs-overlay verdict on a clean export | `omp-kit slice-verify --overlay src/x.ts --test tests/x.test.ts` |
| `omp-kit drain` | `drain close-queue\|stale-claims (--db PATH \| --project DIR) [--repo DIR] [--json]` | Report landed-but-open beads and orphaned claims; reclaim only with no live holder (seat, mail in 24 h, reservation); UNKNOWN never reclaimed | `omp-kit drain stale-claims --project .` |
| `omp-kit load` | `load watch` | Write one load census sample to the state root | `omp-kit load watch --json` |
| `omp-kit heavy` | `heavy [--label LABEL] [--no-wait] [--max-runtime S] -- COMMAND [ARG ...]` | Run one load- and disk-admitted command at nice 10; exit 75 when deferred, 124 over budget, 69 when no disk observer is available | `omp-kit heavy --label cli-tests -- bun test tests/cli` |
| `omp-kit next` | `next --role worker\|director [--repo PATH] [--agent NAME]` | Read-only next action and applicable skills ([docs/next.md](docs/next.md)) | `omp-kit next --role worker --json` |
| `omp-kit rch` | `rch lease --slots N --plan -- COMMAND` | Native remote-build plan | `omp-kit rch lease --slots 2 --plan -- cargo test --locked -j 2` |
| `omp-kit converge` | `converge --repo PATH [--apply] [--push] [--no-fetch] [--ours PATH]... [--theirs PATH]...` | Report or explicitly resolve shared-main convergence; preserves peer staged/worktree state, refuses unresolved owner conflicts, and publishes only with a non-force push | `omp-kit converge --repo . --json` |
| `omp-kit land` | `land --paths PATH... --message MSG --apply --yes` | Commit reserved paths, admit via `commit-msg` and the [push check](docs/land.md), publish with no force: `PUSHED`/`REFUSED`/`UNRUN` | `omp-kit land --paths src/owned.ts --message 'fix: save reserved path [pending]' --apply --yes --json` |
| `omp-kit service` | `service list\|install\|uninstall\|status\|doctor\|logs\|run` | Manage the kit's launchd/systemd jobs; reads foreign jobs, never rewrites them | `omp-kit service list --json` |
| `omp-kit send` | `send SESSION PANE MESSAGE [--no-bead-reason TEXT] [--drop-dir PATH]` | Tags agent text; bare slash commands; refuses forgeries | `omp-kit send s %1 "status" --json` |
| `omp-kit sha` | `sha SHA [--repo PATH]...` | Resolve a commit across every fleet repo and report which repos hold it; exit 0 found, 1 absent everywhere | `omp-kit sha dd82fb4e --json` |
| `omp-kit custody` | `custody check --repo PATH [--agent NAME] [--reserve [--ttl SECONDS] [--reason TEXT]] PATH` | Answer whether one repo-relative path may be edited, from git and reservations; one PATH per call | `omp-kit custody check --repo /path/to/repo --json doc/README.md` |
| `omp-kit intake` | `intake --from joshua --text TEXT --seat SEAT [--kind rule\|work]` | Record one request, resolve the receiving seat's role, print DO or ROUTE | `omp-kit intake --from joshua --text 'fix this test' --seat chief --json` |
| `omp-kit fleet` | `fleet flush-pending [--apply --yes]` | Find idle panes with queued input and frozen turns; `--apply` submits only safe queued bands | `omp-kit fleet flush-pending --json` |
| `omp-kit fleet` | `fleet respawn [--panes SESSION:W.P,...] [--apply --yes]` | Report panes whose omp predates the latest applied relink; `--apply` respawns named idle panes with `--resume`, strictly serially; busy, frozen, dirty, holding and sessionless panes never touched | `omp-kit fleet respawn --json` |
| `omp-kit scratch` | `scratch plan\|release DIR\|apply [--apply --yes]` | Release, quarantine and delete scratch; idle 72 h goes to quarantine, quarantine expires after 7 days | `omp-kit scratch plan --json` |
| `omp-kit scratch` | `scratch index-lock --repo DIR` | Dry-run report for a stale holder-less empty .git/index.lock; `--apply` is always refused and no lock is moved | `omp-kit scratch index-lock --repo /repo --json` |
| `omp-kit tern` | `tern catalog\|doctor\|ctl\|script\|native\|api\|sdk\|coverage\|surface\|render` | [Native SDK/control integration](docs/tern-integration.md): context-bound Luau, drift, wire codecs; explicit targets | `omp-kit tern catalog --filter cx.agents` |
| `omp-kit tern-ref` | `tern-ref build\|query\|validate\|drift [--root DIR]` | Version-pinned local Tern Plugin SDK reference: crawl docs, chunk `tern.d.luau` per member, index nomic+qwen, blind-label eval, isolated serve checks, drift re-index | `omp-kit tern-ref query --query 'restyle without rebuild'` |
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
| `activation opt-out` | Record an opt-out with a reason; empty reasons are refused and nothing is written | `omp-kit activation opt-out --item service:kit-update --reason 'no launchd' --json` |
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
| `scratch plan` / `release DIR` / `apply` | Finish tasks; legacy: `--legacy-owner --reason TEXT --yes` | `omp-kit scratch release DIR --bin throwaway --now --json` |
| `examples memory-off` / `mnemopi-manual` / `model-roles` / `mcp` / `omp-watch` / `skill-set` | Versioned, unverified recipes for manual use; `omp-watch` renders the service file without installing it | `omp-kit examples omp-watch --json` |
| `planning convert` | Fenced Markdown plan to native beads: dry-run uses a fresh isolated DB; apply requires `--tracker-root DIR --actor ACTOR --yes`, always disables native auto-import/export | `omp-kit planning convert --plan PLAN.md --mission M --dry-run --db var/agent-tmp/plan-run --json` |
| `review reduce` | Minimize a public-synthetic false fire without weakening its benign context | `omp-kit review reduce --rules /abs/rules --fixture /abs/fixture.json --json` |

`planning convert --apply --tracker-root DIR --actor ACTOR --yes` writes only the
selected native tracker. `ACTOR` is the actual writer supplied explicitly for
native audit attribution, **not** verified pane identity; native policy refusals
remain failures. Every native invocation passes `--no-auto-import --no-auto-flush`:
apply never exports JSONL, commits tracker changes, or writes a foreign tracker.
An authorized export/publication is a separate owner operation. `--mission M`
scopes parent epic identity, `M:<slug>` contributions and source references; each
block must label that mission. Optional `parent: EXISTING_LOCAL_ID` on a new block
creates its parent-child link in the same native create after checking the parent
is present, nonterminal and has no open native `blocks` prerequisite. Open
parent-child rollups alone are not code prerequisites; a closed blocker is satisfied.
Without an explicit parent, new blocks use the selected mission epic.
An amendment's explicit parent must match its historical parent, never move it.
Amendments preserve existing acceptance, external refs, parents and dependencies;
reapplying the same contributions adds nothing. Dry-run materializes all items
under an isolated mission epic and retains declared live parent IDs as metadata;
it does not certify those IDs exist in an apply tracker.

### Doctor scopes

| Scope | What it reports | Example |
|---|---|---|
| `--scope kit` | Release rule inventory, manifest, and packaged planning skill; an unscoped `doctor` judges the planning skill only when you keep a copy under `~/.agents/skills/jeff-planning-enhanced`, while this scope reports a missing copy as drift | `omp-kit doctor --scope kit` |
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
| `--scope test-scope` | Runner scratch exclusions; `OMP_KIT_FLEET_WATCH_CONFIG` selects input | `omp-kit doctor --scope test-scope --json` |
| `--scope dicklesworthstone` | Installed agent tools (`ntm`, `am`, `caam`, ...) behind their latest release | `omp-kit doctor --scope dicklesworthstone` |
| `--scope beads` | Acceptance criteria kept in their dedicated field | `omp-kit doctor --scope beads --project PATH` |
| `--scope reservations` | Exclusive Agent Mail holds past the age limit | `omp-kit doctor --scope reservations --project PATH` |
| `--scope identity` | Pane identities that are missing, shared, or stale | `omp-kit doctor --scope identity --project PATH` |
| `--scope flywheel` | Fleet practice grades from git and the tracker (`BEADS_DB`) | `omp-kit doctor --scope flywheel --project PATH` |
| `--scope fleet` | Live panes and Agent Mail: `DIRECTOR_DOING_WORK`, `COMMUNICATION_PURGATORY`, frozen turns, stale steering | `omp-kit doctor --scope fleet` |
| `--scope ownership` | Records with no live or tracked owner | `omp-kit doctor --scope ownership` |
| `--scope derived` | Literal facts in config files that a probe should replace | `omp-kit doctor --scope derived --project PATH` |
| `--scope layout` | Deviations from the standard repo layout | `omp-kit doctor --scope layout --project PATH` |
| `--scope public-files` | Missing standard public files | `omp-kit doctor --scope public-files --project PATH` |
| `--scope github` | Read-only GitHub capability probes | `omp-kit doctor --scope github` |
| `--scope secrets` | Files holding an Infisical value, by file and vault name; `--staged` for the pre-commit hook | `omp-kit doctor --scope secrets --staged` |
| `--scope stale-worktree` | Worktree paths that remove lines landed in HEAD, with the blamed commit and bead | `omp-kit doctor --scope stale-worktree --project PATH` |
| `--scope plugin_release` | Linked vs latest published plugin version, per profile | `omp-kit doctor --scope plugin_release` |
| `--scope mission` | Repos building through rch and whether their gate calls the kit lease | `omp-kit doctor --scope mission` |
| `--scope hooks` | Stale hook members per fleet repo | `omp-kit doctor --scope hooks` |
| `--scope rch` | Worker gc roots and health | `omp-kit doctor --scope rch` |
| `--scope land` | Land guard identity: pane identity and reservations qualified against the publication parent | `omp-kit doctor --scope land --project PATH` |
| `--scope activation` | ON, OFF-WITH-REASON, or OFF-NO-REASON for rule packs, extensions, profile links, kit services, and hook members; OFF-NO-REASON exits nonzero | `omp-kit doctor --scope activation` |
| `--scope test-scope` | Test-only diagnostic scope used to verify scoped doctor dispatch | `omp-kit doctor --scope test-scope` |
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
| `$XDG_CONFIG_HOME/omp-kit/load.json` | `heavy` slots, maximum wait, disk observer (`sbh` strict, `statfs` OS-only, `auto` default) and optional floor percent | 2 slots, auto observer, bytes-need only |
| `config/planning-score.toml`, `<repo>/.omp/planning-score.toml` | Planning score tuning and fleet list | kit defaults |
| `<repo>/.omp/plan.toml`, `OMP_KIT_PLAN_CONFIG` | The repo's comprehensive plan: path, review dir (rounds counted from review files) | none: missions from `plan(<m>):` commits only |
| `config/lessons.toml` | fleet-lessons job | kit defaults |
| `config/beads-policy.template.yaml` | Strict `.beads/policy.yaml` template, copied by hand | n/a |
| `.omp/infra-pins.toml` | Toolchain pins for `infra` | kit copy, `--file` overrides |
| `.omp/mission.toml` | Mission record for `mission validate` | n/a |
| `.omp/kit-guard.json` | Per-repo opt-in for `kit-guard-optin` | absent: off |
| `.omp/fleet.json` | Shared fleet tool/save opt-in: `{"enabled":true}` | absent or false: off |
| `.omp/fleet-guard.json` | Branch-rule opt-out within an opted-in fleet repo | absent: branch rule on |
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
// $XDG_CONFIG_HOME/omp-kit/load.json: slots 1..64, max_wait_s in seconds,
// disk_observer "sbh"|"statfs"|"auto" (default "auto": sbh when on PATH else statfs),
// disk_floor_pct 0..50; runtime: flag > runtime_budget_s.<label> > label table
{ "slots": 2, "max_wait_s": 600, "disk_observer": "auto" }
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

Moved to [docs/troubleshooting.md](docs/troubleshooting.md).

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

Moved to [docs/faq.md](docs/faq.md).

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
