### Changed
- Fleet Watch now refuses tracker recovery when the one-family artifact bound is met, reports `WAL_QUARANTINE_GROWTH`, and leaves artifacts for safe cleanup; beads_rust#532 remains unconfirmed.
- Tracker recovery rejects symlinked run entries and wrong-type recovery artifacts before admission, returning `RECOVERY_BLOCKED` with zero native calls (commit 60c7e60).
