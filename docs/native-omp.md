# Native OMP first

Before reaching for kit rules, use what OMP already ships. Every command below
was run against the OMP on PATH in a disposable HOME; the docs check
(`bun test tests/cli/docs.test.ts`) re-runs each fenced block and compares the
exit code and the quoted output fragment. Rule-file examples assume the
source checkout as the working directory; with an installed release, point
`--rule` at `<prefix>/releases/<version>/rules/` instead.

## Record your runtime

```sh verified rc=0 contains="omp/"
omp --version
```

Write down the version before comparing notes with anyone. Behavior below is
what the check observed; a newer OMP that changes it fails the check on
purpose so the guide gets refreshed, not silently trusted.

## List what is installed

```sh verified rc=0 contains="TTSR rules"
omp ttsr list
```

A fresh HOME shows the 27 `builtin-defaults` rules (Go, Rust, TypeScript).
Yours also lists project and plugin rules with their source. Counts differ
per machine; the check only asserts the listing works.

## Test one snippet

Fire, using the kit's own pipe-exit rule as the worked example:

```sh verified rc=0 contains="Triggered (1)"
omp ttsr test --rule rules/bash-pipe-exit.md --source tool --tool bash 'deploy.sh | head -1; echo $?'
```

`--rule` tests a single file in isolation and skips project rule loading.
`--source` is `text`, `thinking`, or `tool`; with `tool` add `--tool` (here
`bash`) and, when scope depends on the file type, `--path`.

A near-miss that stays quiet, with `--verbose` showing the evaluation:

```sh verified rc=0 contains='"triggered":[]'
omp ttsr test --rule rules/bash-pipe-exit.md --source tool --tool bash 'deploy.sh > out.txt' --json --verbose
```

(The human-readable form of an isolated quiet probe exits 1 on the observed
OMP; the `--json` form exits 0 with `"triggered":[]`. The check uses the
JSON form so scripts can branch on the exit code.)

## Scan a project

Scanning reads committed files; set up a scratch project first:

```sh verified rc=0 contains="matches across 1 files"
rm -rf "$HOME/scanproj" && mkdir -p "$HOME/scanproj" && cd "$HOME/scanproj" && git init -q && printf 'const x: any = 1\n' > a.ts && printf 'hello\n' > b.txt && git add a.ts b.txt && git -c user.email=docs@example -c user.name=docs commit -qm fixture && omp ttsr scan "$HOME/scanproj"
```

`rc=0` with matches and `rc=0` with none are both normal; an empty scan is
not coverage proof. (`--verbose` currently finds no files when combined
with scan on the observed OMP, so it is not used here.)

## Ship rules as a plugin

```sh verified rc=0 contains="No plugins installed"
omp plugin list
```

```sh verified rc=0 contains="plugins_directory"
omp plugin doctor --json
```

Doctor reports directory health, not hook parity. A fresh HOME warns about
the missing plugin directory; that warning is setup state, not breakage.
`omp plugin --help` lists the rest (`install`, `uninstall`, `link`,
`features`, `config`, `enable`, `disable`, `marketplace`, `discover`,
`upgrade`, `--scope user|project`):

```sh verified rc=0 contains="doctor"
omp plugin --help
```

Link a local package and watch its rules go live. Any npm package with an
`omp` field qualifies; its `rules/` directory is discovered automatically:

```sh verified rc=0 contains="docs-demo-rules"
rm -rf "$HOME/demorules" && mkdir -p "$HOME/demorules/rules" && printf '{\n  "name": "docs-demo-rules",\n  "version": "0.0.1",\n  "omp": {\n    "rules": ["rules/"]\n  }\n}\n' > "$HOME/demorules/package.json" && printf -- '---\ncondition: DEMO_CANARY_FIRE\nscope: tool:bash\ninterruptMode: never\n---\nDemo-only rule for the native-OMP guide.\n' > "$HOME/demorules/rules/demo-canary.md" && omp plugin link "$HOME/demorules" && omp plugin list
```

The linked rule fires through the normal matcher, labeled with its source:

```sh verified rc=0 contains="demo-canary"
omp ttsr test --source tool --tool bash 'echo DEMO_CANARY_FIRE' --json
```

