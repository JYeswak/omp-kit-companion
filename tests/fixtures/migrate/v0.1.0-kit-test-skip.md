---
description: "Forbidden patterns 1 and 5: do not silence a failing test to get green"
condition:
  - '#\[ignore\b'
  - '\b(it|test|describe)\.skip\('
  - '\bx(it|describe)\('
  - '@pytest\.mark\.(skip(?:if)?|xfail)\b'
  - '@unittest\.skip'
  - '\bt\.Skip(Now|f)?\('
scope: "tool:edit(**/*), tool:write(**/*)"
interruptMode: always
---
**Blocked before it was written.** Your last edit adds a skip or ignore marker to a test. The file was not changed. Do not re-issue the same edit.

You are adding a skip/ignore marker to a test. Under AGENTS.md this is gate self-weakening (pattern 1) unless the skip is the honest state of the world.

Allowed only if ALL of these are true, stated in the same edit: (1) the skip names a bead id that tracks re-enabling it, (2) the reason is an external precondition (missing credential, unavailable hardware), not "it fails", (3) the bead's close criterion is the test running green. Otherwise revert the skip and fix the code, or record the failure in docs/evidence/NEGATIVE_EVIDENCE.md and leave the test red.
