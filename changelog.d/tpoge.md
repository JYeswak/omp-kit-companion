### Fixed

- Temp dirs made by `scripts/` tools and hook members (installed members source `kitlib-tmp.sh` from their own hook dir) now come from kitlib (`ownedTmp`, `owned_tmp`, `kitlib_tmp`) and are removed by their creator on exit, on SIGHUP/SIGINT/SIGTERM and in test teardown, instead of piling up in system temp (ompkit-tpoge, TEMPSAFE1, J-2026-10-22-06).
