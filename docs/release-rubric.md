# Release rubric (RELRUBRIC1)

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
- Apply at least one idea in this release, with a before and an after reading of its measure on the
  same producer. "Applied" means it is landed and installed, not filed.
- The ideas you don't apply are carried into the next card with a decision: next, later or dropped,
  and the reason.
- An idea comes from evidence: a profile, the gate-events ledger, a mined failure class, or prior art
  outside this repo. It is never a guess.
- Basis: Shape Up schedules a cool-down after every cycle. In it, people "fix bugs, explore new ideas,
  or try out new technical possibilities", and a bet "has a cap on the downside"
  (https://basecamp.com/shapeup/2.2-chapter-08, read 2026-11-05). DORA's improvement loop: "Have the
  whole team commit to making an improvement in the most significant constraint or bottleneck ...
  Check your progress ... Repeat" (https://dora.dev/guides/dora-metrics-four-keys, read 2026-11-05).

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

A cut is a wave, and is refused, when its card shows no closed gap bead and no applied idea with a
measured change. Version bumps, notes-only promotions and re-cuts of the same content are waves.
