### Fixed

- `omp-kit heavy` admits on disk as well as load and slots: when `sbh check --need 10G` reports pressure, jobs queue with a `disk low` reason instead of adding scratch; an unrunnable sbh refuses explicitly. `heavy status` shows the disk reason. (ompkit-fp72.52)
