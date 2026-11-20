### Changed

- The `br` shim's in_review handoff admission (`HANDOFF_UNGATED`) now also requires the DONE source to be on `origin/main` when its repository has an `origin` remote, so `in_review` means a non-author can verify it now. Only the local remote-tracking ref is read (no network); the refusal points at `omp-kit land`, `omp-kit land --exact-parent` and `git fetch origin main` for a push made from another checkout. A repository without an `origin` remote is unchanged.
