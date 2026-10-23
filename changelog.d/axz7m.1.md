### Fixed

- Native planning conversion accepts legacy lettered criteria and scoped canonical checkboxes, including compound scope tags, without losing explicit progress (ompkit-axz7m.1; CONVERTCHECKBOX1 ompkit-axz7m.4).
- Newly converted criteria and generated mission epics satisfy canonical bead-lint admission. Logical amendment identity ignores checkbox progress and equivalent scope spelling; repeated contributions no longer duplicate criteria or reset checked state.
- Preserves stale-acceptance and native revision fences. Removes obsolete null snapshot fields that are no longer in `PlanningScoreSnapshot`.
- Verification: `bun test tests/cli/planning-convert.test.ts` — 52 passing tests, including failing-before/passing-after converter/admission and idempotence cases. This is source-candidate evidence, not a claim that the installed CLI was upgraded.
