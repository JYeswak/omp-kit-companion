---
name: jeff-planning-enhanced
description: "Use for any planning in the fleet: turning an idea or mission into a markdown plan, reviewing the plan, converting it to beads, polishing beads, and scoring how a repo plans. Triggers: 'plan this', 'make a plan', 'plan to beads', 'polish beads', 'planning round', 'review the plan', 'are we converged', 'planning score', 'Jeff planning', '85% rule'. The fleet's one planning protocol (v2, 2026-10-05), built from Jeffrey Emanuel's official skills and scored by `omp-kit planning score`."
license: MIT
distribution: subscribers
---

# Fleet planning protocol (v2)

One protocol for every repo in the fleet. It is Jeffrey Emanuel's method as he publishes it, plus a short list of fleet additions, each marked **[fleet]** with the reason. Every step leaves a commit the scorer can read, so we can measure whether a repo plans this way and tune the thresholds in one file.

**Sources (Jeff's own, read 2026-10-05):** official skills `planning-workflow` v7, `beads-workflow` v5, `multi-agent-swarm-workflow` v3, `vibing-with-ntm` v20, `reality-check-for-project` v4, `beads-compliance-and-completion-verification` v21; his slb planning transcript (`jeff-corpus/slb/CLEANED_UP_INITIAL_PROMPTS.md`); his essay on overprompting (`jeffrey_emanuel_personal_site`); his X posts 2026-09-26 to 10-05. Evidence and measurements: `omp-test/var/agent-tmp/planning-retro/jeff-*.md`.

## The rule that matters most

**Do the expensive thinking in the plan, once. Convert once. Polish in place. Then build.** Rework costs about 1x in plan space, 5x in bead space and 25x in code space. The fleet's 2026-10-04/05 planning spent about 20 hours per repo reviewing beads in lanes, with a findings ledger and a coordinator applying fixes, and shipped nothing. That is the failure this protocol exists to prevent.

## When to skip

A small, local change (one bead, one file, an obvious fix) gets no plan: write the bead and build it. Planning overhead must not exceed the cost of the work.

## The pipeline

Every step is done by **one owner agent** (a worker: luna or muse; the Opus orchestrator dispatches and checks scores, it does not plan bead by bead). Each step ends with a commit whose subject starts with the tag shown, so `omp-kit planning score` can count rounds and measure diffs.

### 0. Ship guard **[fleet]**
Before a new planning cycle: main CI is green, and the repo's plan-to-ship ratio is under the configured limit (`omp-kit planning score` reports both). If not, build and ship existing ready beads first. Reason: on 10-04/05 omp-kit made 117 tracker commits against 4 code commits while main stayed red.

### 1. Reality check (existing projects)
Use `reality-check-for-project`: "Where are we REALLY on this project? Does the implemented code actually deliver on the vision described in the README and plan documents?" Its gaps feed the plan.

### 2. Write the plan (loose first)
One markdown plan per mission, in the repo: `PLAN_<MISSION>.md` at the root by default. A repo with an existing plan of record sets `[missions.<m>] plan = "<path>"` in `.omp/planning-score.toml`; the configured path overrides the default. Start from: goals and intent; user workflows; tech stack; architecture decisions; and the WHY. Don't over-constrain the first draft. Jeff: "when coming up with your plan, don't be too prescriptive to give the model flexibility so that you get the best possible plan." Commit: `plan(<mission>): draft`.

### 3. Review the plan: 4–5 rounds, in place
Each round, in a **fresh conversation**, a different model than the owner reviews the whole plan with this exact prompt:

```
Carefully review this entire plan for me and come up with your best revisions in terms of better architecture, new features, changed features, etc. to make it better, more robust/reliable, more performant, more compelling/useful, etc. For each proposed change, give me your detailed analysis and rationale/justification for why it would make the project better along with the git-diff style change versus the original plan shown below:

<PASTE YOUR EXISTING COMPLETE PLAN HERE>
```

The owner integrates the revisions with this exact prompt:

```
OK, now integrate these revisions to the markdown plan in-place; use ultrathink and be meticulous. At the end, you can tell me which changes you wholeheartedly agree with, which you somewhat agree with, and which you disagree with:
```

Commit: `plan(<mission>): review round N`. For big plans, optionally get competing plans from other models and blend them with the "Multi-Model Blend" prompt in `planning-workflow/references/PROMPTS.md`.

**Stop** when the round's diff is typo-level, not structural (the scorer measures the changed-line ratio of the last round against the configured limit). Usually after 4–5 rounds. There is no findings ledger and no coordinator apply step: the reviewer proposes, the owner integrates, in place.

### 4. Convert or reconcile to beads once
For a new mission, run this conversion once. For an existing mission, reconcile the current graph against the bridge plan: add only missing beads and polish in place; do not regenerate the graph.

```
OK so now read ALL of [YOUR_PLAN_FILE].md; please take ALL of that and elaborate on it and use it to create a comprehensive and granular set of beads for all this with tasks, subtasks, and dependency structure overlaid, with detailed comments so that the whole thing is totally self-contained and self-documenting (including relevant background, reasoning/justification, considerations, etc.-- anything we'd want our "future self" to know about the goals and intentions and thought process and how it serves the over-arching goals of the project.). The beads should be so detailed that we never need to consult back to the original markdown plan document. Put each bead's tests and acceptance criteria in its acceptance field (`br create/update --acceptance-criteria`), not in the description; the description does not restate them. Remember to ONLY use the `br` tool to create and modify the beads and add the dependencies. Use ultrathink.
```

New beads name their tests in their body; acceptance lives only in the `acceptance_criteria` field. Existing beads retain their filled field; do not copy acceptance into the description. Each bead names its plan file and section, with precise dependencies (Jeff: "self-contained, granular, hierarchical beads with corresponding tests and acceptance criteria"). A new mission commits one `beads(<m>): convert`; an existing mission commits one `beads(<m>): reconcile`. The scorer treats either as the single conversion event and rejects both.

**Existing repos.** The mission plan is a bridge from today's reality to the mission. Reconcile it against the existing graph rather than regenerating that graph. Link an existing bead covered by the plan to its plan section, or replace it and close the old bead as superseded. Park an existing bead not covered by the plan with a reason; do not delete it. List older plan documents the new plan supersedes and add a "superseded by" line at the top of each. Parked non-plan beads do not count toward polish metrics.

### 5. Coverage check against the plan (twice)
The plan is the oracle. Jeff's exact prompt, from his slb session:

```
ok now I want you to go back over the entire long markdown plan document and verify that we truly have captured ALL features, functionality, requirements, detailed, rationale, etc from the plan document in our beads. Use ultrathink. Also make sure that you have really correctly overlaid the entire dependency structure in all its nuanced complexity across all the beads.
```

Commit: `beads(<mission>): coverage check N`.

### 6. Polish: 6–9 rounds, same owner, in place
Exact prompt (`beads-workflow`):

```
Reread AGENTS dot md so it's still fresh in your mind. Check over each bead super carefully-- are you sure it makes sense? Is it optimal? Could we change anything to make the system work better for users? If so, revise the beads. It's a lot easier and faster to operate in "plan space" before we start implementing these things!

DO NOT OVERSIMPLIFY THINGS! DO NOT LOSE ANY FEATURES OR FUNCTIONALITY!

Also, make sure that as part of these beads, we include comprehensive unit tests and e2e test scripts with great, detailed logging so we can be sure that everything is working perfectly after implementation. Put each bead's tests and acceptance criteria in its acceptance field (`br create/update --acceptance-criteria`), not in the description; the description does not restate them. Remember to ONLY use the `br` tool to create and modify the beads and to add the dependencies to beads. Use ultrathink.
```

Commit after each round: `beads(<mission>): polish round N`. Keep acceptance only in `acceptance_criteria`; do not copy it into the description. **Stop** at steady state: the scorer measures the share of the mission's beads changed in the last round against the limit. If polishing flatlines early, start a fresh session (`beads-workflow/references/PROMPTS.md`, "Fresh Session Prompts"). Make the final round cross-model (the other worker model).

If unit and e2e coverage is unclear, run once: "Do we have full unit test coverage without using mocks/fake stuff? What about complete e2e integration test scripts with great, detailed logging? If not, then create a comprehensive and granular set of beads for all this with tasks, subtasks, and dependency structure overlaid with detailed comments."

**Bead size (every polish round).** A bead must fit one reserve → edit → test → commit → push → release cycle of minutes, not hours. Split any bead whose work would hold files longer than about 30 minutes, or touch more than a handful of files, into sibling beads with precise dependencies. Large beads are what keep files reserved and edits uncommitted for hours in a shared checkout.

### 7. Build, continuously
Workers claim ready beads with `bv` and build (`multi-agent-swarm-workflow`, `vibing-with-ntm`: fungible agents, the "code first" doctrine, no per-change full builds). There is no planning freeze for unrelated beads. When code reveals a plan error, fix the plan and the affected beads in place (one owner), and keep building the rest.
Claim from `bv --robot-next` (RERUN-REQUEST grades first); hold at most one bead at a time — release, with a handoff comment, before claiming the next **[fleet: one owner, one claim; parallel claims split focus and stall the ready queue]**.

Every change follows Jeff's cycle (agent-flywheel.com `/complete-guide`): "Pull latest, reserve files, edit and test, commit immediately, push, release reservation." All agents commit directly to main; "push after every commit (unpushed commits are invisible to other agents)." Reserve at the moment you edit, not for the whole bead, and release on push. Never stash, revert, overwrite or otherwise disturb another agent's work. One designated committer agent sweeps every 1–2 hours and commits whatever is left in logical groups without editing code ("Designating one agent prevents merge conflicts").

### 8. Verify against the beads — this is not a review round
Close needs the bead's own tests and acceptance passing at the exact pushed SHA, graded by someone other than the implementer **[fleet: uds's exact-SHA route and independent grade]**. Periodically, `reality-check-for-project` asks whether the code delivers the plan; after closes, `beads-compliance-and-completion-verification` audits that closed means done.

