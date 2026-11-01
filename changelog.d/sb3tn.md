### Fixed
- Keep the bounded echo/printf exclusion before the pipeline token, so quoted filter commands printed as text remain quiet.
- The live fire scenario for bash-silenced-filter-pipe pipes a silenced `ls` instead of `printf`, which the rule now deliberately ignores.
