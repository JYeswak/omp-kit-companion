### Added

- The idea-to-happy-product lifecycle is now a checked manifest (`docs/lifecycle.json`): one row per phase with its exit criterion, verbs, doc, test and turnline metric. `bun scripts/lifecycle-check.ts` validates the manifest and renders `docs/lifecycle.md` (CI fails on drift), and the daily loop-close job files or updates one bead per gap (`lifecycle:<phase>:<facet>`) and comments when a gap closes (ompkit-1ra0d.217).
- The generated lifecycle page no longer names a path from the private repo, so the README path lint stays green.
