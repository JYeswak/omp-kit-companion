# Roadmap

omp-kit is built in public. This file is the plan of record: what is done, what is in review, and what is next. Every pull request that changes the status of an item updates this file in the same change.

## Mission (approved by the maintainer, 2026-10-04)

omp-kit is the guardrail and proficiency layer for OMP agent fleets. The maintainer's own fleet is the proving ground.

1. **Current:** we track every OMP release within a day of publication, re-certify against it and say plainly what changed.
2. **Loaded:** every agent in every profile actually runs the current rules, hooks, skills, commands and extensions. Being on disk doesn't count.
3. **Proven:** every rule, hook, skill and command ships with a testing ground: firing cases, near-miss cases that must stay quiet, a planted failure that must go red, and a live check on a real fleet.
4. **Measured:** the local agentic environment is measurable end to end: rule fire and false-fire rates, latency, machine load, idle and stuck time, gate outcomes, skill use. Every change is judged against a baseline.
5. **Learning:** we apply the strongest current research and practice on agent gates and tool use, and every repeated fleet gap becomes a tested rule, hook or skill. A new practice is adopted only after it beats the old one on our own measurements.
6. **Native-first and shareable:** we build only what OMP lacks, teach the native path for the rest, and every feature installs cleanly for a stranger on macOS and Linux.

**Done for a feature:** it works on the fleet, passes its testing ground, has independent review, and installs on a fresh machine.

**Cadence.** Daily: every profile runs the current kit, main is green, no worker sits idle or stuck, new OMP releases are checked, and nothing closes without independent evidence. Weekly: a certified release that reaches every profile by itself, the measurement report compared with the previous week, the tracker re-graded, repeated gaps turned into rules or skills, and one research item tried and kept or dropped on the measurements. Long-term: a stranger gets the whole layer in one command, and their agents measurably follow their rules and use their tools well, proven on macOS and Linux and kept current as OMP moves.

**Not in the mission:** fixing other repositories' bugs (we detect, mitigate and report); becoming an OMP installer, profile manager or dashboard; adopting research because it is impressive rather than because it measured better.

### For later discussion: a learning loop over every interaction (not scheduled)

The maintainer's long-term goal, recorded 2026-10-04 and not yet planned: every agent interaction is recorded and joined, so the fleet learns which prompts, skills and processes work. That means time to close, first-try review pass rate, reopen rate, and the blockers and gaps seen, each measured against a baseline and fed back into the next change. It is the long horizon of the Measured and Learning pillars.

- **Sources.** OMP session files are the only required source, because every omp-kit user has them. A tracker (br), a dispatcher (ntm) and git are optional: used when present, and their absence is reported, not an error.
- **Shape.** Probably a family of tools rather than one binary: a recorder (a plugin extension that tags each session with its work item, model and harness), a joiner (one private local table: work item, prompts, sessions, skills, outcome), a learner (comparisons with sample sizes and confidence intervals) and an applier (proposes a rule, skill or prompt change that a person approves).
- **Constraints.** The reward is the real outcome (independently reviewed, proven live, stayed closed), never speed of closing. Small samples are reported as such. Mining stays on the user's machine.
- **When.** After the current projects wrap up, possibly as separate projects, each with its own planning. Existing beads feed it: F2, MT2, SM1, LR1, MP5, MP7.

**Done** means merged to `main` with CI green, and the acceptance checks re-run by someone other than the author, with output cited. Evidence from a synthetic HOME never closes a real-machine check.

## Why this round exists (reality check, 2026-10-01)

On real operator machines, three things failed that every synthetic-HOME test had passed:

- `test --full` hashed the whole HOME, which always exceeded its bound and changed under unrelated concurrent work.
- `update --apply` therefore could never pass its postcheck.
- State roots created with mode 0755 by the pre-CLI scripts made every receipt command fail with a generic error.

