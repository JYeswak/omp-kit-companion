### Fixed

- Three test files no longer fail at random under machine load (32 cores at load 25-160). Child deadlines and case timeouts in `service`, `fresh-gate-admission` and `installer-bootstrap` tests now come from the kit's `fixtureDeadlineS` load factor instead of fixed seconds. The supervisor test that asserts the 500 ms scratch cap itself keeps its 2 s bound with a measured `wallclock:` annotation. (WALLCLOCKFIX1)
