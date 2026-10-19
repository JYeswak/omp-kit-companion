### Fixed

- `omp-kit rch lease` reports a bound wrapper whose native call failed without any recorded remote exit (an SSH transport timeout such as `RCH-E104`) as `UNREADY rch_transport_unavailable` instead of `BUILD_FAILED native_return_failed`: the build never reached a verdict. A recorded nonzero remote exit stays `BUILD_FAILED native_remote_command_failed`.
