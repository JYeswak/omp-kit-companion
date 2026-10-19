### Fixed

- `kit-flywheel-guard` now refuses bare custody writes (`br update <id> --assignee ...` with no classified status) on a live held claim before mutation (PARTIAL_RELEASE_REFUSED). Clearing the assignee without parking the status leaves an ownerless `in_progress` bead — the genuine BuildNext3/ompkit-fp72.95 shape (`assignee_changed BuildNext3 -> None`, status untouched, 2026-10-19T23:28:30Z) — and reassigning outside claim/park splits custody from the one-active check. Third-party custody writes are refused; repairs of ownerless or already-open beads still pass.
