# omp-kit

**Using OMP? Here's what we learned:** a coding agent needs useful reminders at the moment it drifts, not another wall of instructions in every prompt. [oh-my-pi (`omp`)](https://github.com/can1357/oh-my-pi) is a coding agent with tools for working in your project. `omp-kit` is a versioned, local-first companion for an **existing** OMP installation: tested stream-triggered rules plus a CLI to inspect, test, and *optionally* apply them.

![Yuzu testing omp rule behavior](visual/hero.jpg)

### Why bring it to an agent session?

- **Catch familiar slips:** rules cover skipped verification, unsupported “done” claims, settings mutations, and other specific failure patterns. They are reminders or tripwires, not a general security sandbox.
- **Check before changing:** diagnose OMP and installed components; exercise whole-payload and streamed-prefix matches, then isolated live cases with a mock model.
- **Keep the keys:** preview each rule, policy, or extension change; apply only by explicit consent, with receipts for inspection and guarded undo. Profile recipes are examples, never automatic configuration.

### What we actually customized

- **An 18-rule pack, not a new OMP:** concrete fire *and* nearby quiet examples for 274 cases. Some rules remind the agent to show its evidence; tripwires interrupt specific hazardous calls. Read the [rules](rules/) and [case corpus](cases/cases.tsv) before adopting them.
- **Opt-in operator setup:** separate plans for rules, policy, and a project-loading guard extension. The [memory-off](examples/profiles/v1/memory-off.yml) and [manual, per-project Mnemopi](examples/profiles/v1/mnemopi-manual.yml) recipes are alternatives for new named profiles, not changes this kit makes to yours. [Model roles](examples/profiles/v1/model-roles.yml) and [MCP](examples/mcp/named-profile.mcp.json) are examples, not bundled accounts or servers.
- **Evidence that travels with the kit:** an installed release carries its rules, manifest, and test fixtures; `test --full` checks a disposable OMP session. `doctor` can spot drift and project overrides, but it does not claim your real profile is safe or that a configured LSP/MCP server started successfully.

### First look (installed release + OMP already on PATH)

```sh
KIT="$HOME/.local/opt/omp-kit/bin/omp-kit"
"$KIT" status --json                  # What kit and OMP are present?
"$KIT" doctor --json                  # What can be diagnosed safely?
"$KIT" test --json                    # Do the shipped rules match as intended?
"$KIT" apply rules --plan --json      # What would installing managed rules change?
```

