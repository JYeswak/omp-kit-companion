# Release rubric (RELRUBRIC3)

Every kit release is cut against this rubric. A cut that fails it is not a release, even if every
test is green. This was decided by Joshua, J-2026-11-05-03: "every release should identify at least
1-3 novel ideas to truly optimize our systems, with at least 1 applied to next release. this
prevents us ... from getting caught in useless release waves ... even if it slows releases down a bit".

Each release has a card at `docs/releases/v<version>.md`. The card is written before the cut and
completed with the after-measures. It has the five parts below.

## 1. Gap lane: what broke since the last release

- List every defect class found since the previous tag: refused commits diagnosed, red mains,
  incidents, escaped defects, and each `tool-error` or refusal class that grew. Give each one a bead id.
- At least one gap bead closed by a non-author ships in this release.
- Every gap not fixed in this release carries an owner and the release it is aimed at.
- Basis: Google SRE error budget policy, outage policy: "If a single incident consumes more than 20%
  of error budget over four weeks, then the team must conduct a postmortem. The postmortem must
  contain at least one P0 action item to address the root cause."
  (https://sre.google/workbook/error-budget-policy/, read 2026-11-05).

## 2. Optimization lane: 1 to 3 novel ideas, at least one applied

- Name 1 to 3 ideas that would change a measure of the system, not just fix one more instance of a
  known defect. For each, give the hypothesis, the measure it should move, and where the data comes from.
- Land and install at least one idea in this release, with a before and an after reading of its measure on the
  same producer. From v0.2.95, label its evidence class below: a mechanism verification is not an applied field effect.
- The ideas you don't apply are carried into the next card with a decision: next, later or dropped,
  and the reason.
- An idea comes from evidence: a profile, the gate-events ledger, a mined failure class, or prior art
  outside this repo. It is never a guess.
- Basis: Shape Up schedules a cool-down after every cycle. In it, people "fix bugs, explore new ideas,
  or try out new technical possibilities", and a bet "has a cap on the downside"
  (https://basecamp.com/shapeup/2.2-chapter-08, read 2026-11-05). DORA's improvement loop: "Have the
  whole team commit to making an improvement in the most significant constraint or bottleneck ...
  Check your progress ... Repeat" (https://dora.dev/guides/dora-metrics-four-keys, read 2026-11-05).

### Evidence classes (RELRUBRIC3, from card version 0.2.95)

| Class | What the evidence supports | Decision / verdict words |
|---|---|---|
| **MECHANISM** | A deterministic fixture or mutant pair proves “the code does X” on the stated inputs, not an outcome on the fleet. | **MECHANISM VERIFIED** |
| **FIELD EFFECT** | A measurement on real seats, with the comparison, treatment assignment or verified exposure, controls, power and assumptions stated. | `applied, effect` / **SHIPPED** |

A single pair with `sigma_d: 0`, or an explicit fixture or mutant arm, is MECHANISM regardless of how large its
before/after difference is. Repeating a fixture does not turn it into FIELD EFFECT. A fixture's number of repaired
paths, or a mutant's failure count, is not the real seats' failure rate. Only FIELD EFFECT may use SHIPPED or
`applied` as an effect claim; bare `applied` is treated as an effect claim too. A MECHANISM VERIFIED idea may satisfy
the release's landed-and-installed idea requirement without claiming an effect. Neither class waives the ship gates.

For FIELD EFFECT, name the real seats, comparison and outcome denominator; record how treatment was assigned or
when exposure was verified (a commit time alone is not activation); justify unaffected controls, power for the MDE,
and assumptions about dependence, workload and spillover. The checker detects the mechanism signatures below; an
absence of those signatures is not independent verification that a field design or its causal assumptions are sound.

Sequential tests need a declared null, alternative and beta (type-II error). Per-observation confidence sequences
are not valid on autocorrelated fleet series: the frozen spike found false-positive rates up to 0.590 on matched
Markov series and 0.680 on block-resampled history at alpha 0.05. Use a dependence-justified observation unit and
analysis, not an iid confidence sequence applied to every ledger row. Source: `omp-kit/docs/research/relrubric3-2026-11-05/stats-spike.md`
(RUBRICSTATS1, ompkit-fp72.120.16.290, 2026-11-05, “Conclusion”: “Applied per observation to our autocorrelated series,
the CS is **not** anytime-valid.”).

The reviewer panel is **not adopted**: the benchmark found no measured benefit. In the post-pilot primary analysis,
plain versus retrieval-augmented balanced accuracy was 0.750 versus 0.744, with one plain-arm parse failure retained.
This small synthetic benchmark does not establish either reviewer as a release gate. Source: `omp-kit/docs/research/relrubric3-2026-11-05/panel-bench.md`
(PANELBENCH1, ompkit-fp72.120.16.291, 2026-11-05, “Results”: “No superiority conclusion is supported.”).


## 3. Measures before and after: DORA five, read from our own producers

| DORA metric | Our producer | Direction |
|---|---|---|
| Change lead time | push of the release source → installed reconcile, from the release log and receipts | down (target 4 min, J-40/J-50) |
| Deployment frequency | published GitHub releases per window (`gh release list`; tag dates are source-commit times, not publication) | steady, at least every 12 h |
| Failed deployment recovery time | PARTIAL or failed install → reconciled, from release-local and update receipts | down |
| Change fail rate | releases needing rollback, reconcile or a hotfix within 24 h ÷ releases | down |
| Deployment rework rate | unplanned releases forced by an incident ÷ releases | down |

Read the counter-metrics too: the full-suite PASS rate on the last 10 exact trees, the gate refusal
share, beads closed against beads created, reopens, and escaped defects.

DORA warns against "Setting metrics as a goal" and "Having one metric to rule them all"
(https://dora.dev/guides/dora-metrics-four-keys). No single number cuts or blocks a release on its
own; the card shows them all side by side.

## 4. Error budget: when only reliability work ships

- If the trailing 7 days' change fail rate is above 1 in 3, or main has been red for more than 12 h in
  that window, the next release is gap-lane only. It still has to apply one optimization idea, and
  that idea must target the failure class.
- Basis: the SRE policy: "we will halt all changes and releases other than P0 issues or security
  fixes until the service is back within its SLO ... Changes are a major source of instability,
  representing roughly 70% of our outages" (https://sre.google/workbook/error-budget-policy/).

## 5. Ship gates (unchanged, plan section 22 step 8)

- A full-suite PASS and a CI-only PASS on the exact source tree.
- An installed canary, a loaded-code witness, and a rollback path or a recorded reason why not.
- The train's named measures are read before and after the roll.

## Wave test

A cut is a wave, and is refused, when its card shows no closed gap bead and no verified idea with a measured change
(MECHANISM VERIFIED or a SHIPPED FIELD EFFECT from v0.2.95). Version bumps, notes-only promotions and re-cuts of the
same content are waves.

## Card grammar (RELCARD1, enforced)

`scripts/release-local.sh` runs `scripts/release-card-check.py --repo DIR --rev SHA --version X.Y.Z` before a prepare
push and again on the exact source commit, before the signing keychain opens. The checker reads the card with
`git cat-file blob SHA:docs/releases/vX.Y.Z.md`, never from the working tree, and refuses with one line:

- `RELEASE_CARD_MISSING`: the source commit has no card.
- `RELEASE_WAVE`: no gap row is closed or landed and no idea is applied with a measured change (Wave test).
- `RELEASE_CARD_INCOMPLETE section N (title)`: section N below fails its rule; the line says which rule.
- From card version 0.2.94 (RELPREREG1): `RELEASE_PREREG_MISSING`, `RELEASE_UNDERPOWERED`, `RELEASE_INCONCLUSIVE`,
  `RELEASE_NO_EFFECT` or `RELEASE_REGRESSED` when an applied idea's preregistered experiment does not reach its
  admissible verdict (Preregistration grammar below).
- From card version 0.2.95 (RELRUBRIC3): `RELEASE_EVIDENCE_CLASS` when MECHANISM evidence claims SHIPPED/applied as an
  effect, or when MECHANISM VERIFIED has no supporting mechanism signature.

The grammar is deliberately small:

- A section starts at a heading `## N. Title` and runs to the next `## ` heading. The titles must start with
  `Gap lane` (1), `Optimization lane` (2), `Measures` (3) and `Error budget` (4).
- Each rule reads the section's first pipe table: a header row, a `|---|` row, then data rows. Cells split on `|`;
  `*` and backticks are ignored when a cell is compared. Columns are found by the start of their header text.
- Section 1: at least one row's `State` cell starts with the word `closed` or `landed`.
- Section 2: the table has 1 to 3 data rows (ideas), and at least one `Decision` cell starts with the word
  `applied` and records a measured change `X → Y`: a number, optionally followed by a unit word, an arrow (`→` or
  `->`), and a number. Only a cell's first 2000 characters are read. From v0.2.95 a Decision may instead start with
  `MECHANISM VERIFIED` for mechanism evidence (or `SHIPPED` for FIELD EFFECT); its measured change is read from the
  preregistered Result, not required in the Decision cell.
- Section 3: a `Before` column exists, at least one row is a DORA row, and every DORA row has a non-empty Before.
  A DORA row's first cell starts with `Change lead time`, `Deployment frequency`, `Published releases`,
  `Failed deployment recovery`, `Change fail rate` or `Deployment rework rate`.
- Section 4: the section exists and has at least one non-blank line.

### Preregistration grammar (RELPREREG1, enforced from card version 0.2.94)

Joshua J-2026-11-05-05 (RELRUBRIC2). Cards for v0.2.92 and v0.2.93 were cut before this rule and are judged by the
rules above only; they are not migrated. From v0.2.94 every section-2 row whose `Decision` starts with `applied` (no
`X → Y` needed) is a preregistered paired experiment. For historical v0.2.94 only a SHIPPED verdict satisfies
`applied`; published cards through v0.2.94 keep their treatment. The pending v0.2.95 card is not historical: from
v0.2.95 the same blocks are required for MECHANISM VERIFIED
and SHIPPED decisions, with the evidence-class ceiling above. The idea's id is the first word of its `Idea` cell
(`**PYCACHE1** (…)` → `PYCACHE1`). Section 2 holds two blocks per credited idea; each runs from its `### ` heading to
the next `### ` or `## ` heading, and a repeated block is refused.

- `### Prereg <id>`: `key: value` lines (fences, blank lines and `  # comments` ignored; an indented line continues
  the previous key) with every field `endpoint`, `direction` (`lower` or `higher` is better), `producer` (the exact
  replayable command), `unit` (its first word is printed), `mde` (> 0, absolute), `mde_source`, `sigma_d` (≥ 0, SD of
  the paired differences), `sigma_source`, `alpha` (two-sided), `power`, `n_pairs` (integer), `stopping` and
  `control`. Numbers may lead with `~`/`≈`, use a Unicode minus `−`, and carry a unit word. A missing or invalid
  field refuses `RELEASE_PREREG_MISSING`.
- The checker recomputes n = ⌈σ_d² (z₁₋α/₂ + z_power)² / mde² + z₁₋α/₂² / 2⌉ (at least 2), or n = 1 when
  `sigma_d` is 0 (a deterministic count). `n_pairs` below it refuses `RELEASE_UNDERPOWERED`. From v0.2.95, n = 1 and
  `sigma_d: 0` classify the result as MECHANISM, never a powered field-effect estimate.
- `### Result <id>`: an `ncpu: N` line and a pipe table with `before`, `after`, `load1_before` and `load1_after`
  columns, one row per pair. Retain every reading, including high or changing load, with a `cause` column naming
  the observed consumer(s), owner and diagnosis (or explicitly `unknown`). No reading is VOID or replaced for load.
  Fewer pairs than `n_pairs` (or no Result block) refuses `RELEASE_UNDERPOWERED`; more refuses
  `RELEASE_INCONCLUSIVE` (fixed-n stopping). Load does not waive power, effect or evidence-class requirements.

- d = before − after (`lower`) or after − before (`higher`), so a positive d is an improvement. The CI is
  d̄ ± t₁₋α′/₂,ₙ₋₁ · s_d/√n with α′ = alpha / (number of credited ideas) (Bonferroni). The t quantile is computed with
  the standard library (regularized incomplete beta) and matches the published table to 4 dp.
- Verdict: **SHIPPED** for FIELD EFFECT when the CI's lower bound > 0 and d̄ ≥ mde/2; **REGRESSED** when its upper
  bound < 0; **NO EFFECT** when it lies within (−mde, +mde); **INCONCLUSIVE** otherwise. They refuse
  `RELEASE_REGRESSED`, `RELEASE_NO_EFFECT` and `RELEASE_INCONCLUSIVE`. A deterministic endpoint (`sigma_d: 0`)
  meets its numerical threshold when d ≥ mde; if its differences vary, it refuses `RELEASE_INCONCLUSIVE`.
- From v0.2.95 the checker also classifies an explicit `fixture`/`mutant` arm in the preregistered `endpoint`,
  `producer`, `sigma_source` or Result block as MECHANISM, even with multiple pairs or nonzero SD. A mechanism
  meeting its numerical threshold returns **MECHANISM VERIFIED**, without a population CI. Its Decision must say
  `MECHANISM VERIFIED`, not SHIPPED/applied; a SHIPPED Result verdict is refused too. Controls alone do not reclassify
  a real-seat primary comparison. Numeric thresholds and load/stopping rules remain in force for both classes.
- Historical example: PYCACHE1's “pyc writes per create 62 → 0” (`sigma_d: 0`, `n_pairs: 1`, mde 10 writes) earned
  SHIPPED under RELPREREG1. Under RELRUBRIC3 the same pair can earn only **MECHANISM VERIFIED**.
- The pending v0.2.95 card's DIRECTORREACH1 is MECHANISM: one deterministic fixture/mutant pair, failed paths 2 → 0.
  Its former `applied` Decision is refused `RELEASE_EVIDENCE_CLASS`; its corrected MECHANISM VERIFIED reading is
  n=1, mean d 2 paths, s_d 0 paths, mde 1 path. The live field effect remains unmeasured until the post-install canary.

### Load admission and diagnosis (LOADADMIT1, J-2026-11-06-12/13)

Run measurements and release work through `omp-kit heavy --label <measurement-or-release> -- <producer>`.
The existing admission limit is load1 > 2.5 × logical cores. Above it, heavy reports `LOAD_DIAGNOSIS` and
`LOAD_CONSUMER` records before deferring or retrying; it does not start the producer. `omp-kit load watch --json`
exposes the same process census. Each record names pid, command, owner seat/session or service/cron ancestry,
elapsed seconds (null when unreadable), state and cause class. Unattributed owners stay explicit.

Inspect leftovers first: expired registered kit work, suspended/orphaned builders or verdicts, zombie parents
(including loop-sentinel's unreaped children), and day-old per-session sympy-mcp, mcp-z3-prover and mathlas-mcp
candidates. Age alone is not proof that a session or MCP server is abandoned. The census records cause classes,
so high-load samples with leftover candidates can be counted without claiming that age establishes causation.

New kit work stays queued. Expired registered kit children are sent SIGTERM only after rechecking their ledger
custody and process start identity; running heavy jobs retain their existing runtime cap and escalation.
Foreign or unbudgeted work is reported for its named owner, never killed by a command-name match.
Do not restart loop-sentinel or terminate another seat's MCP server merely because it is old.
Resolve the diagnosed load, then let heavy admit the producer. `--no-wait` diagnoses and returns 75 instead
of silently running above the threshold. Admission snapshots, including every process and its load/cause,
are kept in the existing load-watch census files; carry their named causes into the card alongside the readings.
