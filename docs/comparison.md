# Comparison

| | omp-kit | Plain OMP rules (`ttsr`) | Hand-written AGENTS.md text | Generic pre-commit hooks / sandboxing |
|---|---|---|---|---|
| Fires mid-turn, before the agent acts | Yes (OMP TTSR plus `tool_call` extensions) | Yes | No; the model may ignore it | Hooks fire at commit; sandboxes block at the OS boundary |
| Each rule has fire and near-miss cases | Yes, run by `omp-kit test` | You write and run `omp ttsr test` yourself | No | Hook test suites vary |
| Rule changes reviewed against old witnesses | `omp-kit review rules` | No | No | No |
| Profile changes previewed and undoable | Plan, receipt, `undo` | Manual edits | n/a | n/a |
| Fleet coordination (reservations, callbacks, sends) | Yes | No | Prose only | No |
| Secret scan against your real vault | `doctor --scope secrets`, pre-commit hook | No | No | Pattern scanners (e.g. gitleaks) match shapes, not your vault values |
| Isolation from the host | None; it is not a sandbox | None | None | Sandboxes isolate; hooks do not |
| Setup cost | Installer plus OMP | Built in | A text file | Per-repo hook setup |

Use plain `ttsr` for a handful of personal rules. Use omp-kit when the rules
must be proven, shared across profiles, or audited. Neither replaces a sandbox.
