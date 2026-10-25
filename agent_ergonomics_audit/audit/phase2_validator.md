# Phase 2 validator

Consumer: ERGO1 audit acceptance and downstream phase 4 reporting. Supersede on the next scoring pass.

Executed the installed `tools/validate_scorecard.sh` against all 2,506 aggregated rows using GNU Bash, approved TMPDIR, closed/noninteractive subprocess capture, and a 600-second deadline.

Exit code: **0**. Elapsed: **318.634 seconds**. Full stdout:

```text
validate_scorecard: OK
```

Full stderr: empty. Exact argv, stdout, stderr, exit code and timing: `partial/phase2_validator_output.json`.

This validates artifact structure/evidence presence, not correctness of scores, independence, runtime truth, or agreement. Authentic source scorer disagreement remains: 56 surfaces have spread >=500 and 247 have spread 300–499. Rubric consensus remains HALTED; no gate was weakened and no tiebreaker fabricated.

The full aggregate script reached its 600-second deadline after 2,317 rows with empty stdout/stderr (`partial/phase2_aggregate_output.json`). The remaining 189 rows were completed through 189 documented explicit-surface invocations of that same unmodified script, each exiting 0 (`partial/phase2_aggregate_resume_output.json`). This is not a successful full-mode script run; it is a complete mechanical aggregation via its documented single-surface mode. No validator chunking or replacement was used.
