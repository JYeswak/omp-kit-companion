### Fixed

- Temp dirs made by scratch, send and service tests (the reaper's own fixtures now live inside owned roots) now come from kitlib (`ownedTmp`, `owned_tmp`, `kitlib_tmp`) and are removed by their creator on exit, on SIGHUP/SIGINT/SIGTERM and in test teardown, instead of piling up in system temp (ompkit-aabyn, TEMPSAFE1, J-2026-10-22-06).
