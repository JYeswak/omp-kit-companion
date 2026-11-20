### Fixed

- `omp-kit land --exact-parent` no longer publishes ungated: the private ovnfs checkout it pushes from carries no hooks, so the first release ran no pre-push member. Where `scripts/fresh-gate.sh` exists, land now runs it on the exact candidate in the canonical repository before anything is created, and publishes only on its `FRESH-GATE: GREEN commit=<sha>` line with exit 0; otherwise it refuses `LAND_PUBLICATION_REFUSED` with the gate's last line. The deadline is `OMP_KIT_LAND_EXACT_GATE_DEADLINE_S` (default 2400 s).
