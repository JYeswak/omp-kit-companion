### Fixed
- Avoid tail-window-only observation failures in large Tern journals by progressively widening reads, retaining fail-closed branch checks and per-read byte accounting.
