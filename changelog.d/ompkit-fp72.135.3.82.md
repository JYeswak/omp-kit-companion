### Fixed
- `br` admission now reaches Python and Bun subprocesses through the verified release shim. Review entry runs full lint and phase checks; create admission applies replayability lint. `doctor --scope gates` exercises review, claim, and create refusals on an owned tracker fixture without live tracker writes.