## Cheap mechanical checks **[fleet]**
Run on every `br` write, as reports, never as a review round: cycles and edge direction, priority inversions, pinned live values, placeholders, beads whose acceptance reads another bead's output without a dependency, and acceptance misplaced in descriptions (`omp-kit doctor --scope beads` flags a bead with an acceptance or tests section in its description and an empty `acceptance_criteria` field, naming the move). They cost seconds and remove the classes that took the fleet's reviewers hours. They never replace the plan rounds, the coverage check or polish.

## What not to do (measured on 2026-10-04/05)
| Don't | Instead |
|---|---|
| Review beads in lanes with a findings ledger and a coordinator applying fixes (three hand-offs per defect) | The owner polishes in place with the exact prompt |
| Converge on "two clean rounds" over a DAG that changes with every fix | Stop when the last round's diff is marginal |
| Freeze all building until planning converges | Build ready beads; fix the plan in place when code teaches you something |
| Copy governance text (approval rules, landing rules) into every bead | Put it once in AGENTS.md and the mission file |
| Spawn reviewer subagents on an unapproved model | Workers are luna or muse; Opus orchestrates only |
| Restating acceptance in the description | The two copies drift. Acceptance lives only in the `acceptance_criteria` field; coverage still checks beads against the plan |
| Hold reservations or uncommitted edits for hours ("holding reservations too long") | Reserve, edit, commit, push, release in minutes; split the bead if it can't |
| Build a commit from a tree older than origin/main | Pull latest before every edit; check `git show --stat` deletes only what you meant to |

