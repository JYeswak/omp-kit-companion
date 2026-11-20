### Fixed

- `omp-kit land --apply` and the other tool-gated applies now refuse `CONSENT_REQUIRED` (exit 2) when `--yes` is absent, before a missing native tool is reported, so the consent refusal no longer depends on which tools a host has. The `--yes` and preview paths keep their exit-3 tool refusals.
