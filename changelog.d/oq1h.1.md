### Fixed
- Heavy disk admission works without sbh: OS-native statfs default on the cwd with sbh as an auto-detected adapter; CI no longer installs sbh and asserts its absence. (ompkit-oq1h.1)
- Statfs verdict is a pure injected-boundary decision (no environment seam); unit matrix covers it hermetically.
