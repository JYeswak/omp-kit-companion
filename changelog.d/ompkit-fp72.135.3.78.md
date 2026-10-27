### Changed

- Set CLI and OMP plugin version metadata to 0.2.78, release train 2, the hardening release: every fix for a stall in the 0.2.77 cut (exact-archive tests, a recorded rerun of an environment-caused suite failure, a hermetic tracker fixture, the tag push read against the cached full-suite verdict, CI-only tests run before the tag, update fetching its own attestation bundle) reaches the installed kit, with the rules doctor reading what each profile loads and the new activation scope. (ompkit-fp72.135.3.78)
