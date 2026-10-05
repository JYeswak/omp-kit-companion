# Usage

`$KIT` below is your installed release binary
(`$HOME/.local/opt/omp-kit/bin/omp-kit` after a default install). Every
fenced command is re-run by `bun test tests/cli/docs.test.ts`; unfenced
commands need local files or confirmation and are not checked.

## Look before changing

```sh verified rc=0 contains='"receipts":[]'
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
"$KIT" audit --json
```

```sh verified rc=0 contains='"installed_rules"'
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
"$KIT" doctor --json
```

```sh verified rc=0 contains='"commands"'
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
"$KIT" capabilities --json
```

`audit` lists receipts, `doctor` diagnoses safely, `capabilities` prints
the exact command grammar (the same registry that drives `--help`).

## Apply one thing at a time

Rules, policy, and the project-loading guard are separate opt-ins. Preview
each plan, then request only that change with confirmation:

```sh verified rc=0 contains='"action":"PLAN"'
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
"$KIT" apply extensions --plan --json
```

`"$KIT" apply rules --plan --json` previews the 18-rule install (see the
README try). `apply policy --plan` needs a profile selection and refuses
without one. Applying needs `--apply` plus interactive confirmation or
`--yes`; `--robot --json` returns the envelope without prompting but never
authorizes a write. `undo RUN_ID --yes` restores one verified receipt;
`why RUN_ID` explains it.

Legacy `~/.agents/rules` copies from before the plugin route move with
`migrate --plan`: each file is listed with its plugin equivalent and byte
diff. Copies identical to the installed plugin are removed on
`migrate --apply --yes` (backed up first, verified through `ttsr list`,
undoable); edited copies stay in place flagged for overlay, unknown files
are never touched. Without an installed plugin, apply refuses. Edited rows
carry the unified diff and the proposed native destination
(`.omp/agent/rules/<name>.md`, which outranks the plugin); rules nothing
serves are flagged unlisted.

## Bring MCP servers over from other harnesses

List the MCP servers configured for Claude, Cursor, Codex or the project
`.mcp.json`, and which OMP profiles (enumerated at run time, default
included) already have each. Env and header values are shown as names
only; nothing is started or written:

```sh verified rc=0 contains='"mcp_sources"'
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
"$KIT" doctor --scope mcp --sources --json
```

Import with `apply mcp`. On a terminal, omitting `--servers` and
`--profiles` walks you through source, servers and profiles, shows the
per-profile diff and asks once. Without a terminal the selection must be
explicit, and the command refuses naming the flags:

```sh verified rc=2 contains_err='MCP_SELECTION_REQUIRED'
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
"$KIT" apply mcp --from claude
```

A worked example, importing three math servers into every profile:

    "$KIT" apply mcp --from claude --servers mathlas,z3-prover,wolfram-alpha \
      --profiles all --startup-timeout-ms mathlas=180000 --plan
    "$KIT" apply mcp --from claude --servers mathlas,z3-prover,wolfram-alpha \
      --profiles all --startup-timeout-ms mathlas=180000 --apply --yes
    "$KIT" test --mcp --profiles all --servers mathlas,z3-prover,wolfram-alpha \
      --call 'z3-prover:list_variables:{}' --expect 'z3-prover:.' \
      --call 'wolfram-alpha:wolfram_llm:{"query":"integrate x^2 from 0 to 3"}' \
      --expect 'wolfram-alpha:\b9\b' \
      --call 'mathlas:verify_numeric:{"value":"1.6449340668482264","closed_form":"pi**2/6"}' \
      --expect 'mathlas:"verified": ?true'
    "$KIT" undo RUN_ID --yes

What gets written: OMP's own `mcp.json` schema, validated against the
installed OMP `src/config/mcp-schema.json` before any write. OMP's native
`/mcp add` cannot carry env, cwd or timeout, so the kit writes the file
itself, inserting new entries without moving a byte of the existing ones,
with one receipt for every touched profile (`undo` restores them
byte-for-byte). A server name already present is never overwritten; a
differing one is reported as a conflict.

- Env values become references: `"KEY": "KEY"` (or the variable named by a
  `${VAR}` source value). OMP resolves an env value that names a set
  variable; when the variable is unset it passes the name itself through,
  so the plan marks those `UNSET NOW`. `--env-literal NAMES` copies chosen
  non-secret values verbatim after a secret scan.
- A likely literal credential anywhere in the rendered entry (args, URL,
  headers, a literal env value) refuses the whole plan.
