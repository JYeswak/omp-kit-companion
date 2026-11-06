### Fixed

- The update service now automatically restores a failed kit-only activation only when its receipt is still pending and READY, both recorded binaries verify, and the current tick reports a revert-safe postcheck failure. Successful recovery clears the pending receipt as compensated while retaining the failure; unsafe or restarted recovery requires inspection.
