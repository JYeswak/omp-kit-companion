### Fixed
- Planning conversion dry-runs resolve the native br executable past seat policy shims only after isolated database admission, preserving the real seat identity and leaving the live tracker untouched. Apply continues through the seat shim and its actor admission checks.
