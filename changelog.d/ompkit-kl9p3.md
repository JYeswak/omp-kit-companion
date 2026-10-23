### Fixed

- The launcher-table test fixture no longer hands a later test file a deleted `ps` shim: when an earlier file's cleanup removed it, the next call rebuilds it, so the full suite stops failing with `ps` ENOENT.
