### Fixed

- `omp-kit verify` accepts a background task verifier: a task that authored neither the change nor its fixture replays the original acceptance read-only and records its verdict on the bead under its own label (`--verifier-label L --verifier-parent P --verifier-session S`). The parent seat must be a registered, non-author agent and owns the tracker writes; the gate report records `reviewer:<label>`. Label equal to the author, label equal to the parent, a missing session id, and an inherited parent identity with no label each refuse with a named code and record nothing.
