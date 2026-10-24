### Fixed

- `tests/cli/private-index-land.test.ts` no longer depends on the scratch dirs of whoever runs it (ompkit-lrbd.3). Each `omp-kit land` child it spawns ran the push-time scratch disposal gate over the real `~/Developer/*/var/agent-tmp` roots, so "reports local catch-up without claiming publication or retrying" could fail with `SCRATCH_DISPOSAL_REFUSED` naming an unrelated dir (seen: a dead owner whose pid the land child had reused). Every land run in the file now sets `OMP_KIT_SCRATCH_ROOTS` to an empty fixture root, so the gate sees only fixture state. The gate itself is unchanged.
