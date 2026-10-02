# omp-kit
## Overview

Test OMP rules, preview every change, apply with receipts.

## Installation

```sh
KIT_VERSION=0.2.1
KIT_INDEX="https://github.com/JYeswak/omp-kit-companion/releases/download/v${KIT_VERSION}/release-index.json"
git clone --depth 1 --branch "v$KIT_VERSION" https://github.com/JYeswak/omp-kit-companion.git
cd omp-kit-companion
sh installer/install.sh --version "$KIT_VERSION" --index "$KIT_INDEX" --prefix "$HOME/.local/opt/omp-kit" --dry-run
sh installer/install.sh --version "$KIT_VERSION" --index "$KIT_INDEX" --prefix "$HOME/.local/opt/omp-kit"
```

Needs an existing OMP install plus Python 3, git, and curl. The installer
fetches only the selected platform archive, checks its hash, and never
installs OMP, models, profiles, or shell edits. `v0.2.1` is the latest
published release. To upgrade from any earlier version, set `KIT_VERSION` to
the destination release and run the installer commands above. In particular,
binaries from `v0.2.0` and `v0.2.1` embed fixed test counts; their
`update --apply` postcheck judges the target using the running binary's counts
and refuses a release that changes shipped case counts. From `v0.1.x`,
reinstall with the commands above because those binaries cannot finish
`update --apply` on a real HOME. If an earlier attempt left a pending update,
`omp-kit undo RECEIPT --yes` (receipt from `omp-kit audit`) restores the
previous release and clears it.

The rules themselves can also come straight through OMP's plugin loader:
`omp plugin install github:JYeswak/omp-kit-companion#v0.2.1`. See
[docs/usage.md](docs/usage.md) for how plugin rules rank against native and
`~/.agents/rules` copies. An automated move off existing copies is still to come.

![Yuzu testing omp rule behavior](visual/hero.jpg)

## Quick start

With OMP on PATH and the installed binary above:

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

`status` reports what is present, `test` proves the 18 shipped rules
match as intended, and the plan previews the rule install. Nothing here
writes: `--json` formats output, and only `--apply` with confirmation
changes anything. On a fresh HOME the overall result stays `UNVERIFIED`
until rules are applied; that split is deliberate.
## What it is

- A tested rule pack: 18 stream-triggered rules with fire and near-miss
  cases that catch skipped verification, unsupported "done" claims, and
  settings mutations.
- A CLI to inspect, test, and optionally apply those rules, with receipts
  and guarded undo for every change.
- Native OMP where it fits: `ttsr list/test/scan`, plugins, and config
  reads come first. The [native-OMP guide](docs/native-omp.md) teaches
  them with runnable examples.
- `doctor --scope settings` reports per-key TTSR status through native OMP `config get`.
  An optional JSON array at `$XDG_CONFIG_HOME/omp-kit/ttsr-profiles.json` (default
  `$HOME/.config/omp-kit/ttsr-profiles.json`) selects profiles; an unsafe or
  invalid list fails closed. `apply policy` previews native commands, backs up
  changed configs, and reads each changed key back.

## What it is not

- Not an OMP installer, model provider, or profile manager. It reads your
  setup and proposes changes; you approve each one.
- Not a sandbox or a safety certificate. Passing rules prove the tested
  pack on the tested OMP, not your effective profile.
- Not a daemon. Nothing runs unless you invoke it, except the optional
  watcher you install yourself ([usage](docs/usage.md)).

## Limitations

The case gate proves registration, whole-payload matches, and prefix
behavior; only the isolated live suite checks blocking. Project-local
rules can shadow installed global rules. The CLI never enables policy,
extensions, providers, or a model by implication. Detailed usage, update,
and configuration live in [docs/usage.md](docs/usage.md); what did not
work and why lives in [NEGATIVE_EVIDENCE.md](NEGATIVE_EVIDENCE.md). Stored TTSR values do not prove that a running OMP session loaded or enforced the policy.

Bug reports: [CONTRIBUTING.md](CONTRIBUTING.md). Sensitive reports:
[SECURITY.md](SECURITY.md). Source checkout work: [AGENTS.md](AGENTS.md).
What is done, in review and next: [ROADMAP.md](ROADMAP.md).

## About Contributions

Bug reports and focused proposals are welcome through GitHub issues. A pull request is a proposal, not an automatic merge commitment; the maintainer may independently implement a change after review. Do not post session logs, local absolute paths, credentials, or private model transcripts. Use `CONTRIBUTING.md` for the workflow and `SECURITY.md` for sensitive reports.

Maintained by [JYeswak](https://github.com/JYeswak).

## License

MIT. See [LICENSE](LICENSE).

<!-- verified-ttsr-docs:start -->
Minimum supported OMP: 18.4.2.
Last verified against OMP 18.4.9 on 2026-10-01 by `bun test
tests/cli/docs.test.ts`. Refresh with `sh scripts/docs-footer.sh`; the
scheduled compatibility workflow re-runs the same check against the
latest OMP every 3 hours.
<!-- verified-ttsr-docs:end -->
