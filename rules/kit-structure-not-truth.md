---
condition:
  - 'READY:\s*all\s+\d+'
  - '(?i)\bpacket\s+(?:is|was)\s+(?:now\s+)?(?:execution-)?ready\b'
  - '(?i)\bstructure-green\b'
  - '(?i)\bexecution\s+sign-?off\s+(?:is\s+|was\s+|has\s+been\s+)?(?:done|complete|given|granted|received|obtained|recorded|in\s+place)\b'
  - '(?i)\b(?:got|have|has|received|obtained|recorded)\s+(?:the\s+)?execution\s+sign-?off\b'
scope: text
interruptMode: never
---
A readiness pass is structure, not truth. A READY line with the full section count means the markers and the vocabulary are present. It does not mean the sentences match the files they cite.

Measured 2026-09-23 on `notes/foundation-packet-p5.md`: the zip checker exited 0, and the draft still named a host `foundation/CALIBRATION.md` does not contain, score-path `118180e` (the README says `118185e`), and sixteen gate stages (the directory is not sixteen). Those three sentences were not adopted into `foundation/kit/packet.md`.

Before you repeat a number from a packet, README, or callback, open the cited file. A MATCH row is not a sign-off.