## Scoring: `omp-kit planning score`
Reads the repo's git history, plan file and tracker; prints one JSON line per mission and an overall score. Thresholds and weights live in one file, so tuning means editing one number: kit defaults in `omp-kit/config/planning-score.toml`, with an optional repo override in `.omp/planning-score.toml`.

| Metric | Measured from | Default target | Weight |
|---|---|---|---|
| `plan_present` | configured plan file exists and mission beads cite it | yes | 1.0 |
| `plan_rounds` | `plan(<m>): review round N` commits; completion verification is not a review | ≥ 4 | 1.0 |
| `plan_last_diff` | changed-line ratio of the last plan review round | ≤ 0.05 | 1.0 |
| `converted_once` | exactly one `beads(<m>): convert` or `beads(<m>): reconcile` commit combined | yes | 1.0 |
| `coverage_checks` | `beads(<m>): coverage check N` commits | ≥ 1 | 1.0 |
| `polish_rounds` | `beads(<m>): polish round N` commits | ≥ 6, or steady earlier | 1.0 |
| `polish_last_changed` | share of the mission's non-parked-plan beads changed in the last polish round | ≤ 0.05 | 1.0 |
| `bead_self_contained` | median bead body length; share naming tests from `acceptance_criteria`; deps per bead | ≥ 300 chars; ≥ 0.4; ≥ 1.0 (Jeff's corpus: 48% name tests, 1.46 deps) | 1.0 |
| `plan_to_code_hours` | first plan commit to first cod

**Existing missions.** Set `[missions.<m>] stage = "build"` in `.omp/planning-score.toml` when the mission is already converted and building. It enters at step 7; plan, conversion, coverage and polish metrics (including plan-to-code time) are `NOT_APPLICABLE`, not failed. Bead quality, current plan-to-ship ratio and CI evidence remain scored.

**Repos without hosted CI.** In `.omp/planning-score.toml`, set `[ci] mode = "local"`, name the check command, branch and receipt directory. The scorer reads the latest receipt matching that branch head SHA; the receipt records `sha`, `exit_code` and `time`. It never runs the check command during scoring. No receipt for the current head SHA is `UNKNOWN`, never green. This is a per-repo CI mode, not a waiver.

**Weighted score.** Defaults assign weight 1.0 to every metric above. The weighted score is the percentage of applicable metric weight that passed; `UNKNOWN` is never counted as pass, and `NOT_APPLICABLE` metrics are excluded.e commit for the mission | ≤ 24 | 1.0 |
| `plan_ship_ratio_7d` | planning and tracker commits per code commit, last 7 days | ≤ 2.0 by default; repo override allowed | 1.0 |
| `main_green` | hosted CI or configured local receipt for the declared branch head | PASS; missing receipt/result is UNKNOWN | 1.0 |

`omp-kit planning score --fleet` runs it across every fleet repo and prints one row each, so every repo is graded the same way and the numbers can be compared week to week.