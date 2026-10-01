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

The installed fast test consumes structured native-harness results and rejects malformed or contradictory evidence. Matcher subprocesses receive isolated HOME/XDG/temp paths before Bun starts; invoking the source harness directly does not provide the same caller-cache guarantee. A successful isolated plan must come from the matching shell tool result, not from the model claiming it succeeded.

**The selected-pack, review, and reduction features below require an unreleased build; the v0.1.1 assets linked above do not include them.** Selected-pack testing and paired rule review use the existing OMP matcher and the seven-column TSV format in [cases/cases.tsv](cases/cases.tsv), not project scripts or a second matcher:

```sh
"$KIT" test --rules /absolute/pack/rules --cases /absolute/pack/cases.tsv --json
"$KIT" review rules \
  --incumbent-rules /absolute/old/rules --incumbent-cases /absolute/old/cases.tsv \
  --candidate-rules /absolute/new/rules --candidate-cases /absolute/new/cases.tsv --json
```

External `test` reports the selected rule/case identities and G1–G3 results. Each selected rule needs authored fire and quiet cases. It rejects `--full` and `--project` in external mode; bundled `test` and `test --full` keep their existing contracts. Missing native dependencies and unsupported rule kinds are not passing quiet cases.

`review rules` evaluates both rule versions against the frozen union of authored witnesses. Deleting or relabeling a candidate case cannot erase the incumbent case or its expectation. The report retains source-file digests and line provenance, rule/witness conflicts, old/new observations, first-prefix positions, and an exercised/total denominator. TSV witness IDs bind contextual input; changed context is reported as removed/added input rather than guessed identity. Stream positions count UTF-16 code units; a final-snapshot hit is separately marked. The comparison is bounded to 1,024 witness variants and a two-minute native-observation budget.

Paired-review exit codes are `0` for `NO_DELTA_IN_EXERCISED_WITNESSES`, `1` for deltas/conflicts, `2` for invalid invocation, and `3` for unavailable or changed inputs/identities. No-delta covers only the exercised witnesses, never equivalence or safety. Plain selected-pack testing and paired review never install rules, change profiles, or certify live blocking or effective-profile behavior.

### Opt in to isolated custom live proof

Add a data-only fixture to an explicit selected pack:

```sh
"$KIT" test --rules /absolute/pack/rules --cases /absolute/pack/cases.tsv \
  --live-fixture /absolute/public-live.json --json
```

For a selected `public-live-marker` rule matching `PUBLIC_BLOCK_SAMPLE` in `tool:write`:

```json
{
  "schema_version": 1,
  "classification": "public-synthetic",
  "rule": "public-live-marker",
  "scenarios": [
    {"id":"allow","role":"allow","content":"PUBLIC_ALLOW_SAMPLE","expected_marker_effect":"present"},
    {"id":"block","role":"block","content":"PUBLIC_BLOCK_SAMPLE","expected_marker_effect":"absent"},
    {"id":"quiet","role":"quiet","content":"PUBLIC_BLOCK_SAMPLe","expected_marker_effect":"present"}
  ]
}
```

The strict schema requires exactly one allow, block, and quiet scenario. It rejects unknown fields, caller paths, commands, extensions, project code, providers, and environment overrides. G1–G3 must pass before G4 runs; plain external testing never opts in implicitly.

G4 copies only the selected rule into a fresh private HOME and uses fixed native `write` actions in disposable Git projects. It verifies exact bytes for the allow/quiet markers and requires both an absent blocked marker and a native user-role interruption naming the selected rule. Quoted interruption text or a model claim cannot substitute for the physical effect. `data.test` retains the selected G1–G3 result; `data.live` records the separate scenario IDs, effects, runtime/resource identity brackets, and input readback.

The OMP installation remains operator-trusted. This is isolated synthetic evidence, not a hostile-code sandbox or certification of your effective profile. No model credentials, caller project execution, rule installation, or profile activation is implied.

