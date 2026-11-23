### Fixed

- Kit updates now run a model-free omp start probe (`omp -p "Reply ok." --no-session --model omp-kit-start-probe/none`, about 2 s, no credential or network) with a 45 s deadline before moving the plugin link or emitting the update notice, and hold with `UPGRADE_HELD` when the start does not finish inside the deadline, so a hung seat is never updated underneath itself. A start that exits (zero or not) and a missing omp never hold.
