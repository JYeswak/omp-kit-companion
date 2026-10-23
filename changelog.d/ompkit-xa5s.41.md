### Fixed

- The staged-fragments pre-commit check no longer turns a repository into a bare one when a commit is made from a linked worktree, as `omp-kit land --patch` does. Its validation step now ignores the git location that git hands to hooks.
