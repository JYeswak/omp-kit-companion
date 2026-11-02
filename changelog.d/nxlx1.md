### Fixed
- The `br` shim now refuses a tracker path that still holds an unexpanded `$` variable (`--db '$DB'`, `--db=$DB`, or `BEADS_DB=$DB`) before br runs, naming `BR_SHIM_DB_LITERAL`. Such a call made br create a whole new beads database named `$DB` at the omp-kit root three times, and each copy blocked every build wave as checkout dirt.
