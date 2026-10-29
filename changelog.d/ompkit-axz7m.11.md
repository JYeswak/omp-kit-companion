### Fixed

- Ratchet real-withdrawal inputs now prove path-set equality and per-path blob identity against the manifest before any replay runs, and planted corrupted-blob or dropped-path capsules fail closed with no fixture created. Fixture Git calls keep the caller's `GIT_CEILING_DIRECTORIES` so no enclosing checkout can leak into the replay. (ompkit-axz7m.11)