### Reduce a public/synthetic false fire

An unreleased installed build can minimize an authored quiet witness that actually fires:

```sh
"$KIT" review reduce --rules /absolute/pack/rules --fixture /absolute/public-fixture.json --json
"$KIT" review reduce --rules /absolute/pack/rules --fixture /absolute/replay.json --replay-only --json
```

For a selected synthetic `public-false-fire` rule matching `PUBLIC SAMPLE`, the first fixture can be:

```json
{
  "schema_version": 1,
  "classification": "public-synthetic",
  "approved_fields": ["rule", "expect", "source", "tool", "path", "snippet"],
  "witness": {
    "rule": "public-false-fire",
    "expect": "quiet",
    "source": "text",
    "tool": "-",
    "path": "-",
    "snippet": "BEGIN PUBLIC EXAMPLE\nremovable padding one\nPUBLIC SAMPLE\nremovable padding two\nEND PUBLIC EXAMPLE\n"
  },
  "preserve": {"prefix": "BEGIN PUBLIC EXAMPLE\n", "suffix": "END PUBLIC EXAMPLE\n"},
  "predicate": "G2"
}
```

Use `G2` for a whole-payload fire or `G3` for a prefix fire. The reducer preserves the rule, expectation, source/tool/path, and nonempty prefix/suffix. It deletes lines only, within attempt/time limits; it does not claim global minimality. The JSON fixture is limited to 128 KiB and must be valid UTF-8, with exactly the approved witness fields and no unknown keys.

On success, save only `data.replay_fixture` from the JSON result as `replay.json`. It contains the approved witness and complete hash-only identity pins. Do not drop or partially edit those pins: replay invokes the real observer and rejects changed identities. A non-reproducing seed, unavailable observer, lost predicate, or incomplete final replay exports no fixture. Exit codes are `0` for reduced/unchanged/reproduced, `1` for not reproduced, `2` for invalid input, and `3` for unavailable/incomplete proof.

`public-synthetic` and `approved_fields` are caller approvals, not automatic de-identification. Inspect every approved string yourself; never submit private transcripts or secrets. The command emits neither raw producer output nor generated shell replay instructions and never edits the selected inputs or OMP profile.

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

The separate `memory audit --store-root ABSOLUTE_MNEMOPI_ROOT --yes --json` command requires explicit consent. It reads supported database bytes without opening a live SQLite connection, migrating stores, or making model/network calls. Exact source pins cover inspected OMP/pi-mnemopi 18.4.2 and 18.4.4 producers. It enumerates all banks under the selected root and reports category counts plus the exact working/episodic row denominator for `working_memory.content` and `episodic_memory.content`; it emits no stored text, row snippets, secret hashes, or store paths. WAL/SHM/journal sidecars, unsafe paths, unreadable stores, and unsupported schemas refuse coverage. `NO_MATCHES_IN_COVERED_CLASSES` is not clearance for other columns, roots, secret classes, or live memory behavior. The independent redactor-compatibility diagnostic may remain UNVERIFIED even when this bounded audit completes; source/schema support does not expand native archive certification.

`doctor --scope lsp --json` and `lsp setup --plan` only inspect configuration. The opt-in `doctor --scope lsp --deep --yes --project ABSOLUTE_PROJECT --file ABSOLUTE_TS_FILE --json` drives OMP's `lsp` tool in a private synthetic TypeScript project, with an isolated HOME/profile and a loopback mock model. It does not send the selected source file to the mock model or execute workspace-configured LSP commands. Only OMP's built-in `typescript-language-server`, resolved outside the project, is eligible; custom or other-language routes return UNVERIFIED. The report separates protected source/config snapshots from isolated runtime outputs and stops only its private LSP mux. This proves that OMP route against the synthetic fixture, not runtime behavior for every server or the target project.

