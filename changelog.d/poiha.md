### Fixed

- A seat's `br comments add` without `--author` or `--actor` is no longer recorded as the OS user (Joshua): the seat-identity extension exports `BD_ACTOR` and `BEADS_ACTOR` from the seat's `AGENT_NAME` at plugin load (never replacing a value the seat set), because `br` reads those and not `AGENT_NAME`. The verify path and chief ticks read comment authors, so a seat's Lesson or verdict could read as Joshua's.
