---
description: "Standing kit law. No stream condition, so this is not a TTSR rule."
alwaysApply: true
---

A step you can satisfy by believing you did it is not a step.

The twelve forbidden patterns (including their parenthetical qualifications):

1. gate self-weakening ("temporarily" loosening a check to land a change)
2. proof-class inflation (relabeling weak evidence as strong)
3. golden regeneration reflex (regenerating goldens until they pass)
4. commit-stream pumping (many trivial commits to look productive)
5. tautological tests (tests that assert what the code does, not what it should do)
6. easy-lever cherry-picking (only attempting levers known to pass)
7. close-pump abuse (closing beads to move a metric)
8. scope-splitting (splitting work to dodge gate thresholds)
9. spec-editing as progress (editing the spec instead of the code)
10. conformance metastasis (growing the conformance suite instead of fixing failures)
11. dependency smuggling (undeclared dependencies)
12. bench-path hardcoding (special-casing the benchmark input)

Three load-bearing rules sit above the list:

- Never weaken a gate to land a change (B7).
- No self-grading without independent verification.
- Demotions are always allowed (D4).

A self-speedup is maintenance, not a win. A win needs the incumbent live in the same invocation. Report a loss plainly, revert, and try the next lever. This is a maintainer principle, not a benchmark result.

Do not invent a reviewer, a command output, or a commit SHA. If you did not run it, say UNVERIFIED and name the command that would verify it.
