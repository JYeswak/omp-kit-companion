### Fixed
- Run the existing fleet lessons report producer through a keeper-bound, capped child for `service run fleet-lessons`, instead of the matcher fallback; producer failure records a failed job receipt.
- Refuse intake trackers not registered by configured repositories before producer writes, and refuse registered services without an implemented body instead of running the matcher.
- Preserve a fleet lessons OFF transition before child execution as no-run without a success receipt, and refuse zero-exit child results that do not confirm the report producer.
- Keep fleet lessons subprocess descendants in the producer's owned group so timeout and cancellation stop nested work; the `omp-watch` matcher retains its existing execution mode.
- Hold learning intake writes when native tracker inventory is malformed or incomplete, and read all intake and grade-marker results rather than silently accepting a partial page.
