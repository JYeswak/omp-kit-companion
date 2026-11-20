### Changed

- The release verdict now judges every Bun test under `extensions/` and `src/` and the `tests/kit-gate` Python suite, not only `tests/cli` and `tests/fleet-guard`. Those 55 files ran in no CI group, so a regression in them could not stop a release; a failing test under any of those roots now fails the verdict and is named. Verdict records written before this change no longer match the declared suite and are rejected, so the next release needs one fresh main-role run.
