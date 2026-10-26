### Fixed
- Hook chains and commit preflight honor members' shebangs, retain shell fallback for scripts without one, and report real policy refusals.
- Hook installation atomically replaces files so already-running hooks finish on their original bytes.
- The staged README check skips repositories without a README obligation while still refusing deletion of a required README.