The fixes shipped in #4. This roadmap follows from that finding: prove things on realistic HOMEs, release often, and lean on native OMP features instead of rebuilding them.

## Done

| Item | Where |
|---|---|
| `test --full` watches only operator paths a kit run could write (content and mode); failures name the path | #4 |
| `update --apply` reports failed stages, changed paths and the exact `undo` command on a failed postcheck | #4 |
| State-root permission gate with a named error; `repair --scope state` restores 0700 | #4 |
| `--version`/`-V`; human findings table; no internal tracker ids in user-facing text | #4 |
| CI against the latest OMP every 3 hours, one issue per breaking version (`omp-latest.yml`) | #4 |
| `test --record`, an `omp_drift` finding in status/doctor, and the render-only `examples omp-watch` (launchd/systemd re-test on every OMP update) | #5 |
| Acceptance tests: update postcheck envelope; a rendered-output scan for internal ids | #6 |
| Native-certification receipts name the failing command, stages and scenarios | #7 |
| `health` judges only what a read-only inventory can prove; the rest is listed as `not_judged` and never affects the exit code | #9 |
| Docs for strangers: 60-second README plus a native-OMP guide checked by `bun test tests/cli/docs.test.ts` | #10 |
| Real-HOME journey in CI: 52k-file HOME, edited rules, legacy 0755 state root, a concurrent writer, one JSONL line per step, on macOS and Linux | #12 |
| Latest-OMP CI records first-fire indices per OMP version and reports a default-policy G4 run separately | #13 |
| **Released [v0.2.0](https://github.com/JYeswak/omp-kit-companion/releases/tag/v0.2.0):** 4 natively certified archives, index and receipts; a fresh-HOME install from the published index passes `test --full` (70/70 live, plant caught) | #15 |
| Rules as a native OMP plugin: root plugin manifest, lifecycle e2e (link, fire, disable, uninstall, git install and upgrade) | #14 |
| `health.test.ts` runs in a fresh clone | #16 |
| Rule false fires on quoted text (`kit-settings-mutation`, `kit-test-skip`) | #17 |
| Capability-preserving context: read-only listing-cost report plus `test --capabilities FILE`, checked through OMP discovery | #19 |
| TTSR policy drift check: `doctor --scope settings` reads each listed profile's `ttsr.*` with OMP's native config reader; the kit writes only `ttsr.*`, through native `config set` with readback | #20 |
| The `test-skip-ts-fire` gate no longer depends on OMP's late-interrupt race; a report-only probe keeps measuring it | #21 |
| Usage-derived skill set and render-only pruned-profile recipe, gated by `test --capabilities` | #22 |
| A kit test run leaves no processes behind (2,395 orphaned mock servers found on one machine) | #23 |
| **Released v0.2.1:** the plugin route, settings drift, capability context, skill-set recipe and the leak guard | #26 |
| **Released v0.2.2:** service lifecycle, scratch reaper, migration/overlays, metamorphic ratchet, mutants, extension skip-reasons, agent-mail guard, stack currency, B10 cold-start, AST-grep candidates, e2e provider isolation, session-save guard | #54 |
| **Released v0.2.3:** min+latest OMP certification, fleet work doctor, zero-break metamorphic invariant, derived case/scenario counts, changelog fragments, live Go `t.Skip` edit fix, rule scope parity, npm-installed OMP corpus fix, OMP 18.5.0 memory review | — |
| **Release v0.2.5 (in cut):** worker callbacks, fleet-watch job, sessions and browsers doctor scopes, scratch release and scheduled reaper, five linear-time Bash rules, regex-engineering reminder and ReDoS gate, OMP 18.6.0 certification (v0.2.4 tag unpublished) | — |

## In review

| Item | PR |
|---|---|
| — | — |

## Next

1. **Latest-OMP certification.** #25 found that memory inspection gates on the OMP version string (18.4.2) rather than on the reviewed source bytes, which are identical in 18.4.9. Gate on content instead.
2. **`omp-kit service`:** install/status/doctor for the kit's own background jobs, following the launchd pattern of established CLIs. Then a scratch reaper that runs as one of those jobs, so agent scratch is reclaimed without anyone deleting by hand.
3. **Rules that enforce the save/store/push procedures** every session loads (no scratch in `/tmp`, no pattern kills, no force-push).
4. **OMP late-interrupt fix upstream:** reported as can1357/oh-my-pi#14018, fixed in PR #14020 (not yet released). When a release contains it, the report-only probe becomes a gate again.
5. **After the plugin route has users:** remove `apply rules`/`apply extensions`.

### Decided 2026-10-04 (maintainer), in the tracker, not yet built

- **One kit store, every profile.** OMP keeps plugins per profile, and the kit plugin was enabled in only one of the maintainer's 17 profiles, so the other 16 loaded no kit rules or extensions and kit releases did not reach them. The fix: `omp-kit doctor` reports what each profile actually loads; one kit store is linked into every profile with a receipt and an undo; the copy routes (`apply rules`/`apply extensions`) are then retired. The real-machine rollout waits until the shipped rules pass the regex time budget, because linking puts that cost on every live session.
- **A prompt library for every session.** Today prompts are applied by hand or copied into profiles one by one (89 prompt files copied into 7 profiles, none in 9). The kit will ship one library inside its plugin, so every profile gets it through OMP's own discovery. Each prompt is tagged with the process stage it serves (plan, dispatch, build, review, grade, close, learn), the skills it pairs with, its source and a version. Sources: the prompts sessions already use by hand, the jfp catalog, ntm palettes and public prompts, deduplicated and approved by the maintainer. Every prompt carries a line telling the session how to report a gap uphill to the kit's intake bead. Agreed with the jev and localbench sessions (uds ACK with conditions):
  - No model grades a prompt until it has its own receipt against blind human labels and beats a constant-plus-keyword baseline. Until then any grade is advisory.
  - A rubric score is a style check. Real grading is outcome-based, and each stage names its oracle first (for example closes per day for dispatch prompts, the false-PASS rate found later for grade prompts).
  - Grading runs through jev's model-neutral classifier, called by the kit. localbench owns the GPU and the gateway; batch grading runs at low priority and only after its admission work lands. Prompt A/B tests that use a local model go through `localbench ab`.
- **Mission Protocol.** Every session carries a stamped mission and pillars (`.omp/mission.toml`). Findings and gaps go uphill to omp-kit, are fixed here, and reach every session through a release. Closing a work item needs a reviewer from a different session, preferably a different model family. When none is free, a fresh-context reviewer with no build context may stand in, and it is labelled as such.
- **Skill pruning is decision-first.** Before any profile changes, the maintainer gets a measured cut list (bytes, usage from his own sessions, keep or drop with a reason) and approves it.
- **Release supply chain.** Signing, SBOM and SLSA provenance for release archives, checked by the installer, and a Homebrew formula. Both run on release only.
- **CI cost (shipped in 537da5ed85 and eb60f06f85).** The full native matrix (macOS, four archives) runs on release and daily, not on demand. The latest-OMP check runs daily. Run artifacts are kept 2 days, release candidates 7.

## Parked

Gate, pilot and speculative items without a named user are parked: a GitHub Action for rule authors, a foreign-hook importer, automata-based rule proofs, and pairwise settings matrices. Any of them reopens when someone names a concrete need. Closed 2026-10-04: a standing review step (replaced by independent review on every close), a fleet dashboard, a UBS pre-commit hook, and replaying past tool calls against a rule change.

## How we work

- Small PRs, each with the evidence it claims: commands, exit codes, CI links, planted negatives.
- No weakened gates, no regenerated goldens, no skips without a stated environmental reason.
- Read `AGENTS.md` before contributing; `NEGATIVE_EVIDENCE.md` records what did not work and why.
