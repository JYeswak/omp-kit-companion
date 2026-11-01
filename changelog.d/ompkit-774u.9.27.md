### Fixed
- Add hourly OMP session transcript retention. Old regular JSONL files are removed only when CC's exact session cursor matches their identity and size and its committed source tick confirms the same error-free, zero-backlog byte frontier; otherwise they are kept. Deletions are fsynced to a private journal.
