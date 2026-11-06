### Fixed
- Release SBOMs now list versioned Bun native libraries, the pinned Tern SDK and runtime lockfile dependencies instead of scanning an opaque archive directory. Attestation uses each archive's build-time inventory, including after Darwin signing; invalid lockfile inputs refuse generation.
