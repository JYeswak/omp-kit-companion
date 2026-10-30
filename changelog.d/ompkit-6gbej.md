### Fixed

- Postchecks report a watched regular file as `skipped-concurrent-writer` only after observing a further content change once the test runner exits; isolated-test writes and unconfirmed changes remain failures.
