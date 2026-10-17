### Breaking Changes

- Service single-flight claims now carry a random per-acquisition token. Old, malformed or unreadable claims fail closed until their owner reconciles them; age alone no longer authorizes takeover. A failed PID probe proves death only for `ESRCH`, never `EPERM`.
- Serialize claim-file mutations with a persistent per-job SQLite kernel-lock inode, using Bun's built-in driver without an additional dependency. Never unlink the gate during routine cleanup. Release verifies the acquired nonce and directory identity before removing a claim.
- Bind gate/body and delegated-child admission to the new claim token, including same-PID acquisitions in one clock tick. Remove the production-only fixture constructor; test fixtures construct their own metadata.
- Source and owned-consumer regressions do not qualify installed binaries, activate services, or authorize production scratch reclamation. Original SVC1 installed-source and controlled actual-body acceptance remains separate.
- Manual scratch BUSY coverage acquires a real scheduled keeper through the production lock API instead of planting obsolete claim metadata; it still requires the actual holder PID in the CLI result.
- Scratch CLI fixtures keep the absolute-path browser process inventory empty in keeper and worker processes. This prevents the affected test suite from selecting real OMP browsers while preserving real owner-PID/start, open-file, quarantine and reap controls.
