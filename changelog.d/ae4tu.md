### Fixed
- Give the README currency check release tags on scheduled and dispatched CI runs as well as pushes. Keep unrelated suites shallow.
- Keep release-retention fixtures independent of the runner’s installed OMP, while retaining the real running-executable check.
- Accept Git's legacy reflog-only `HEAD` notification for an exact reviewed update of its symbolic target, without allowing unrelated ref changes.
- Make native LSP's incomplete and timeout controls publish the same readiness diagnostic the probe requires before it issues references. The controls still require an answered absent-symbol query.
- Disable Auto-QA inside the private LSP probe profile so OMP 19.2 keeps the advertised tool surface LSP-only.
