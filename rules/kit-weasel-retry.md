---
description: "Kit A5/B4: every ledger REJECT needs a testable retry predicate"
condition:
  - '(?i)retry predicate:?\**:?[ \t]*(?:later|tbd|n/?a|none|todo|\?|-)?[ \t]*\.?[ \t]*\r?\n'
  - '(?i)retry predicate:?\**:?[ \t]*(?:later|tbd|n/a|todo)\b'
scope: "tool:edit(**/NEGATIVE_EVIDENCE.md), tool:write(**/NEGATIVE_EVIDENCE.md)"
interruptMode: always
---
**Blocked before it was written.** Your last edit to `NEGATIVE_EVIDENCE.md` has an empty or weasel-word retry predicate. The file was not changed. Do not re-issue the same edit.

The retry predicate is empty or a weasel word. The pre-commit hook will reject this row anyway; fix it now.

A retry predicate is an observable condition under which the rejected idea is worth re-testing, e.g. "when the A/A null on worker X is < 2% for 3 runs" or "when upstream crate Y >= 0.9 ships Z". Never "later", "TBD", "n/a".
