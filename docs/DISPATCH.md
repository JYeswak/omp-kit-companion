# Dispatch format (D lines)

A work dispatch is a message whose first token is `D`, or any message with
a `queue:` line. `dispatchBeads` (src/send.ts) extracts cited bead ids.

D-line shape: `D AM<id> <slug> [rest ...]`.

- The `AM<id>` token is a mail reference and never counts as a citation.
- Every other token scans: a token counts when it matches the bead shape
  and its prefix is a known tracker (fleet-watch repos,
  `OMP_KIT_BEAD_PREFIXES`, or the nearest `.beads`).
- In particular a known-prefix bead id in the slug position counts:
  `D AM50109 uds-bhd: read it` cites `uds-bhd`. Unknown-prefix words
  (e.g. `follow-up`) never count, with or without a prefix list.
- `D <bead> ...` without an AM id also cites: `D ompkit-d2hs (P1, ...)`
  cites `ompkit-d2hs`.
- Names after `queue:` never count.