These commands **do not apply rules or change profiles**. `--json` is output formatting, not consent to write. An inaccessible effective profile remains `UNVERIFIED`; project-local rules can shadow global ones. See [Installation](#installation) for the pinned native release, [Usage](#usage) for guarded writes, and [the hero identity receipt](visual/hero-identity-grade.json) for the independently checked image.

## Installation

Start with an existing [OMP installation](https://github.com/can1357/oh-my-pi), Python 3, `git`, and `curl`. The [omp-kit v0.1.1 release](https://github.com/JYeswak/omp-kit-companion/releases/tag/v0.1.1) is pinned below: review its index and the appropriate native archive before installing. These commands clone the tagged source for the installer; the installer fetches only the selected platform archive from the same HTTPS release:

```sh
KIT_VERSION=0.1.1
KIT_INDEX="https://github.com/JYeswak/omp-kit-companion/releases/download/v${KIT_VERSION}/release-index.json"
git clone --depth 1 --branch "v$KIT_VERSION" https://github.com/JYeswak/omp-kit-companion.git
cd omp-kit-companion
sh installer/install.sh --version "$KIT_VERSION" --index "$KIT_INDEX" \
  --prefix "$HOME/.local/opt/omp-kit" --dry-run
sh installer/install.sh --version "$KIT_VERSION" --index "$KIT_INDEX" \
  --prefix "$HOME/.local/opt/omp-kit"
```

The index and archive SHA-256 checks detect mismatch; they do **not** authenticate the publisher. The installer rejects unsupported OS/architecture/libc combinations and never installs OMP, a model, skills, hooks, profiles, or shell startup edits. It retains prior versioned releases and atomically selects the stable executable at `~/.local/opt/omp-kit/bin/omp-kit`. Add that directory to PATH yourself if desired. A source clone alone is not an installed release. For a reviewed offline install, supply an **absolute local** index path and matching `.tar` with `--offline ARCHIVE`; run `--dry-run` first.

## More checks before applying

With the same installed `KIT` and OMP on PATH:

```sh
"$KIT" test --full --json
"$KIT" doctor --scope project-loading --project "$PWD" --json
```

`test` exercises the shipped rules with OMP's matcher, including streamed prefixes. `--full` additionally runs live/mock-model scenarios using an isolated HOME and no real model credentials. Neither proves your effective profile or that a project-local rule cannot shadow an installed global rule. A missing or unsupported OMP, native dependency, or post-check is reported rather than treated as GREEN.

## Usage

Start with plans and read-only views:

```sh
"$KIT" apply rules --plan --json
"$KIT" apply policy --plan --json
"$KIT" apply extensions --plan --json
"$KIT" audit --json
"$KIT" capabilities --json
"$KIT" schema --json
"$KIT" help update
```

After reviewing the rules plan, request only that change and confirm interactively:

```sh
"$KIT" apply rules --apply
"$KIT" audit --json
```

Use the receipt ID returned by apply or audit with `"$KIT" why RUN_ID --json`; `"$KIT" undo RUN_ID --yes` requests a guarded restore only when the recorded postimage is unchanged. Rule, policy, and extension application are separate opt-ins; mutations need `--apply` and interactive confirmation or `--yes`. For agents, `--robot --json` returns a versioned JSON envelope without prompting; it does **not** authorize writes.

On a fresh HOME, the policy plan refuses until the global managed rules match the release manifest—do not bypass that preflight. An interrupted kit update is partial until rechecked; historical OMP/all receipts remain visible and no automatic OMP rollback is promised.

`omp-kit update` requires an explicit **newer** version and absolute **local** index and archive paths; it does not fetch an inferred latest release. To move an existing `v0.1.0` kit to `v0.1.1`, download `v0.1.1`'s `release-index.json` and matching platform archive from [Releases](https://github.com/JYeswak/omp-kit-companion/releases/tag/v0.1.1), verify their provenance, set `KIT_VERSION=0.1.1`, and set `KIT_INDEX_LOCAL` and `KIT_ARCHIVE` to the absolute downloaded paths. An already-current version reports `CURRENT`; that is a no-op, not proof of an upgrade. OMP updates belong to your existing OMP installation method; this kit does not invoke UCA or install a scheduler:

```sh
"$KIT" update --plan --version "$KIT_VERSION" \
  --index "$KIT_INDEX_LOCAL" --archive "$KIT_ARCHIVE" --json
"$KIT" update --apply --yes --version "$KIT_VERSION" \
  --index "$KIT_INDEX_LOCAL" --archive "$KIT_ARCHIVE" --json
```

The plan does not change either component. Applying activates only the selected kit release, then reruns the matcher and isolated live post-check against the currently selected OMP. If OMP is unsupported or changes during this check, the update remains partial with a pending recovery receipt; the kit never inherits a prior OMP version's GREEN result.

## Configuration and examples

```sh
"$KIT" examples memory-off --json
"$KIT" examples mnemopi-manual --json
"$KIT" examples model-roles --json
"$KIT" examples mcp --json
"$KIT" doctor --scope memory --json
"$KIT" doctor --scope lsp --json
"$KIT" lsp setup --plan --json
"$KIT" doctor --scope project-loading --project "$PWD" --json
```

These versioned recipes **render only**. Copy one manually into a **new**, operator-owned named profile after confirming the name does not collide; never merge into an existing or default profile. The memory-off recipe disables memory. The separate Mnemopi recipe disables automatic retain/recall and chooses per-project storage, but manual retain can still store private text; activation and effective runtime state remain unverified until safely observed. Model-role choices have no personal IDs, backend fallbacks, subscription assumptions, or automatic login. The MCP recipe only describes connecting an existing local server; it neither installs a server nor supplies credentials. LSP setup inventories the local route without starting servers. The project-loading preflight inventories startup inputs before opening OMP in that checkout; it cannot prove an extension harmless. `doctor --scope memory` reports configured readiness, not proof that private memory is free of secrets. Deep LSP probing and private-memory-store auditing are not certified installed workflows.

## Development and tests

In the source checkout, edit `rules/*.md` alongside fire and nearby quiet cases in `cases/cases.tsv`. Run `sh scripts/build-manifest.sh --check` and `sh scripts/ladder.sh`; the latter exercises the case gate and isolated live suite and writes local `reports/`, which must never ship. See [CONTRIBUTING.md](CONTRIBUTING.md) for the change workflow and [SKILL.md](SKILL.md) for the source-only operator reference. The installed CLI embeds Bun, but a separately installed OMP launcher with a Bun shebang may still require Bun for its own live process. Source development also needs Bun. Native release support is limited to the platforms certified against stock OMP 18.4.2; other OMP versions are not certified.

## Limits and safety

The case gate proves registration, whole-payload matches, and prefix behavior; only the isolated live suite checks blocking. OMP profile inspection can migrate settings, so read-only diagnostics do not call a potentially migratory path on the operator profile and label inaccessible effective settings `UNVERIFIED`. Project-local rules may override installed global rules. No CLI command installs OMP or enables policy, extensions, providers, or a model by implication. The source pack does not authenticate cited SHAs, counts, or audit rows; run acceptance commands yourself.

This public source root has no inherited history from the original private checkout; the original repository stays private. Only native-certified archive targets appear in the versioned release index; check the [tagged release assets](https://github.com/JYeswak/omp-kit-companion/releases/tag/v0.1.1) and exact [hero grade](visual/hero-identity-grade.json), which discloses that the original gpt-4o-mini model could not run and names the independent substitute judge. No kit command proves your effective OMP profile safe. Never publish `reports/`, private receipts, tracker exports, or session logs. Refuted hypotheses and conditions for revisiting them are in [NEGATIVE_EVIDENCE.md](NEGATIVE_EVIDENCE.md).

Bug reports and proposals: [CONTRIBUTING.md](CONTRIBUTING.md). Sensitive reports: [SECURITY.md](SECURITY.md).

## Who built this

Maintained by [JYeswak](https://github.com/JYeswak).

## License

MIT. See [LICENSE](LICENSE).
