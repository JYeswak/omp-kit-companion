# Release-path profile — 2026-10-11

**Bead:** `ompkit-d2hs`

**Consumer:** the maintainer deciding whether the `ompkit-d2hs` release-path changes satisfy the latency acceptance.

**Feature gated:** reuse exact-SHA green CI evidence and remove non-gating Intel probes from the publication path.

**Observed defect class:** release candidate work repeated already-green CI jobs on the same commit; post-attestation Intel probes extended the workflow wall time.

**Deletion condition:** remove this profile after `ompkit-d2hs` is independently closed and its release-path optimization is no longer being evaluated against this baseline.

**Method:** job wall times are GitHub job `startedAt` to `completedAt` in UTC. “Critical path” means the job that outlasted its required parallel siblings for the CI or release workflow. Links go to the job’s GitHub Actions evidence.

| Workflow job | Observed wall | Critical path? | Evidence |
| --- | ---: | --- | --- |
| CI `cli-contracts (ubuntu-24.04)` — run 38097104626 | 20m11s; job failed | Yes for this CI run; both Ubuntu ladders finished earlier | [job log](https://github.com/JYeswak/omp-kit-companion/actions/runs/38097104626/job/114345182472) |
| CI `ladder (ubuntu-latest, certified, 18.8.6)` — run 38097104626 | 8m03s; success | No; parallel to the longer CLI-contracts job | [job log](https://github.com/JYeswak/omp-kit-companion/actions/runs/38097104626/job/114345182465) |
| CI `ladder (ubuntu-latest, minimum, 18.4.2)` — run 38097104626 | 6m01s; success | No; parallel to the longer CLI-contracts job | [job log](https://github.com/JYeswak/omp-kit-companion/actions/runs/38097104626/job/114345182480) |
| Release `native-candidate / cli-contracts (macos-15)` — run 38092889107 | 25m46s; success | Yes; longest required candidate job | [job log](https://github.com/JYeswak/omp-kit-companion/actions/runs/38092889107/job/114332832137) |
| Release `native-candidate / cli-contracts (ubuntu-24.04)` — runs 38092889107 / 38108635425 | 14m35s / 15m57s; success | No; shorter than macOS CLI-contracts | [run 380928](https://github.com/JYeswak/omp-kit-companion/actions/runs/38092889107/job/114332832081) · [run 381086](https://github.com/JYeswak/omp-kit-companion/actions/runs/38108635425/job/114379411604) |
| Release Ubuntu minimum ladder — runs 38092889107 / 38108635425 | 6m22s / 6m15s; success | No; shorter than macOS CLI-contracts | [run 380928](https://github.com/JYeswak/omp-kit-companion/actions/runs/38092889107/job/114332832104) · [run 381086](https://github.com/JYeswak/omp-kit-companion/actions/runs/38108635425/job/114379411565) |
| Release Ubuntu certified ladder — runs 38092889107 / 38108635425 | 7m53s / 7m10s; success | No; shorter than macOS CLI-contracts | [run 380928](https://github.com/JYeswak/omp-kit-companion/actions/runs/38092889107/job/114332832172) · [run 381086](https://github.com/JYeswak/omp-kit-companion/actions/runs/38108635425/job/114379411685) |
| Release `intel-probe (minimum)` — run 38092889107 | 11m24s; success | Yes for workflow completion after attest; non-gating for certification | [job log](https://github.com/JYeswak/omp-kit-companion/actions/runs/38092889107/job/114337341435) |

Run 38108635425 confirms the macOS CLI-contracts job consumed 28m52s of its 30-minute timeout (job 114379411574). Both Intel-probe jobs in that run failed after 1m13s and did not dominate its wall time: [macOS CLI-contracts](https://github.com/JYeswak/omp-kit-companion/actions/runs/38108635425/job/114379411574), [Intel minimum](https://github.com/JYeswak/omp-kit-companion/actions/runs/38108635425/job/114384013442), [Intel certified](https://github.com/JYeswak/omp-kit-companion/actions/runs/38108635425/job/114384013514). The 38092889107 release run completed 37m41s after dispatch; run 38108635425 completed in 30m55s. These are historical baselines, not post-change results.
