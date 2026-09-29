---
description: "Checklist A13: the solo attestation is honest and is not a review"
condition: '[Ii]ndependent[\s>*_]+review[\s>*_:]+not[\s>*_]+performed'
scope:
  - 'tool:edit(**/packet.md)'
  - 'tool:write(**/packet.md)'
interruptMode: never
---

This attestation is the correct, honest move. Keep it.

Do not replace it with a reviewer you did not run. Do not write "reviewed" or "review passed" in a report, a commit, or a close reason. CHECKLIST.md:119 says the machine only checks that the attestation exists. A marker pass is not a review, and inventing a reviewer is worse than the marker.
