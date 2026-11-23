### Fixed

- A kit update no longer ends `PARTIAL` (`KIT_POSTCHECK_FAILED`) because a fleet process wrote its own state during the postcheck window: `pregrade/`, `verify-evidence/`, `verify-ledger-control/`, `tracker-snapshot/`, `reopen-rate/`, `suite-lease/`, `checkout-archive/` and `scratch-quarantine/` under the kit state root are now declared live-fleet namespaces the isolated-test snapshot does not judge. Any other state write still fails the postcheck.
