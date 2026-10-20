### Fixed
- kit-flywheel-guard no longer writes a close token that is not a bead id (an unexpanded `$b`, a reason sentence read as an id) into a closeguard record's `bead`. Refused-close records keep the refusal without `bead`, and receipts skip it with a notice, so neither dead-letters at command-center ingest (CLOSEGUARDBEAD1, ompkit-5vi6p).
