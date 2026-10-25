### Fixed

- The staged-fragments pre-commit check no longer turns a repository into a bare one when a commit is made from a linked worktree, as `omp-kit land --patch` does. Its validation step now ignores the git location that git hands to hooks.
- The pushed-notes validator now clears all six Git repository redirects before initializing and folding its temporary validation repository, including when invoked directly with an inherited linked-worktree environment.
