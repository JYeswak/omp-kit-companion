### Fixed

- `omp-kit mcp test` reports `CALL_TIMEOUT` naming the bound and the `--call-timeout-ms` flag that raises it when a tool call outlives its bound, and records the bound used (`bound_ms`); a call that fails fast with an error stays `CALL_FAILED`.