The deep route requires the supported OMP launcher, Node, Git, and the built-in TypeScript language-server executable to be present on a non-project PATH; it installs none of them. These installations must be operator-trusted. The probe does not authenticate executable provenance or provide isolation from a malicious process running as the same user.

These versioned recipes **render only**. Copy one manually into a **new**, operator-owned named profile after confirming the name does not collide; never merge into an existing or default profile. The memory-off recipe disables memory. The separate Mnemopi recipe disables automatic retain/recall and chooses per-project storage, but manual retain can still store private text; activation and effective runtime state remain unverified until safely observed. Model-role choices have no personal IDs, backend fallbacks, subscription assumptions, or automatic login. The MCP recipe only describes connecting an existing local server; it neither installs a server nor supplies credentials. LSP setup inventories the local route without starting servers. The project-loading preflight inventories startup inputs before opening OMP in that checkout; it cannot prove an extension harmless. `doctor --scope memory` reports configured readiness, not proof that private memory is free of secrets. Deep LSP probing and private-memory-store auditing are not certified installed workflows.

### Keeping up with OMP

OMP releases often, and updaters such as UCA, `npm update -g` or `bun update -g` install new versions unattended. `omp-kit test --record` saves the verdict and the tested OMP (version and launcher hash) in the private state root. `status` and `doctor` then report an `omp_drift` finding: OK while the recorded test passed on the current OMP, DEGRADED once OMP changes or the last recorded test failed. Plain `omp-kit test` stays read-only and records nothing.

To re-test after every update, render a watcher and install it yourself:

```sh
"$KIT" examples omp-watch --json   # launchd agent (macOS) and systemd .path/.service pair (Linux)
```

It watches OMP's `package.json`, runs `omp-kit test --record` when that file changes, and posts a desktop notification only when the test does not pass. Rendering installs nothing; the output lists install and uninstall commands. The job calls the `omp-kit` launcher on your PATH, so it keeps working across kit updates. A passing re-test proves the shipped pack on the new OMP; it does not stop an updater from installing a breaking OMP.

## Native OMP first

Before reaching for kit rules, use what OMP already ships. The recorded command probes below used stock OMP **18.4.3** with a disposable HOME. That historical run saw 27 installed rules and plugin-directory warnings; neither the inventory count nor a fresh-HOME warning is a compatibility requirement. Those observations do not certify 18.4.4 or any other installation: record the selected version and check its actual behavior separately. Interactive-only examples are identified below.

```sh
omp --version                                  # record the selected runtime; do not relabel a newer version as 18.4.3
omp ttsr list                                   # installed TTSR rules, rc=0
omp ttsr test --source tool --tool bash --path run.sh 'echo hello'   # quiet probe: no rules triggered, rc=0
omp ttsr scan .                                 # scan the current project; rc=0 even when empty (not coverage proof)
omp plugin doctor --json                        # plugin-dir health, not hook parity; rc=0
```

Interactive only: `/extensions` (slash command with no non-TTY form) and `omp --hook ./my-hook.ts` (refuses without a TTY, rc=2, verified with stdin closed). The former shows discovery/selection state, never firing proof; the latter loads JS/TS factories only — shell scripts are not loaded as handlers.

Foreign hook manifests are declarations, not handlers. A Claude `settings.json` entry or a Codex `hooks.json` entry is CONFIGURED when written; it is not an active OMP guard. OMP discovery can report candidate paths without importing them, but a discovered path does not establish a callable JS/TS factory, and neither discovery nor dashboard presence proves firing. EFFECT_OBSERVED requires an isolated run showing the permitted/blocked effect. Kit G1–G4 proof (whole-payload, streamed-prefix, isolated live) is extra evidence for the kit's own shipped pack; it certifies neither foreign hooks nor your effective profile.

