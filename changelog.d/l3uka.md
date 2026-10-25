### Fixed

- Heavy admission wait no longer limits admitted child runtime. Runtime budgets use `--max-runtime`, then `load.json`'s per-label `runtime_budget_s`, then `default_runtime_s` (10800 seconds); exceeded budgets terminate the child, escalate to SIGKILL after 10 seconds, and return 124 rather than admission deferral 75.
