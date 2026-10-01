# AGENTS.md — omp-kit

Instructions for coding agents (and humans) working in this repository.

## RULE 0 - THE FUNDAMENTAL OVERRIDE PREROGATIVE

If the maintainer tells you to do something, even if it goes against what follows below, do it. The maintainer is in charge.

---

## RULE 0.5 - HONEST WORK AND ANTI-CEREMONY (binding for agents and humans alike)

The purpose of agent work here is working, deployable capability. Process serves that outcome and never becomes the product.

- A process artifact (certificate, ledger, dashboard, matrix, meta-report, speculative check) may be created only if it names a concrete consumer, the named feature it gates, the observed defect class justifying it, and its deletion condition. Otherwise it does not get created. Boundary test: if running code branches on it, it is product; if only humans and status reports read it, it is process and the creation-gate rule above applies; code written just to flip this answer counts as the pathology, not as a consumer. Sole exception: a minimal integrity/recovery control (crash-recovery state, provenance snapshot) is legitimate when it prevents a named evidence-loss or corruption mode and is necessary and minimal.
- Real code + real tests in the same unit of work. Forbidden: faked tests, fixtures/mocks presented as live proof, weakened assertions, golden regeneration to force green, hard-coded success paths, placeholder macros in commits, editing the spec instead of implementing it, narrowing scope while claiming full success.
- No self-certification: work is closed by an independent verifier citing evidence at an exact revision. Solo sessions re-verify by re-execution and state what was not independently verified.
- A typed refusal beats a fabricated result and is less valuable than the real capability; refusal-only work stays open and says so.
- Truthful null results ("checked X, found no material increment") are successful outcomes. Unsupported claims are worse than silence.
- Metrics predeclare denominator and countermetric; agreement between agents may raise confidence but is never independent evidence; never silence stderr in evidence-bearing commands.
- Name these pathologies when they occur (gate self-weakening, proof-class inflation, golden regeneration, tolerance widening, suppression-pragma laundering, refusal farming, follow-up laundering); the names are the deterrent. The full catalog with countermeasures lives in the just-say-no-to-process-porn-and-ceremony skill; ask the operator for it if you cannot resolve that reference.

---

## RULE NUMBER 1: NO FILE DELETION

Never delete a file or folder you did not create in the current task without explicit permission from the maintainer. Code made obsolete by an approved cutover is part of that cutover and is removed in the same change.

---

## Irreversible Git & Filesystem Actions

No `git reset --hard`, `git clean`, force-push, branch deletion of unmerged work, `rm -rf`, or history rewriting without explicit permission. Stage explicit paths, never the whole tree. If a command could destroy work you did not write, stop and ask.

## Git Branch

`main` is the only long-lived branch. Work on a short-lived feature branch, open a pull request, and merge only with CI green. Commit early and push your branch; never hold finished work in a dirty tree or in agent scratch. Commit subjects state their verification level: `[test]`, `[selftest]`, `[live]` or `[pending]`.

## Toolchain

Bun runs and compiles the TypeScript CLI (`bun build --compile`, embedded runtime; installed users need no Bun). The installer is POSIX sh plus Python 3 standard library. There are no npm dependencies; OMP itself is the only external runtime, resolved from the operator's existing install.

### Key Dependencies

- OMP (oh-my-pi), any current release: the kit tests against whatever the operator installed. A scheduled workflow (`.github/workflows/omp-latest.yml`) runs the CLI contracts and the full ladder against the latest npm release every 3 hours and opens one issue per breaking OMP version.
- `typescript-language-server` for the LSP readiness probe (CI installs it; operators keep their own).

## Code Editing Discipline

Edit source by hand with precise, reviewable changes. Prefer extending an existing module over creating a parallel one.

### No Script-Based Changes

Never run regex or script rewrites across files to "fix" code. Make each change deliberately and read the result.

### No File Proliferation

No `*_v2`, `*_new`, or duplicate modules. One canonical implementation per concept; migrate every caller in the same change.

## Backwards Compatibility

Clean cutover: when a command or format changes, migrate every caller, test and document in the same change and remove the old path. No compatibility aliases or shims. Record user-visible changes in `CHANGELOG.md` under "Unreleased".

## Compiler Checks

Before committing: `bun test tests/cli`, `sh scripts/build-manifest.sh --check`, `shellcheck scripts/*.sh checkers/*.sh installer/install.sh tests/cli/installer.test.sh`, and `actionlint` for workflow changes. Capture the producer's complete output and exit code before filtering it.

## Testing

### Testing Policy

A permanent test must catch a plausible user-visible bug: behavior, boundaries, invariants, errors. No tests of wiring, copied constants, or source text. Every gate ships with a planted negative that makes it go red, and every fix ships with a test that fails before it. Synthetic-HOME evidence never stands in for real-machine behavior: if a claim is about an operator's machine, verify it on a realistic HOME (the real-HOME journey) and say which you ran.

### Test Categories

- `tests/cli/*.test.ts` (`bun test tests/cli`): CLI contracts, receipts, real OMP matcher (G1–G3), selected packs, review and reduction.
- `scripts/ladder.sh`: manifest, harness gate and selftests, claim/readiness checkers, and the isolated live suite (G4, 70 scenarios plus a planted negative) using real OMP with a credential-free scripted model.
- `tests/cli/installer.test.sh`: the versioned installer against a real archive.
- CI native certification (`scripts/native-candidate.py`) on each released archive and platform.

## Third-Party Library Usage

Prefer what OMP and the platform already ship. Before adding anything, check whether OMP provides it natively (`omp --help`, `omp ttsr`, `omp plugin`/`omp install`, `omp config`); the kit adds only what OMP lacks and teaches the native path otherwise.

## Architecture

The kit is an installable companion for an existing OMP: a tested rule pack, a proof harness anyone can run on their own pack, and guidance for native OMP tooling. It never installs OMP, changes profiles by implication, or runs a daemon.

### Project Structure

- `src/cli.ts`, `src/commands.ts`: one command registry drives parsing, help, schema, capabilities and completion.
- `src/test-runner.ts`, `scripts/ttsr-harness.ts`: fast G1–G3 through OMP's own TTSR matcher; `src/full-test-runner.ts` adds the isolated live ladder and the operator-file integrity check (`src/operator-snapshot.ts`).
- `src/mutations.ts`, `src/apply*.ts`, `src/repair.ts`, `src/audit.ts`: guarded writes with receipts and undo; `src/state-root.ts` guards the private state root.
- `src/kit-update.ts`, `src/kit-release.ts`, `installer/`, `scripts/package-release.*`: versioned native archives, install and kit-only update.
- `src/diagnostics.ts` and the `*-readiness.ts` modules: read-only doctor findings.
- `rules/`, `cases/cases.tsv`, `MANIFEST.tsv`, `tests/live/scenarios.json`: the shipped pack, its fire/near-miss corpus and live scenarios.

## Landing the Plane

A task is done when its change is merged to `main` with CI green and its acceptance re-run by someone other than the implementer, with the output cited at the exact commit. Any merged user-visible change ships in a release within 7 days. New research or decision-gate work needs a named user who asked for it. This project is built in public: a PR that changes an item's status updates [ROADMAP.md](ROADMAP.md) in the same change. Before ending a session: commit and push your branch, open or update the pull request, and leave no finished work uncommitted.

## Note on Built-in TODO Functionality

Use your agent's built-in todo list for in-session tracking only. Durable work items live in the maintainers' tracker; a todo item is not evidence that work is done.
