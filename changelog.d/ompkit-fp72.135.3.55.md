### Fixed
- Tern sends now verify the target OMP process's `AGENT_NAME` against the pane identity in the caller's separate `AGENT_MAIL_PROJECT`, rechecking process and session identity before delivery. A matching live runtime can identify a legacy-unverified pane without relying on stale fleet-watch state; mismatches still refuse before sending.
- Tern sends report target `AGENT_NAME` drift from the resolved Agent Mail identity as `SEAT_REBOUND`; route tests prove zero sends both before dispatch and when the name changes between observation and identity resolution.
