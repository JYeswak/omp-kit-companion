### Fixed
- Fleet mail wakeups no longer fire inside finite `omp -p` child runs: a child that inherits its parent's seat identity stays silent instead of abandoning its task on the parent's inbox.
