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
