### Fixed
- Fleet guard drops cached reservation lookups when a release call passes through (MCP tool or `am file_reservations release` parsed source-aware, so quoted mentions never clear), so an edit right after releasing re-queries instead of seeing a stale allow.
