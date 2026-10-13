### Changed
- Scratch reaping uses a configurable 24-hour quarantine TTL, emits bounded progress and per-run metrics, warns at 25% free and applies guarded dead-owner reclamation at 20%, and reports per-root free space/scratch usage plus quarantine byte buckets and oldest age.
