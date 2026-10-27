### Added

- Every kit safeguard is on by default and reported by a new read-only scope: `omp-kit doctor --scope activation --json` lists each rule pack entry, plugin extension, kit service, per-repo hook member and profile plugin link as ON, OFF-WITH-REASON or OFF-NO-REASON, and exits nonzero while any item is off with no recorded reason. An opt-out records item, reason, actor and time; an empty reason is refused. No apply verb is included in this slice. (ompkit-fp72.135.3.77)
