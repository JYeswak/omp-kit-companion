### Fixed

- Temp dirs made by CLI tests, third batch now come from kitlib (`ownedTmp`, `owned_tmp`, `kitlib_tmp`) and are removed by their creator on exit, on SIGHUP/SIGINT/SIGTERM and in test teardown, instead of piling up in system temp (ompkit-8hpf4, TEMPSAFE1, J-2026-10-22-06).
- Named repair plans inspect only their selected scope; policy planning reads settings from a private HOME clone and avoids unrelated probes of the caller's HOME (ompkit-8hpf4).
