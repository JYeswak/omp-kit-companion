### Fixed

- `omp-kit rch lease` reports a bound wrapper whose native call failed without any recorded remote exit (an SSH transport timeout such as `RCH-E104`) as `UNREADY rch_transport_unavailable` instead of `BUILD_FAILED native_return_failed`. The installed package now ships the write/edit-stream budget fixture so installed runs find it.
