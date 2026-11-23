### Added

- A seat whose goal is active and whose turn ended with no tool call now gets exactly one continuation message (`kit-goal-continue`) instead of parking idle until a heartbeat; paused goals, turns with pending user input, and consecutive idle turns get none, and the latch re-arms on observed tool use, a new goal id, consumed user input or a session reset.
