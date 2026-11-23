### Added
- `omp-kit verify BEAD --export SHA` gains `--tracker PATH`: the bead resolves from the tracker repo while the export commit resolves from `--project`, so a bead in one tracker can close against a fix commit in another repo. Omit `--tracker` to resolve both from `--project`, exactly as before; `--tracker` is refused with `--live-readback`.
