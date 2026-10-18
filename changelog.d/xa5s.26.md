### Fixed

- `fleet flush-pending` no longer sends Enter on a queued-message band it cannot read whole: empty, gapped, duplicate-label or inconsistently counted bands are refused, so a malformed capture can never authorize a flush.
