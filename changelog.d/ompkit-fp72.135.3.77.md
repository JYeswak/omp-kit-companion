### Changed

- Every kit safeguard is on by default and reported by a new read-only scope: `omp-kit doctor --scope activation --json` lists each rule pack entry, plugin extension, kit service, per-repo hook member and profile plugin link as ON, OFF-WITH-REASON or OFF-NO-REASON, and exits nonzero while any item is off with no recorded reason. An opt-out records item, reason, actor and time; an empty reason is refused. (ompkit-fp72.135.3.77)

- Activation copies local extension dependencies alongside entrypoints so imports resolve, preserves extension opt-outs across shared support files and profile links, ignores unrelated caller-project guard state during manifest application, and rolls back failed loads instead of leaving a partially applied manifest. (ompkit-fp72.135.3.77)

- Updater postchecks now discard reaped mock PIDs before the final leak check, avoiding false failures if the OS reuses a PID during the live suite. (ompkit-fp72.135.3.77)
