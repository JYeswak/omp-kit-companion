### Fixed

- `omp-kit tern-ref` reads br's JSON envelope, runs qwen searches under the qwen interpreter (refusing `QWEN_UNAVAILABLE` when it is absent), guards the daemon socket, and accepts `drift --site`. (ompkit-fp72.120.8)
