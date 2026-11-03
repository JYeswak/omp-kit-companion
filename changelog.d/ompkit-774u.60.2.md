### Fixed
- Planning conversion dry-runs resolve the native br executable past seat policy shims only after isolated database admission, preserving the real seat identity and leaving the live tracker untouched. Apply continues through the seat shim and its actor admission checks.
- SHIMDRYRUN1: a dry-run aimed at a database outside its owned directory is refused at admission, before any native br is resolved.
