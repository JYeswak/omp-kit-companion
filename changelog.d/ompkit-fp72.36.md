### Fixed
- Cold-LSP CI diagnostics: the `one alternative root marker` readiness test prints the probe report (status, reason, timeout observation, selected server, omp rc, JSON-RPC trace) only when the status is not `PASS`, so the next cold-start `INCOMPLETE` names its stage. The real cold request stays the positive control; no warm-up, no budget change.
