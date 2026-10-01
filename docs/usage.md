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

```sh verified rc=0 contains="test --record"
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
export PATH="$(dirname "$KIT"):$PATH" && omp-kit examples omp-watch --json
```

It watches OMP's `package.json`, re-runs `test --record` on change, and
notifies only on failure. Rendering installs nothing.

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
manifest, `rules/` is discovered automatically, and
`extensions/kit-guard-optin.ts` is the declared extension entry point.
Link a checkout instead of copying rules by hand:

```sh verified rc=0 contains="omp-kit-companion"
omp plugin link "$WT" && omp plugin list
```

```sh verified rc=0 contains="omp-plugins"
omp ttsr list --json
```

Native `~/.omp/agent/rules` shadows a same-name plugin rule;
`omp plugin disable` reactivates a same-name legacy copy under
`~/.agents/rules`. `scripts/plugin-lifecycle.sh` proves the precedence
matrix, one live block, the disabled-plugin negative, and clean
uninstall in an isolated HOME. `apply rules`/`apply extensions` stay
until the cutover is independently verified.
