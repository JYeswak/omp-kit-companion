### Changed

- PLANPORT1 (bead ompkit-f1zn5): `omp-kit planning score` finds a repo's
  comprehensive plan from `<repo>/.omp/plan.toml` `[plan]` (`name`, `path`,
  `reviews`), the config the omp-kit plan tooling reads, and scores it as
  mission `<name>`. Its `plan_rounds` counts review rounds from the review
  files (distinct `round<label>-*.md` names plus `findings.jsonl` `round`
  fields), falling back to `plan(<name>): review round N` commit subjects
  only when the review dir has none; `plan_last_diff` is the plan's change
  in the commit that recorded the latest round. `OMP_KIT_PLAN_CONFIG=PATH`
  scores a repo against a plan config kept outside it. On omp-kit the
  comprehensive plan now scores 41.67 (plan_present PASS, 749 citing beads;
  plan_rounds 5 from review files 1, 2, 3, 4, 4b; plan_last_diff 0.0036)
  instead of being invisible; the other missions' scores are unchanged.
  A missing override, malformed config or plan path outside the repo is
  `UNKNOWN` naming the reason. Pinned by three tests in
  `tests/cli/planning-score.test.ts`. (ompkit-f1zn5)