- `--startup-timeout-ms N|NAME=N` writes OMP's per-server `timeout`, which
  bounds the connect handshake as well as every request (OMP's default is
  30000 ms; a cold `uvx` start that downloads torch needs more).
- `--override NAME=ABS_JSON` replaces one source entry with a corrected
  server entry, without editing the source config; the override path and
  hash go into the receipt.

Edit mode changes servers already in the profiles, reading no source, with
the same plan, receipt and `undo`. Only the named bytes change:

- `--env-command SERVER:KEY='!CMD'` (repeatable) rewrites one env value of
  an existing entry to an OMP command value. OMP runs a value starting with
  `!` through `/bin/sh` in the session cwd and caches its stdout, so a
  secret can stay in a store such as the macOS keychain and no file holds
  it. The command text is secret-scanned; a value without `!` is refused.
- `--enable NAMES` removes servers from a profile's `disabledServers` list.

For example, reading the Wolfram key from the login keychain in every
profile and re-enabling sympy-mcp in one:

    security add-generic-password -s WOLFRAM_APP_ID -a "$USER" -w   # prompts
    "$KIT" apply mcp --profiles all \
      --env-command 'wolfram-alpha:WOLFRAM_APP_ID=!security find-generic-password -s WOLFRAM_APP_ID -w' --plan
    "$KIT" apply mcp --profiles claude --enable sympy-mcp --apply --yes

`test --mcp` starts a fresh `omp --mode rpc` per profile against a private
mirror of that profile's agent config (OMP needs a model to make a call,
and `--profile` would need the mock model written into the real profile).
Before the session it checks each selected server's env: an upper-case
env-name reference that is unset in the environment OMP runs with and in
the dotenv files OMP loads (`~/.env`, `~/.omp/.env`, the profile's
`agent/.env`) is `ENV_UNSET`; a `!command` that fails or prints nothing
is `COMMAND_FAILED` (its output is never shown). OMP connects the servers
with its own strict stdio client, from a decoy cwd; `/mcp test` reports
each server's tools; a scripted mock model makes each `--call` through
OMP's tool bridge. A call is `CALLABLE` only when its text has no
error shape (`AUTH_ERROR`, `HTTP 4xx/5xx`, `Unauthorized`, `Forbidden`)
and matches its `--expect SERVER:REGEX`; error text is `CALL_FAILED` even
when the server set `isError` false, and an answer with no `--expect` is
`UNVERIFIED_RESULT`. Other states: `ZERO_TOOLS`, `START_TIMEOUT`,
`START_FAILED`, `NOT_CALLED` (tools listed, no `--call`) and
`NOT_CONFIGURED`. Anything but `CALLABLE` exits 1. A receipt lands under
the state root in `mcp-tests/`. `CALLABLE` means the server answered one
call through OMP and the answer matched the pattern, not that it is right.

## Keep up with OMP

Updaters install new OMP versions unattended. Record a passing test so
later runs can tell drift from breakage:

```sh verified rc=0 contains='"recorded":true'
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
"$KIT" test --record --json
```

```sh verified rc=0 contains="omp_drift"
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
"$KIT" status --json
```

`status` then reports an `omp_drift` finding: OK on the recorded OMP,
DEGRADED once OMP changes or the last recorded test failed. Plain `test`
stays read-only and records nothing. For hands-off re-testing, render the
watcher and install it yourself:

```sh verified rc=0 contains="dry_run"
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
mkdir -p "$HOME/.local/bin" && cp "$KIT" "$HOME/.local/bin/omp-kit" && chmod +x "$HOME/.local/bin/omp-kit"
"$KIT" service install omp-watch --dry-run --json
```

It watches OMP's `package.json` and re-runs `test --record` on change,
notifying on failure exactly as the retired example did. The dry run
renders the plist, the diff and the install plan without changing
anything; add `--apply --yes` to install it for real. Install refuses a
label already loaded from a different plist unless `--replace` is given.

## Scratch lifecycle

`omp-kit scratch plan` previews recognized scratch roots and sessions without
changing them. `omp-kit scratch apply --apply` reaps eligible dead-owner
directories, quarantines unowned scratch idle for 72 hours or owner-released
scratch, expires quarantine after seven days, and stops identified abandoned
harness-server processes. A task owner can run `omp-kit scratch release DIR`
from the owner process or one of its descendants to attest that a direct
child of a scratch root is finished. The release does not immediately move
the directory; the next scratch-reaper run quarantines it only when no open
file descriptors remain. Released quarantine is retained for seven days,
then expires. Unreleased live sessions stay in place. Existing four-field
`.owner` markers from the fleet guard are recognized conservatively: a
currently live PID is kept because that format has no process-start identity.

