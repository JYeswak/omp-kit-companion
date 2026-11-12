### Added

- `omp-kit verify` now appends the close lesson to the verified repo's `.omp/lessons.jsonl` on every CLOSED verdict (export and live-readback), deduplicated by bead, so the learn loop is fed by default. REWORK, PENDING, dry-run, and failed closes write nothing.
