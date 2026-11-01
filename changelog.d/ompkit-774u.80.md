### Fixed
- Expired scratch quarantine uses a bounded, tree-size-aware inode/open-file check instead of a pathname snapshot. Cleanup retains held files and unavailable proofs, rechecks owners, users, hold eligibility and directory identity, and preserves released legacy-owner attribution.
