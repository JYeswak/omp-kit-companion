### Fixed
- Scratch planning and cleanup give open-file checks more time on a loaded host without changing fixed caller deadlines. A default check that times out under load retries once. If the evidence is still incomplete, cleanup preserves the directory and reports why.
