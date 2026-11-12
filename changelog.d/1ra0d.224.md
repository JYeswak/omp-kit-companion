### Fixed
- The daily `loop-close` job reads its repo and mailbox from the `loopClose` key in fleet-watch.json (with `LOOP_CLOSE_REPO`/`LOOP_CLOSE_MAIL_TO`/`LOOP_CLOSE_MAIL_PROJECT` overrides) instead of defaulting to `$HOME`, and reports `UNCONFIGURED` in `service status`/`doctor`/`run` until the key is set.
