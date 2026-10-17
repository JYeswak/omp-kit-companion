### Changed
- Add the native-first `omp-kit tern` command family, context-specific Luau bindings, source-inventory drift checks, and the native plugin sources. Forwarding, declaration coverage, and offline fixtures remain separate from native semantic and installed-fleet qualification.
- Stamp the selected release version into archived package metadata before manifest hashing, and refuse package versions that disagree with the release manifest.
- Preserve executable permission for the packaged receipt CLI through both versioned staging and standalone installation, without trusting arbitrary archive executable modes.
- Stop surviving owned descendants after their stage leader exits, before waiting indefinitely for inherited output pipes; retain captured stage evidence and the leader's exit status.
- Report invalid Tern doctor limits and endpoints as input refusals rather than native dependency unavailability.
- Keep the selected verified OMP source-cache namespace across isolated HOME changes, so standalone launchers retain the same matcher source without weakening mixed-identity refusal.
- Frame ladder verdicts on their own lines even when a bounded child report ends without a newline; retain strict ordered-stage validation.
- Run focused gate suites as literal relative paths, preventing same-named tests in unrelated checkout archives from entering the selected suite.
