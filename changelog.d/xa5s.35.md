### Fixed

- The post-compaction reread gate (`COMPACTION_REREAD`) now reads the tracker a command actually runs in. A `br show <id> --json` clears it from the bash tool's `cwd`, after a leading `cd DIR`, or with `--db`, so a seat whose session cwd is not its tracker repo is no longer latched. An empty `br list --assignee <you>` clears it only when no other tracker the session used holds an in-progress or rework bead assigned to you; the guard checks each with its own bounded read and keeps blocking if a read fails (ompkit-xa5s.35).
