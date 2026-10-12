### Fixed
- RX1 literal probe no longer demands a content literal for exact vacuous `(?s).+` conditions scoped to tool write/edit: such a pattern matches everything in O(n), so a prefilter literal can never reject anything.
