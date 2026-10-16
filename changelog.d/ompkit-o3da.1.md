### Fixed
- Report stale or missing CI cache rows as UNAVAILABLE instead of OK, retain last-check freshness separately from fetched content, and return a nonzero CLI status when current CI status is unavailable (commit 140e3ce).