Look for `"sourceProvider": "omp-plugins"` in the full output. Native
`~/.omp/agent/rules` shadows a same-name plugin rule, and disabling a
plugin reactivates a same-name legacy copy under `~/.agents/rules`; when a
rule surprises you, `ttsr list` shows which source won.

## Read settings without changing them

```sh verified rc=0 contains="ttsr.enabled"
omp config list --json
```

```sh verified rc=0 contains='"key": "ttsr.enabled"'
omp config get ttsr.enabled --json
```

`list` shows every key with its type; `get` reads one. The `ttsr.*` family
(`enabled`, `contextMode`, `interruptMode`, `builtinRules`,
`disabledRules`, `judge`, `repeatMode`, `repeatGap`) is where stream-rule
behavior lives. This guide stays read-only: `set` and `reset` exist and
change your profile, so they get no example here. An unknown key refuses:

```sh verified rc=1 contains_err="Unknown setting"
omp config get ttsr.mode --json
```

For a named profile, prefix the same reads: `omp --profile NAME config
list`. The kit's profile recipes (`omp-kit examples memory-off`, rendered
below) are text to copy by hand into a new profile, never automatic
configuration.

## Where the kit takes over

Stop at native tooling when `ttsr list/test/scan` answers the question.
The kit adds three things OMP does not ship: a tested rule pack with
whole-payload and streamed-prefix proof, guarded application with
receipts, and isolated live checks. Each renders nothing but JSON until
you confirm a change:

```sh verified rc=0 contains='"ok":true'
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
"$KIT" status --json
```

```sh verified rc=0 contains='"status":"PASS"'
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
"$KIT" test --json
```

```sh verified rc=0 contains='"action":"PLAN"'
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
"$KIT" apply rules --plan --json
```

```sh verified rc=0 contains='"component":"policy"'
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
"$KIT" doctor --scope settings --json
```

`doctor --scope settings --json` reads each selected profile with OMP native `config get` and reports each key as `OK`, `DRIFT`, or `UNVERIFIED`. These are stored settings; they do not prove rule activation.

`$XDG_CONFIG_HOME/omp-kit/ttsr-profiles.json` is an optional JSON array of profile names, for example `["work"]`. When XDG_CONFIG_HOME is unset, the kit reads `$HOME/.config/omp-kit/ttsr-profiles.json`.

When the file is absent, diagnosis reads all profiles. Default policy plans select all named profiles, or the default when none exist. `--profiles` overrides the file; `--include-default` adds the default. Invalid or unsafe files make diagnosis UNVERIFIED and default policy planning refuses; neither falls back to all profiles.

`apply policy --plan` emits native per-profile `config set` commands only when the global managed-rule inventory matches the release manifest. A fresh HOME must apply the managed rules first. `--apply --yes` backs up each changed profile config before the first write, changes only allowlisted `ttsr.*` keys, then verifies each changed key with native readback. Model/provider routing is outside this policy.
`$KIT` is the installed release binary. On a fresh HOME, `test` passes
the shipped pack while the overall result stays `UNVERIFIED` until rules
are applied; that split is the point. Render a profile recipe the same
way and copy it by hand:

```sh verified rc=0 contains="profile recipe"
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
"$KIT" examples memory-off --json
```

Full usage, update, and configuration detail lives in
[usage.md](usage.md). The 60-second stranger path is in the
[README](../README.md).

## Limits

These examples prove the fenced commands on the OMP they ran against in
CI, not on every profile or version. Inventory counts, warning text, and
rule catalogs move with OMP releases; the check pins behavior (exit codes
and fragments), not catalogs. Anything interactive (`/extensions`, TTY
hooks) is out of scope for the check. Foreign hook manifests
(`settings.json`, `hooks.json`) are declarations, never handlers; only an
isolated run showing the effect counts as firing proof.

<!-- verified-ttsr-docs:start -->
Minimum supported OMP: 18.4.2.
Last verified against OMP 18.4.9 on 2026-10-01 by `bun test
tests/cli/docs.test.ts`. Refresh with `sh scripts/docs-footer.sh`; the
scheduled compatibility workflow re-runs the same check against the
latest OMP every 3 hours.
<!-- verified-ttsr-docs:end -->
