### Fixed

- push-check exports the commit tree through a streaming git-archive-to-tar pipe instead of buffering it in memory, so repositories whose archives exceed the old 512 MiB cap are checked instead of refused.
