### Fixed

- A service install or update from a shell without `AGENT_MAIL_STORAGE_ROOT` or `OMP_KIT_CI_REPOS` no longer drops the am-retain storage root or the ci-poller repo scope already in the installed job file; an explicit value replaces it, an empty string clears the root, and an unusable installed value persists nothing (the same keep-installed rule the load-watch probe target, the Agent Mail RSS ceiling and the kit-update poll settings already follow).
