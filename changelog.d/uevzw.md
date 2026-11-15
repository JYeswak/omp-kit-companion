### Fixed
- On a handled verify-act failure, restore provable parent acceptance before withdrawing only the attempt's unchanged live readback with native compare-and-swap. Preserve uncertain or peer-modified state and report the rollback failure.
- Retry a withdrawn readback only against its exact recorded revision and the current parent obligations. Operator pauses and peer edits remain untouched; unhandled crash orphans are not automatically recovered.
