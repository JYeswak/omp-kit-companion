### Fixed
- Enforce the declared milestone cut at native preflight, agent guard, and shell claim admission: only pinned work or open blocking prerequisites can be claimed; outside a declared milestone, claims require a pillar label.
- Shell claims now require a conclusive, current cut-admission verdict rather than silently bypassing an unavailable or older preflight implementation.
