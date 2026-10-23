### Changed

- The `br create` admission guard now runs native br through kitlib run instead of raw `subprocess.run`. The tracker creation lock still reaches native `br create` (through `inherit_fds`), dry-run and plain creates still stream br's output live to your terminal, and the deadlines (30 s for shim writes, 120 s for creates), messages and exit codes are unchanged. A new test shows the child holds the lock even after the guard is killed, and fails if the lock is not handed over. The guard's kitlib ratchet allowance drops from 4 raw spawns to 0. (ompkit-t8dfi)
