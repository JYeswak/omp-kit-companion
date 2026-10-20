### Fixed

- `apply plugin --apply` no longer reports PARTIAL with empty `errors[]` when the default profile snapshot is incomplete. Pre-apply and post-mutation refusals keep the specific `snapshot_issue` (e.g. `PLUGIN_SNAPSHOT_INCOMPLETE:<path>`) in the row reason instead of collapsing to generic `PROFILE_SNAPSHOT_UNVERIFIED`, and failed rows project to top-level `errors[]` entries naming profile and cause; an incomplete snapshot never reports success. (ompkit-fp72.29)
