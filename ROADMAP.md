---
status: current
---

# Roadmap

omp-kit is built in public. This file is the plan of record: what is done, what is in review, and what is next. Every pull request that changes the status of an item updates this file in the same change.

The rolling-release section below defines current delivery priorities. Older cut and review entries are historical references, not version pins or prerequisites for the next release.

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

**Done** happens in three stages: accepted, published and running (defined in [AGENTS.md](AGENTS.md#landing-the-plane)). An item is done at the stage its acceptance names: on `main` with an exact-tree full-suite PASS and a non-author re-run at that commit with output cited, then cut by `scripts/release-local.sh`, then loaded where it is meant to run, when the item's acceptance requires those stages. Evidence from a synthetic HOME never closes a real-machine check.

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
| CI tests only `minimum` and `certified` OMP; hourly `omp-certify.yml` (replaces `omp-latest.yml`) certifies each new release through a PR with hash, diff and model findings | #67 |
| `test --full` reports an isolated OMP trust-guard refusal as an actionable `NOT_RUN` stage before CLI cases run; trust policy is unchanged | ompkit-i5oe |
| Advisor restoration persists intent and pre-run WATCHDOG evidence; resume reconciles without a duplicate `/advisor on` | ompkit-rhy9.4 |
| Herdr land binds the native pane identity to project-scoped Agent Mail; installed Herdr consumer proof remains blocked pending an authorized pane and candidate route | ompkit-2giu.2 (BLOCKED) |
| Finite Bash admissions reject disabled deadlines and known finite suites cannot be labeled as services; owner/job/proc cancellation verification remains blocked on native lifecycle evidence | ompkit-xa5s.22 (BLOCKED) |
| Scratch plan/apply expose row sizes, malformed-owner counts, per-root/per-verdict totals, policy, and receipt through the public CLI | ompkit-rhy9.17 (OPEN: policy-drift negative remains) |
| Beads doctor and planning score report configured acceptance breadth with component-aware split suggestions | ompkit-rhy9.21 (BLOCKED: dirty overlap on CHANGELOG.md and package.json) |
| Tracker recovery bounds quarantine growth, emits native health receipts, and refuses intervention while database holders are live | ompkit-rhy9.14 (IN REVIEW; independent verification pending) |
| Stock Ubuntu extension CI passes [81/0 with fleet tools absent](https://github.com/JYeswak/omp-kit-companion/actions/runs/39100227808/job/117594813422); the separate [callback assertion control fails 81/1](https://github.com/JYeswak/omp-kit-companion/actions/runs/39100330584/job/117595119154). Both original hosted clauses are independently audited; overall main CI remains RED on fixture repair | ompkit-oq1h.4 (IN REVIEW; closure pending) |
| Native tool admission for opted-in fleet repositories is ready for independent replay, including owned synthetic scratch inputs, tracked-source copies and reusable instructions. Original acceptance and separate external-live caller-root qualification remain pending | ompkit-xa5s.4 (IN PROGRESS; independent replay pending; no installed or release claim) |
| Agent Mail inbox admission counts an outer write and mounted dispatch once without sliding the rate window. The fix and portable native replay are published; original read/refusal controls pass independent review. Fleet rollout and non-author closure remain separate | ompkit-fp72.19.1.57 (IN REVIEW; non-author closure pending) |
| Guarded mail resolves registered recipients omitted from capped rosters through bounded native exact lookup, preserving ambiguity warnings and fail-closed unknowns. Focused controls and independent source review pass; native dispatcher success is measured separately from the still-failing wake path | ompkit-774u.13.5 (SOURCE READY; publication and non-author closure pending) |
| Fleet-watch writes typed pull.attempt decisions and source.tick coverage to the CC spool without copying action text. Focused producer and CC projection tests pass; the live 1h run had no watcher tick, and all four original acceptance items remain unchecked; publication awaits source-ready phase admission | ompkit-fp72.120.16.10.11 (BLOCKED: live freshness and source-review gate pending) |
| Caller-selected patch construction applies the bytes read and parsed even if the patch file changes during fetch. The real-Git replacement regression passes; the full consumer file is 70/1 on the existing doctor deadline. Independent original calibration, publication and closure remain pending; no full-suite or release claim | ompkit-rhy9.8 (SOURCE READY; verification and publication pending) |
| Full-suite children discard inherited publisher tracker selection while preserving explicit per-test choices. The owned native sentinel regression passes 23/0 and real repository trailer controls remain intact; the native PULL fixture still has two unchanged-deadline failures, so complete qualification, publication and independent acceptance remain pending | ompkit-fp72.143 (SOURCE READY; qualification and non-author acceptance pending; no release claim) |
| Session startup puts the release-verified `br` shim first on PATH for Python/Bun children; doctor proves review, claim and create refusals on an owned fixture without live tracker writes | ompkit-fp72.135.3.82 (IN REVIEW; independent replay pending) |
| Bead-lint whole-id mention handling rejects parent-prefix inference from child IDs while preserving sentence-final parent mentions; focused 11-test suite, selftest, clean-copy replay and candidate-bound pregrade pass | ompkit-fp72.135.3.83 (IN REVIEW; independent closure pending) |

## In progress

| Item | Tracking |
|---|---|
| Declared milestone cuts plan single-bead builder/grader goals, preserve held and busy work, require owned pauses, and put overdue unresolved cut supply first in chief reports. Watcher/report controls pass 73/0 and the controlled source smoke passes; independent original acceptance and the released live-hour check remain pending. No service activation or release claim | ompkit-774u.56 (SOURCE BUILT; non-author review and live qualification pending) |
| Full-suite judging and direct suite execution discard inherited tracker/Git bindings without refusing. The runner acceptance passes 70/0 across all three suite kinds and existing containment controls; whole-repository qualification remains separate | ompkit-kup44.4.2 (SOURCE BUILT; review pending) |
| Long-token close-fire budget uses child CPU time, while the staged Python checker verifies deadline kills both parent and child. Fire-path controls: a 2 s wall stall passes at 3.10 s; 1.2 s CPU work fails at 2,016,273us. Exact 2ec archive with no MANIFEST.tsv passes AC1 after generating it in suite-owned scratch; non-author exact-c26 replay passes AC2 (14/0). The c26 pregrade could not assess AC1 because MANIFEST.tsv was missing; candidate-bound pregrade on 2ec is running. Receipts `ev_757321925545e25f7ff7dc8938965eef400b88a3a85652dcb910a6dca4e66154`, `ev_0c4569686c4e0d06fca3ee8a8147ff7fed2632719e01405c95ef5e52b6813ac6`, `ev_7fed6c8e73e8ae424d9f6adf139867f97c9c4ca68968f5bee5482ce5f63c31c4`. No full-suite, publication or installed-runtime claim | ompkit-774u.64 (IN PROGRESS; candidate pregrade running) |
| Declared milestone cuts constrain claims through one native authority; without a declared cut, stock claims remain unrestricted. Complete repository qualification remains non-pass and installed-worker proof remains pending | ompkit-774u.55 (BLOCKED on full qualification; no release claim) |
| Review and close preflight again honor the PATH-selected tracker and original non-claim budgets; claim binding and limits stay unchanged. Clean-copy original shim, preflight and verifier files pass; intermittent full-run claim failures are not claimed causally repaired | ompkit-774u.55.1 (SOURCE BUILT; independent review pending) |
| Bash write-ownership checks resolve reservation scope from the invoked checkout rather than the session checkout; focused regression and live held-lease positive/negative smoke pass. Full CLI suite timed out; independent review and publication remain pending | ompkit-rz5.168 (IN PROGRESS) |
| Mail registration and sending use actual caller-pane identity, strict registration keys, and native send/wake correlation. Guard/waker source controls pass 64/0; the separate orchestration audit's worker and chief consumers pass 49 focused controls. Loaded-chief delivery, actual default-macro registration and independent published-original acceptance remain unverified; no release or live claim | ompkit-uk9wn.2 |
| Saved archive runtime closure `08857bde4b` ships the gap scanner/findings library and validates real packaged comment/mail callbacks plus missing-dependency refusals. The complete package-release file passes 18/0 with its unchanged original test budgets. Independent published-original acceptance and the installed/relinked fleet check remain pending; no release or live claim | ompkit-fp72.135.3.57 (SOURCE/BUILD REVIEW; author handoff) |
| Native `omp-kit tern` SDK/control integration: command family wired, context-aware bindings and owned native plugin probes; compiled release assets and independent full acceptance remain pending | #102 / ompkit-kdbz.2.13 |
| FULLRED slice 2: pinned OMP test fixtures and migration/context regressions | ompkit-lrbd.3 (BLOCKED: sbh disk floor; e2e-live file custody) |
| Candidate CC producer validation consumes generated canonical event and credential rules before append, with typed refusal metadata and finite boundary checks. Required whole-CLI and shell gates remain non-pass; original acceptance, publication and the released live-hour check are not qualified | ompkit-hueaw (BLOCKED: required gates; unpublished candidate) |
| Shell temporary allocation bounds entropy before filtering, preserving ignored SIGPIPE and cleanup. Independent replay passes both original source criteria; required CLI qualification still fails at existing land-fixture deadlines. Source is saved, not published or release-qualified | ompkit-774u.32 (BLOCKED: FULLRED fixture qualification; published-original replay pending) |
| Python owned-temp conformance declares default SIGINT only in its cancellation child, preserving the background suite caller's ignored policy. Independent source replay passes foreground, asynchronous and single-failure mutant controls with unchanged expectations and deadlines; published-original acceptance still awaits the snapshot-publication repair | ompkit-lrbd.8 (IN REVIEW: source saved; publication guard pending) |
| Memory doctor reports read-only CASS status and static LaunchAgent declarations separately from retrieval qualification | ompkit-bj08.10 (IN PROGRESS) |
| Staged kitlib ratchet restricts origin admission to exact incumbent raw-spawn entries; named-X commit-msg proof requires the complete parent reversal per path | ompkit-fp72.135.3.67 (IN REVIEW: code cd12461; nonauthor graded real 3cbef/75849 78/78, three admissions, and negative logs; published-main replay pending; .41 history only) |
| Exact-candidate full-suite admission before normal and patch LAND publication; judge scripts come from the exact base, with tree/check/runtime-bound verdicts and fail-closed incomplete evidence | ompkit-rhy9.12 (IN REVIEW; five literal candidate boundary tests pass; independent full-repository suite and publication pending) |
| Source-free relocated consumers and exact-version opaque-cache fixtures passed both hosted core suites at `0265c469`; the full no-publish qualification passed all six shipping native lanes and candidate-index. All three original clauses are independently verified; no installed or release acceptance | ompkit-fp72.125 (IN REVIEW; author claim released) |
| All four original REL1 obligations have actual hosted witnesses, including the [published native-refusal control](https://github.com/JYeswak/omp-kit-companion/commit/970fb2394ea2365b45bed989dc94dfe8ce469a02). Independent verification covers the shipping-refusal negative and an exact-`0265c469` fresh-before/reuse-after index timing observation: 1142.607 s / 28.976 s, with identical proof/index/archive bytes and no fresh fallback. This finite historical/new pair is not a generalized or live-incumbent speedup claim; rehearsal signs and publishes nothing | ompkit-6q9i (IN REVIEW; author claim released; non-author closure required) |
| Independent CPU-growth method review, native causal controls and a single-process incumbent/candidate comparison are recorded. Historical macOS failure attribution and saved-revision candidate qualification remain unverified; the candidate remains under its author's source custody. The fixture prerequisite is delivered, not a substitute for these obligations | ompkit-v66l.18 (OPEN; only original AC3 verified) |
| Saved source `d09b68c7` passed all four original CIOUT1 obligations: actual bounded public failure JSON and native forced-exit console, measured duration, a real 900-second packaged-CLI timeout with stage/elapsed, and a genuine Intel refusal naming the 615.8 ms / 500 ms live-stream breach. All six shipping native lanes and candidate-index passed qualification `39114116236/2`; attempt 1 remains RED for receipt-upload timeout. Independent receipts verify the original acceptance, not release, installation or overall health | ompkit-fp72.63 (IN REVIEW; author claim released; non-author closure required) |
| All four original compaction obligations are independently verified at `7147800a`: actual Ubuntu [stock 100/0](https://github.com/JYeswak/omp-kit-companion/actions/runs/39124567834/job/117666876117) versus a separate same-source [unconditional-flags mutant 95/5](https://github.com/JYeswak/omp-kit-companion/actions/runs/39124614112/job/117667011774), plus exact-source 30/0 and actual stock/AGENTS/fleet filesystem effects. The original 31a 99/1 loss is retained; its Linux-invalid calling-cwd fixture was corrected without changing assertions. Core admission-oracle qualification remains separate and unresolved; no overall-main, native-session, health or release claim | ompkit-oq1h.2 (IN REVIEW; author claim released; non-author closure required) |
| All original shared-marker stock clauses are independently verified at `bfbd947002`: actual Ubuntu [stock 102/0](https://github.com/JYeswak/omp-kit-companion/actions/runs/39126305184/job/117672049755) versus [default-on mutant 93/9](https://github.com/JYeswak/omp-kit-companion/actions/runs/39126350073/job/117672184443), exact-source preserved save/fleet controls 81/0 with one existing live-only skip, and actual literal TMPDIR/file, disposable Git and dirty-stop effects without consumer scratch or private refusal guidance. The initial stock-PATH native-test harness loss is retained; restoring its actual br prerequisite changed no assertions. No overall-main, installed/native-session, health or release claim | ompkit-oq1h.3 (IN REVIEW; author claim released; non-author closure required) |
| Saved source `c711a66c2588` exercises actual unsigned native success (3521 pass / 0 fail / 1103 explicit skip), a genuine named assertion failure (513 / 1 / 0), and SIGTERM exit 3 with 513 observed cases and truthful incomplete capture. Complete available streams are hash-bound; exact-source producer/runtime checks pass 53/0 and packaging/native contracts 13/0. Existing Git/attachment inputs are exercised at the producer API; a separate actual CLI reference-input negative remains unverified/nondurable. The original closed manifest passes the published receiver. No authenticated-retention, native-release or overall-health claim; original acceptance awaits non-author verification | ompkit-fp72.100 (IN REVIEW; author claim released; non-author closure required) |
| The focused source regression is reported passing (`bun test tests/cli/kit-update.test.ts -t POSTCHECKBROWSER1`, 3 pass/0 fail). The selected installed job was v0.2.74 and failed `KIT_LIVE_TEST_FAILED`, not a run of this candidate; candidate-bound live postcheck remains unverified, AC2 unchecked. No release or install claim | ompkit-6gbej (SOURCE READY; live verification pending) |

## Rolling releases (reviewed 2026-10-17)

Requested by the maintainer: group the actual backlog into releases that improve the running system. Version numbers are allocated by the train, not assigned to phases. A wave may ship several small releases; completing an entire epic is never a release gate.

**Current cut:** source `2269d7169bfbddba12ef95e1d9adf741e38f0d46` passed [main CI](https://github.com/JYeswak/omp-kit-companion/actions/runs/39071018537). The [automatic train](https://github.com/JYeswak/omp-kit-companion/actions/runs/39071796183) started [native qualification](https://github.com/JYeswak/omp-kit-companion/actions/runs/39071814591). This is not yet a published release or an installed upgrade.

| Order | Delivered outcome | First tracked scope | Deployment criterion |
|---|---|---|---|
| 1. Restore delivery | Green source becomes a certified, signed release without a human cutting a version | `ompkit-v66l`, `.12` native staging, `.13` signed-upgrade runner; source-bound notes and signer admission | All shipping platforms and supported OMP tracks certify; signed final bytes pass real installation and compiled-upgrade checks; publication and an actual installed upgrade are verified |
| 2. Routine upgrades | Releases reach running consumers without manual rescue | `ompkit-774u.4`, `ompkit-v66l`: update/relink/restart and installed-versus-loaded proof; correct the publication/working-tree custody boundary exposed by the current cut | A real previous-to-new upgrade reaches the running consumer; failed postchecks and recovery are exercised; unrelated edits or editing leases do not veto publication of an admitted committed snapshot |
| 3. Continuous native Tern work | Workers receive work, finish it, and continue safely | `ompkit-kdbz.2.5`, `.2.6`, `.2.14`, `ompkit-rhy9.6`: native delivery, watcher qualification, goal restoration and restart reconciliation | Actual conversation delivery leads to useful work; paused/ambiguous targets remain protected; retries do not duplicate input; an active-goal flag alone earns no credit |
| 4. Portable and resilient defaults | Fresh installations work without our private fleet machinery | `ompkit-oq1h.2`, `.3`, `.4`, `.5`: optional fleet guards, safe compaction behavior, stock extension CI and truthful optional-tool health; bounded storage/recovery follows | Stock macOS/Linux consumers operate without private paths or mandatory fleet tools; invalid or unavailable dependencies remain explicit; recovery preserves live work |
| 5. Verified capability and ecosystem adoption | The broader native SDK and consumers genuinely use the released kit | Remaining `ompkit-kdbz.2.13` native SDK acceptance, `ompkit-oq1h.6` capability discovery, and broader `ompkit-774u.4` rollout | Native behavior is verified by API family and context; gaps remain explicit; each admitted consumer shows the new running code rather than just a new binary on disk |

### Cut selection and operating cadence

- **Current / next / later:** the director maintains one executing cut, one dependency-ready following cut, and the later waves above. Existing bead acceptance remains authoritative; this table neither closes beads nor weakens their checks.
- **Choose by effect:** unblock reliable delivery first, automatic consumer upgrades second, sustained worker throughput third. A dashboard or a larger planning document is not a substitute for those outcomes.
- **Per cut:** select a substantive, independently verifiable fix; save it to shared main; let CI and the train qualify its immutable SHA; publish; install and verify the running result; then advance the next cut. No empty bumps or rehearsal releases count.
- **Keep development moving:** unfinished working-tree edits stay untouched. Editing custody protects mutation of those files; publication judges the admitted committed snapshot. One failed cut is repaired forward without canceling unrelated healthy work.
- **Daily:** reorder the following cut using actual failures, upgrade lag, user impact and ready dependencies. Record the exact source, published result and installed/loaded result separately.
- **Weekly:** review commit-to-publish latency, publish-to-running latency, upgrade failures/recovery and reopened work. Change the order when those measurements expose a stronger bottleneck; do not wait for a weekly release day.
- **Five-cycle proof:** five consecutive substantive releases must each complete certification, signed publication and a real previous-to-new upgrade. Five tags, source-only saves or forwarding fixtures do not satisfy it.

Retire or replace each wave row when its outcome is delivered or superseded at the next roadmap review. The roadmap is not an additional approval loop and never delays a ready hotfix.

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