Preview the service schedule with
`omp-kit service install scratch-reaper --dry-run`; on macOS this manages a
per-user LaunchAgent and on Linux systemd units. Install or update it with
`omp-kit service install scratch-reaper --apply --yes`. The LaunchAgent runs
at load and every six hours; the systemd timer starts at boot and repeats
every six hours.
`omp-kit service run scratch-reaper` applies those actions and records the run
receipt. Directory cleanup is limited to recognized scratch roots, not
unrelated cache directories; eligible abandoned harness-server processes are
also stopped.

## Update the kit, not OMP

`update` needs an explicit newer version with absolute local index and
archive paths; it never fetches an inferred latest:

```sh
"$KIT" update --plan --version "$KIT_VERSION" \
  --index "$KIT_INDEX_LOCAL" --archive "$KIT_ARCHIVE" --json
```

Applying activates only the selected kit release, then reruns the matcher
and live post-checks against the current OMP. OMP updates belong to your
existing OMP install method. A v0.1.x kit cannot self-update on a real
HOME; reinstall with the installer instead.

## For rule authors

Selected-pack testing, paired rule review, and false-fire reduction use
the existing OMP matcher and the seven-column TSV format in
`cases/cases.tsv`. Start from the built-in help in each command; the
native-OMP guide shows the matcher primitives they rest on.

## Rules as a native OMP plugin

The repo itself is an OMP plugin: `package.json` carries the `omp`
manifest, `rules/` is discovered automatically, and the declared extension
entry points are `extensions/kit-guard-optin.ts` and
`extensions/kit-save-guard.ts` (session-end save guard: one read-only
warning line for unsaved repo work at shutdown).
Link a checkout instead of copying rules by hand:

```sh verified rc=0 contains="omp-kit-companion"
omp plugin link "$WT" && omp plugin list
```

### Profile-wide package rollout

Run `KIT_SOURCE/src/cli.ts` from the checkout containing this implementation;
use the installed package release root as `--store`. It must contain
`package.json`, `rules/`, and `extensions/` (not a nested `plugin/` directory).
Capture the complete runtime budget output, including its `JSON_REPORT=` line,
even when the script exits nonzero:

```sh
KIT_SOURCE=/absolute/omp-kit-companion
KIT_RELEASE=/absolute/kit-release-root
REPORT=/absolute/regex-budget.out
if bun "$KIT_SOURCE/scripts/regex-budget.ts" > "$REPORT" 2>&1; then budget_rc=0; else budget_rc=$?; fi
printf 'regex_budget_exit=%s\n' "$budget_rc"

bun "$KIT_SOURCE/src/cli.ts" apply plugin --plan --store "$KIT_RELEASE" \
  --regex-budget-report "$REPORT" --profiles all --include-default --json
bun "$KIT_SOURCE/src/cli.ts" apply plugin --apply --yes --store "$KIT_RELEASE" \
  --regex-budget-report "$REPORT" --profiles all --include-default --json
```

The receipt binds the selected RX2 exclusions to the report hash and stores a
private copy of the report. Exclusions are added only to named profiles, unioned
with their existing `ttsr.disabledRules`; the default profile's policy is never changed.

The report records host load averages; stream timings are raw and are not
load-normalized.

Run `bun "$KIT_SOURCE/src/cli.ts" undo RECEIPT_ID --yes` to restore each
verified profile's previous plugin package, lock file, and named-profile policy.
Undo refuses if a postimage changed.


```sh verified rc=0 contains="omp-plugins"
omp ttsr list --json
```

Observed with OMP/18.5.1 and `omp-kit-companion@0.2.3` in an isolated
HOME, with `ttsr test` run from that HOME. It reports the winning
`triggered[].sourceProvider`:

| Isolated HOME state | Observed `sourceProvider` |
| --- | --- |
| Plugin enabled; no same-name copies | `omp-plugins` |
| Plugin enabled; same-name legacy copy under `~/.agents/rules` | `omp-plugins` |
| Plugin enabled; legacy copy plus same-name `~/.omp/agent/rules` overlay | `native` |
| Plugin disabled; native overlay still present | `native` |
| Plugin disabled; overlay moved away, legacy copy remains | `agents` |

The earlier `omp-plugins` result for the final row came from running `ttsr test`
with the repository as its working directory: it resolved
`~/.omp/plugins/node_modules/omp-kit-companion/rules/bash-pipe-exit.md`
despite the isolated HOME's disabled plugin state. Running from the isolated
HOME reports the legacy provider as expected. `scripts/plugin-lifecycle.sh`
also runs its steps from the isolated HOME and exercises these precedence
rows, the live block, disabled-plugin fallback, and uninstall.
`apply rules`/`apply extensions` stay until the cutover is independently
verified.

