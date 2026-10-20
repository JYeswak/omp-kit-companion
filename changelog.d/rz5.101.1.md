### Fixed
- Fleet restart never respawns a pane while a git process runs under it: panes with a running git child are deferred with reason to the next pass instead of risking a holder-less index.lock.
