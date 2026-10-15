# Release-path profile — 2026-10-15

**Bead:** `ompkit-d2hs`

**Consumer:** the maintainer deciding whether the `ompkit-d2hs` release-path changes satisfy the latency acceptance.

**Feature gated:** reuse exact-SHA green CI evidence and remove non-gating probes from the publication path.

**Observed defect class:** release candidate work repeated already-green CI jobs on the same commit; one serial macOS job dominates the candidate wall time.

**Deletion condition:** remove this profile after `ompkit-d2hs` is independently closed and its release-path optimization is no longer being evaluated against this baseline.

**Method:** job wall times are GitHub job `startedAt` to `completedAt` in UTC on the green candidate run below. “Critical path” means the job that outlasted its required parallel siblings. Links go to the job’s GitHub Actions evidence. Baseline run: `38704392791` (Unpublished release candidate, success, dispatched 08:15:39Z, wall 21m10s). Push-CI reference: `38750203397` (push, failure, wall 30m54s).

| Workflow job | Observed wall | Critical path? | Evidence |
| --- | ---: | --- | --- |
| Release `native-candidate / real-home-journey (darwin-arm64-none, macos-15)` — run 38704392791 | 19m31s; success | Yes; longest required job | [job log](https://github.com/JYeswak/omp-kit-companion/actions/runs/38704392791/job/116320490028) |
| Release `native-candidate / cli-contracts (macos-15)` — run 38704392791 | 18m00s; success | No; finishes 2m before real-home-journey | [job log](https://github.com/JYeswak/omp-kit-companion/actions/runs/38704392791/job/116320230322) |
| Release `native-candidate / real-home-journey (linux-x64-gnu, ubuntu-24.04)` — run 38704392791 | 15m45s; success | No; parallel to the darwin journey | [job log](https://github.com/JYeswak/omp-kit-companion/actions/runs/38704392791/job/116320490272) |
| Release `native-candidate / native-certification (darwin-arm64-none, certified, 18.8.6)` — run 38704392791 | 10m04s; success | No | [job log](https://github.com/JYeswak/omp-kit-companion/actions/runs/38704392791/job/116320490767) |
| Release `native-candidate / native-certification (linux-x64-gnu, certified, 18.8.6)` — run 38704392791 | 9m56s; success | No | [job log](https://github.com/JYeswak/omp-kit-companion/actions/runs/38704392791/job/116320490234) |
| Release `native-candidate / ladder (macos-latest, certified, 18.8.6)` — run 38704392791 | 9m27s; success | No | [job log](https://github.com/JYeswak/omp-kit-companion/actions/runs/38704392791/job/116320230080) |
| CI `cli-contracts (ubuntu-24.04)` — run 38750203397 | 30m35s; cancelled after ladders failed | N/A (push CI, red) | [job log](https://github.com/JYeswak/omp-kit-companion/actions/runs/38750203397/job/116474437614) |
| Release `native-candidate / native-certification (linux-arm64-gnu, certified, 18.8.6)` — run 38704392791 | 7m53s; success | No | [job log](https://github.com/JYeswak/omp-kit-companion/actions/runs/38704392791/job/116320490154) |
No intel-probe jobs ran in 38704392791 (absent from the publish path on this run). First matrix jobs started 08:16:10Z, ~30 s after dispatch: no macOS slot starvation on this run (the 2026-10-11 12 min wait does not reproduce here). `build-candidates (darwin-x64-none)` succeeded; no `native-certification (darwin-x64-none)` job ran on this candidate, so the 6q9i probe neither gated nor burned a version here.

## Hypothesis ledger

- reuse exact-SHA CI evidence: supports — the `reuse-candidate-evidence` job exists but skipped; push CI is red (ladders failing), so the green-SHA precondition is unmet and every candidate reruns the matrix.
- shard or split real-home-journey (darwin): supports — 19m31s, the new critical path (was cli-contracts at 25m46s on 2026-10-11).
- shard cli-contracts (macos-15): supports — 18m00s serial, second longest.
- macOS slot ordering: rejects for this run — 30 s dispatch-to-start, no starvation observed.
- intel-probe out of publish path: supports — absent from this run's wall.
