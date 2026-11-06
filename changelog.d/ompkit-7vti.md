### Fixed
- Update ticks now surface pending receipts before polling instead of reporting CURRENT or retrying activation. Receipts lacking restart-safe recovery evidence remain pending with audit/reconcile guidance; an OMP-changed or unverified active installation never triggers automatic reconciliation or a doomed undo suggestion.
- Reconcile-then-undo remains supported once while the recorded candidate and prior binaries are intact; a changed postimage still refuses rollback.
