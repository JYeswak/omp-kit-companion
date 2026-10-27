### Fixed

- `scripts/full-suite-verdict.sh` accepts `--rerun-reason TEXT` for a recorded rerun of a cached FAIL. The old entry is kept beside the cache as `<tree>.superseded-<utc>.{json,log}`, the suite runs again, and the new entry records the reason, the actor (`AGENT_NAME` or `USER`) and the superseded entry's digest. An empty reason is refused and nothing reruns; a cached PASS is still reused, never rerun. Retrying an environment-caused FAIL no longer needs a hand file move. (ompkit-t7cn7.4)
