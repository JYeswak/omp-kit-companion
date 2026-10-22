### Fixed

- Temp dirs made by CLI tests, first batch now come from kitlib (`ownedTmp`, `owned_tmp`, `kitlib_tmp`) and are removed by their creator on exit, on SIGHUP/SIGINT/SIGTERM and in test teardown, instead of piling up in system temp (ompkit-8aza1, TEMPSAFE1, J-2026-10-22-06).
