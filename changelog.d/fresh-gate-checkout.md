# Pre-push gate tests a source checkout

The fresh-archive pre-push gate now initializes the extracted archive as a git checkout, matching CI. Focused suites that exercise contributor-only paths, such as the Bun fallback used by `scripts/e2e-live.sh`, no longer fail with exit 2 in the gate while passing in CI.
