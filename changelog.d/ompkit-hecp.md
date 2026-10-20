### Fixed

- Fresh-gate launcher no longer forces a location-dependent `OMP_KIT_CASE_CWD` default: an explicit caller override (e.g. pre-push-gate) is preserved, otherwise the harness hermetic case root applies, so the verdict is identical whether the archive was extracted under `var/agent-tmp` or outside it. The run ledger now resolves the pushing checkout's git dir from `ROOT` directly. Quiet rows 375/376/379 stay quiet and a real scratch-path write still fires.
