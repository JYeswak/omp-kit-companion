### Fixed

- Temp dirs made by remaining CLI, fleet-guard, shell and Python tests now come from kitlib (`ownedTmp`, `owned_tmp`, `kitlib_tmp`) and are removed by their creator on exit, on SIGHUP/SIGINT/SIGTERM and in test teardown, instead of piling up in system temp (ompkit-1yshq, TEMPSAFE1, J-2026-10-22-06).
