### Added
- New `frontend-foundations` skill: decide all 30 front-end foundations first, build from the defaults, and verify before shipping. Includes the foundations reference, initializer, optional overlay, preview renderer and native UI reminder.
- `omp-kit frontend check` runs every foundation verifier through Kit's bounded process runner (argv, no shell) and records the real exit and output digest; hand-written exits and saved-output snippets are refused.
- Results bind to the exact build and decisions via build/criteria digests; sealed evidence is refused when either digest no longer matches, and `--require-approval` refuses owner approvals naming other digests.
- Items needing a human judge report `NEEDS_JUDGE`, never PASS; `init.mjs` pre-marks owner-accept and UNVERIFIED-pipeline rows as judge notes.
- Docs resolve installed script paths relative to the skill directory, and the reference preview renders a stock look with no overlay present; overlays stay optional.
