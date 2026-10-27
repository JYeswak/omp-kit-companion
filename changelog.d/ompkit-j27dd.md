### Fixed

- A compaction no longer blocks a seat: the flywheel guard does the reread itself and tells the seat what it holds instead of halting it. On every compaction the guard now sends one summary naming the nearest AGENTS.md, listing the seat's held beads (or saying none held), and naming any tracker it could not read with its error. (ompkit-j27dd)
