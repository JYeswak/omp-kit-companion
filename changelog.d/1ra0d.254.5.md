### Added

- Planning score and `doctor --scope beads` accept one source-backed scope declaration in native bead `notes`, preserving original acceptance, ticks, proof classes and the existing file/component limits. Undeclared scope retains legacy behavior; invalid or understated metadata stays unverified, and known oversized work still fails.

One reserved notes line declares a genuine zero-source operation:

```text
Source-Scope: {"version":1,"kind":"operational","files":[],"basis":"Existing native readback only; no source, config or test changes"}
```

For code, configuration, tests or documentation work, use `kind:"code"` and the complete canonical repository-relative `files` list. A nonempty source `basis` is required; known contract paths are a lower bound. Replace the single declaration under native issue CAS rather than appending another. This declares scope, not completion or runtime proof; limits, weights and stages are unchanged.
