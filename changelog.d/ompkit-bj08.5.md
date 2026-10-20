### Fixed

- `omp-kit send` binds pause and recipient generation at the mutation boundary: a pause declared (`OMP_KIT_SEND_PAUSED=1`) or a replaced target pane between observation and submission refuses with zero sends instead of sending on a stale snapshot. `service run` and `service run fleet-watch` re-read the off switch and the observed launcher set at the effects boundary, so a pause declared or a second launcher appearing after the pre-lock check refuses with zero effects.