The manifest-discovery distinction was derived from OMP 18.4.3 source, not a live hook run. For a fresh behavioral check, `bun test tests/cli/native-guide.test.ts` resolves the PATH-selected installed OMP launcher and matching source, compares CLI/package versions, and uses an empty disposable Git repository with sanitized HOME/XDG paths and no copied checkout or model credentials. Its native discovery fixture checks manifest-only absence and positive candidate-path discovery, with canaries for unexpected manifest-command, module-import, or factory execution. It calls the discovery API, never the runtime hook loader. A pass is discovery evidence for that exact installation, not factory-loadability, hook-firing, parity, or release-certification evidence; handler effects remain UNVERIFIED.

The separate no-terminal refusal probe runs on OMP 18.4.3 and every later version, so a regression in a new OMP release fails the probe instead of being skipped. It expects exit 2, the TTY refusal, and no synthetic hook import. Versions before 18.4.3, which lack the pre-import guard, skip it before any fixture is created; a skip is not a refusal pass. No hook is activated by this probe.

For classification only, consider two **synthetic, uninstalled** fixture files: `.claude/settings.json` containing `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"printf fixture"}]}]}}`, and `.codex/hooks.json` containing `{"hooks":{"notify":[{"command":"printf fixture"}]}}`. These illustrate manifest data, **not validated provider configuration templates**. Each is merely CONFIGURED at its source path; with no OMP JS/TS factory selected, handler state and effect remain UNVERIFIED. Do not copy these into a live profile or run their commands.

**Stop at native tooling** when `omp ttsr list/test/scan` answers the question. If a specific gap needs kit-authored prefix or isolated live evidence, preview the named rule/extension for the exact selected profile and target with `omp-kit test --json` and the applicable read-only `apply ... --plan --json`; ask the profile owner to approve that specific change before any apply. Do not blanket-enable foreign providers or copy an entire profile.

## Development and tests

In the source checkout, edit `rules/*.md` alongside fire and nearby quiet cases in `cases/cases.tsv`. Run `sh scripts/build-manifest.sh --check` and `sh scripts/ladder.sh`; the latter exercises the case gate and isolated live suite and writes local `reports/`, which must never ship. See [CONTRIBUTING.md](CONTRIBUTING.md) for the change workflow, [ROADMAP.md](ROADMAP.md) for what is done, in review and next, and [SKILL.md](SKILL.md) for the source-only operator reference. The installed CLI embeds Bun, but a separately installed OMP launcher with a Bun shebang may still require Bun for its own live process. Source development also needs Bun. Native release support is limited to the platforms certified against stock OMP 18.4.2; other OMP versions are not certified.

## Limits and safety

The case gate proves registration, whole-payload matches, and prefix behavior; only the isolated live suite checks blocking. OMP profile inspection can migrate settings, so read-only diagnostics do not call a potentially migratory path on the operator profile and label inaccessible effective settings `UNVERIFIED`. Project-local rules may override installed global rules. No CLI command installs OMP or enables policy, extensions, providers, or a model by implication. The source pack does not authenticate cited SHAs, counts, or audit rows; run acceptance commands yourself.

This public source root has no inherited history from the original private checkout; the original repository stays private. Only native-certified archive targets appear in the versioned release index; check the [tagged release assets](https://github.com/JYeswak/omp-kit-companion/releases/tag/v0.1.1) and exact [hero grade](visual/hero-identity-grade.json), which discloses that the original gpt-4o-mini model could not run and names the independent substitute judge. No kit command proves your effective OMP profile safe. Never publish `reports/`, private receipts, tracker exports, or session logs. Refuted hypotheses and conditions for revisiting them are in [NEGATIVE_EVIDENCE.md](NEGATIVE_EVIDENCE.md).

Bug reports and proposals: [CONTRIBUTING.md](CONTRIBUTING.md). Sensitive reports: [SECURITY.md](SECURITY.md).

## Who built this

Maintained by [JYeswak](https://github.com/JYeswak).

## License

MIT. See [LICENSE](LICENSE).
