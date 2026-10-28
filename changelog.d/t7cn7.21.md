### Fixed

- `omp-kit verify` replays now run behind a per-run read-only `br` dispatch,
  so a replayed command can never mutate the production tracker through the
  supported dispatch (ompkit-t7cn7.21). `src/verify.ts` resolves the next
  existing `br` delegate once, installs `src/kitlib/readonly-br.ts` (a
  portable POSIX `sh` shim, no new runtime dependency) at the front of the
  replay `PATH`, and keeps trusted metadata reads and final acts on the
  real binding. Reads pass through; any other subcommand is refused with
  the `READONLY_TRACKER` marker (exit 77) unless its effective `--db`
  names the explicitly admitted per-run owned fixture, which the verifier
  creates with `br init` in owned scratch only when the acceptance
  references `OWNED_TRACKER_DB`, and fails closed otherwise. When a harness
  designates `GRADE_WAVE_SCRATCH`, the per-run scratch (and the owned
  fixture inside it) roots there, so replay fixtures live where the ambient
  `br` authority permits writes. Covered by
  `tests/cli/verify.test.ts` (22 tests: admitted explicit/bound/same-repo
  reads on real trackers beside the exact code export; ordinary,
  env-stripped and implicit-inherited writes refused with `T`
  byte-identical, the owned write admitted, and neutralization making the
  fixture fail) and `tests/cli/runtime.test.ts` (native guard checks at
  the `sh` seam; the exact source and the official compiled `omp-kit`
  verifier both reach the guard on owned fixtures, with source/binary/input
  digests recorded — the guardless binary executes the mutation and fails
  the box while the new source refuses it — plus one `verifyBead` smoke).
