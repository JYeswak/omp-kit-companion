# Release latency profile — 2026-10-11

**Consumer:** release maintainers choosing and verifying the `ompkit-d2hs` speed change. **Defect:** a tag release repeats same-SHA Ubuntu CI and waits on long macOS certification; the Intel probe adds a variable workflow tail. **Deletion condition:** replace this dated profile after the release train has two measured green pushes published under 20 minutes and the no-op rehearsal gate has two runs under 15 minutes.

## Measurement

Two completed release runs; job wall times from GitHub job timestamps. Run 38092889107 used SHA `5d3c6d04f3423f2be3b22d302843fd610d12a05f`; run 38108635425 used SHA `736b7ed6cd7f8e3c23c4dc53a8c6da9682240df9`. The second SHA's push CI run 38107371045 completed successfully before the release run started. `critical path` means a job required before candidate attestation/publication; the candidate workflow has no publisher, while release-train publishes after its `workflow_run` completion event.

| Job | Wall | On critical path? | Job evidence |
|---|---:|---|---|
| macOS `cli-contracts` in release | 25:46 / 28:52 | Yes; release candidate gate and dominant serial stage | [run 38092889107, job 114332832137](https://github.com/JYeswak/omp-kit-companion/actions/runs/38092889107/job/114332832137); [run 38108635425, job 114379411574](https://github.com/JYeswak/omp-kit-companion/actions/runs/38108635425/job/114379411574) |
| Darwin ARM64 minimum native certification | 16:05 execution / 28:27 create-to-complete on run 2; run 2 waited 12:13 then ran 16:14 | Yes; co-critical with macOS CLI in run 2 | [run 38108635425, job 114379518706](https://github.com/JYeswak/omp-kit-companion/actions/runs/38108635425/job/114379518706) |
| Ubuntu `cli-contracts` repeated by release | 14:35 / 15:57 | Candidate gate, but not the release wall critical path; repeats same-SHA push CI | [run 38092889107, job 114332832081](https://github.com/JYeswak/omp-kit-companion/actions/runs/38092889107/job/114332832081); [run 38108635425, job 114379411604](https://github.com/JYeswak/omp-kit-companion/actions/runs/38108635425/job/114379411604) |
| Ubuntu `cli-contracts` on exact-SHA push CI | 21:24 / 21:26 | Prior evidence; run 38107371045 was green before run 38108635425 began | [run 38092850534, job 114332681815](https://github.com/JYeswak/omp-kit-companion/actions/runs/38092850534/job/114332681815); [run 38107371045, job 114375631922](https://github.com/JYeswak/omp-kit-companion/actions/runs/38107371045/job/114375631922) |
| Ubuntu minimum/certified ladders repeated by release | Run 2: 6:15 / 7:10 | Candidate gates, not wall critical path | [minimum job 114379411565](https://github.com/JYeswak/omp-kit-companion/actions/runs/38108635425/job/114379411565); [certified job 114379411685](https://github.com/JYeswak/omp-kit-companion/actions/runs/38108635425/job/114379411685) |
| Ubuntu minimum/certified ladders on exact-SHA push CI | Run 2: 7:47 / 6:01 | Prior evidence; available before release dispatch | [minimum job 114375631899](https://github.com/JYeswak/omp-kit-companion/actions/runs/38107371045/job/114375631899); [certified job 114375631934](https://github.com/JYeswak/omp-kit-companion/actions/runs/38107371045/job/114375631934) |
| Intel non-shipping probe | 11:24 / 1:13 | Not a certified shipping stage, but its original placement in the candidate workflow delays release-train's workflow-completion publish trigger | [run 38092889107, job 114337341435](https://github.com/JYeswak/omp-kit-companion/actions/runs/38092889107/job/114337341435); [run 38108635425, job 114384013442](https://github.com/JYeswak/omp-kit-companion/actions/runs/38108635425/job/114384013442) |

The release workflow walls were 37:41 and 30:55. Run 38108635425 published at 04:04:35Z, 57:11 after its exact-SHA push CI began at 03:07:24Z. The Intel tail varied by 10:11 across these two runs; it is not a stable proxy for a certified gate.

## Lever selection

| Lever | Impact | Confidence | Effort | Score | Decision |
|---|---:|---:|---:|---:|---|
| Reuse successful exact-SHA push CI legs; for an explicit same-SHA rehearsal, reuse the complete prior candidate only when its successful run, required receipts, versioned proof, and artifact hashes validate | 5 | 4 | 4 | 5.0 | Selected; missing green CI or any stale/missing proof falls back to the full candidate path |
| Shard the macOS CLI contract suite | 4 | 2 | 4 | 2.0 | Not selected: changes test scheduling while the exact-SHA reuse path removes duplicate work without changing test membership |
| Move the non-shipping Intel probe to a sibling workflow triggered after candidate completion | 2 | 4 | 1 | 8.0 | Selected with the release-train integration: keep the probe reported, but do not make the whole candidate workflow wait for it before publication |

Reuse must not weaken certification. The green CI run must be a completed `push` on `main` for the exact source SHA. Candidate replay is rehearsal-only and additionally requires a completed successful release rehearsal on that SHA, the same base version, every shipping candidate plus minimum/certified receipt artifact still available, and candidate proof/index values matching the current OMP tracks. Attestation rechecks the exact shipping platform set and each downloaded archive hash. No green CI or invalid candidate evidence means no reuse; the full candidate workflow runs.

**Before/after rehearsal timing remains unmeasured.** The acceptance requires two no-op rehearsal runs under 15 minutes after the change; these two baseline releases are not rehearsal evidence.
