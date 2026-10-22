### Fixed

- Temp dirs made by production `src/` code (including `isolatedProbeHome`, which leaked 139 probe homes, 11 GB, when probes were killed) now come from kitlib (`ownedTmp`, `owned_tmp`, `kitlib_tmp`) and are removed by their creator on exit, on SIGHUP/SIGINT/SIGTERM and in test teardown, instead of piling up in system temp (ompkit-5vgd5, TEMPSAFE1, J-2026-10-22-06).