## Measure prompt listing cost

`doctor --scope context` reports what a profile lists into the prompt,
measured with OMP's own loaders: listed skills (name plus description,
honouring `hide`), context files, rules, and tool counts with the native
knobs in effect. Inline descriptor bytes stay UNVERIFIED without a live
session. Nothing is written to the inspected HOME:

```sh verified rc=0 contains='"component":"context"'
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
"$KIT" doctor --scope context --json
```

Add `--profile NAME` for a named profile, `--project PATH` to select the
session cwd. After pruning with OMP's native skill knobs, check that the
capabilities you need still resolve:

```sh verified rc=0 contains='"overall":"PASS"'
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
printf '{"schema_version":1,"tools":["bash"]}' > "$HOME/caps.json"
"$KIT" test --capabilities "$HOME/caps.json" --json
```

The file declares `skills`, `tools`, `rules`, and `lsp` arrays
(`schema_version` 1). Each entry resolves to `RESOLVED`,
`HIDDEN_BUT_READABLE`, or `MISSING`; any `MISSING` exits 1. A smaller
listing that resolves every declared capability does not prove equal
task success; that comparison belongs to dedicated benchmark tooling.


## Monitor macOS services

`doctor --scope services` inventories launchd jobs without loading,
unloading, or writing anything: one row per installed plist plus every
loaded non-Apple job with no plist. Classes are `RUNNING`, `IDLE_OK`,
`FAILING`, `NOT_LOADED`, `BROKEN`, `LOADED_NO_PLIST`, and `UNVERIFIED`
(system-domain state without elevated privileges). Duplicate detection
keys on the script a wrapper actually runs, so two jobs sharing one
script are reported together even when both go through `/bin/sh`.
Only OMP-related jobs (the omp token as a standalone path/label
segment, plus `oh-my-pi`, `uca`, `localbench`, `sbh`, `omp-kit`,
`kit-guard`) can turn the verdict; everything else is listed for
context but never flagged.

```
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
"$KIT" doctor --scope services --json
```

Add `--services FILE` to validate a declared file of required jobs:

```json
{"schema_version": 1, "jobs": [
  {"label": "com.omp-kit.omp-watch", "name": "omp-watch"},
  {"label": "dev.localbench.omp-update", "name": "localbench omp-update",
   "healthy_exit": [0, 1], "log_file": "~/.localbench/omp-watch/refresh.log",
   "require_log_line_if_exit_1": "STALE"}
]}
```

A job's exit code is not universally failure: `localbench omp-update`
exits 1 when STALE work is queued, by design, and its refresh log then
carries a `STALE` line. `healthy_exit` lists the acceptable codes and
`require_log_line_if_exit_N` demands a line in the log (absolute or
`~/` path, last megabyte) when the job exits N. Missing jobs report
`MISSING`; an unreadable declared file refuses with
`INVALID_SERVICES_FILE`.

## Derive a skill set from usage

`examples skill-set` reads a profile's session transcripts (read-only)
and lists every skill actually read plus the skills named explicitly in
prompts. Usage is grouped by session working directory, and each
project's set is resolved through that project's own loader: the global
recipe holds only user-scope skills, while project-scoped skills appear
under per-project recipes (`project_recipes`, one entry per session
directory). Skills used in a directory that resolves nowhere are listed
under `unresolved_projects` and belong to no recipe. It renders, never
applies, a pruned-profile recipe: the candidate `includeSkills` list
with listing bytes before and after (both measured through OMP's
loader), and the capability check result:

```sh verified rc=0 contains='"candidate_skills":[]'
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
"$KIT" examples skill-set --from-history 7 --json
```

Add `--profile NAME` to measure another profile. Copy the recipe into a
NEW named profile by hand, then benchmark real tasks (localbench
Experiment C) before adopting the pruned set: passing the check does
not prove equal task success.

## Measure rule fire rates on your own sessions

`corpus --sessions ABS_DIR` replays local OMP session transcripts through
the kit's own matcher and reports per-rule fire counts with Wilson 95%
intervals. Rules with zero fires show the rule-of-three upper bound
instead of a bare zero. Nothing is uploaded and command text stays out
of the JSON; add `--out ABS_FILE` to keep the report. `corpus --plan`
prints the session schema fields read before reading anything, and an
unknown schema version refuses with no partial counts. A fire rate is
not precision: precision needs human labels.
