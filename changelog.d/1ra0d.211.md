### Added

- The daily `loop-close` service job now consumes every measured signal: it runs the gate-events ledger through the turnline refusal-code rules, files one retire bead per code silent 30 d, sends one REPORT mail when new codes appear in 7 d, runs `verify --live-readback --all`, and files one bead per service red for 24 h. Re-runs update, never duplicate (ompkit-1ra0d.211).
- The loop-close state file is registered in the ownership registry, so the release's writer audit accepts it.
