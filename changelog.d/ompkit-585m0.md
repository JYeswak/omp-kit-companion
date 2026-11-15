### Fixed

- A scratch dir whose release marker parses is treated as released even when the current `.owner` text drifted (rehome rewrite, inherited ovnfs copy): `scratch mine` and the save guard omit it, and a second release reports `already-released` instead of refusing with `release-marker-already-present`. A marker that does not parse is completed with a fresh marker instead of refusing.
