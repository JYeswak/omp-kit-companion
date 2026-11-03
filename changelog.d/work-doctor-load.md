### Fixed
- Work-scope doctor Git probes now allow four seconds by default, with measured headroom for loaded machines, while preserving explicit `--timeout-ms` overrides and UNKNOWN results when evidence cannot be obtained.
- Heavy-work disk checks now stop an unresponsive `sbh check` after four seconds, clean up its process group, and report the observer as unavailable instead of waiting indefinitely.
