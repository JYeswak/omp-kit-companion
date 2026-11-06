### Fixed
- Tern sends reconcile rewritten journals by exact typed message identity; unproven replacements remain blocked until explicitly acknowledged with `send --ack-pending RECORD`, which never resends the old message.
- `deliverToTernSeat` accepts a test-only `testOnlyPendingSettlement: "v0.2.95"` seam so the release measure can compare the old settlement; production behavior is unchanged. (ompkit-fp72.120.16.310)
