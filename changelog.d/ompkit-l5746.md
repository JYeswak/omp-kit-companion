### Fixed

- `SELF_CLOSE_REFUSED` now blocks the bead filer and every author of a DONE-first comment, even when another agent holds the assignment. Missing or malformed author metadata fails closed; an independent non-author can still close with evidence. (ompkit-l5746)
