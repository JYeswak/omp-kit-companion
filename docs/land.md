---
status: current
---

# `omp-kit land`

`omp-kit land --paths PATH... --message MSG --apply --yes` commits exactly the reserved paths to shared `main` and publishes them.

`omp-kit land` creates its commit with `git commit --only`, so configured
`commit-msg` hooks run. Publication uses an ordinary non-force `git push`, so
configured `pre-push` hooks remain active. An optional repo check is registered at
`.omp/push-check`:
the exact regular UTF-8 blob in the landing base is the registration. A check
runs only when the exact candidate contains the same bytes; a new or changed
check is reported `SKIP` for that landing and may become active on a later one.
The file needs an absolute interpreter shebang; the process receives
`OMP_LAND_REPOSITORY`, `OMP_LAND_CANDIDATE_SHA`, `OMP_LAND_CHECK_PATH`, and
`OMP_LAND_CHECK_SHA256` for candidate inspection. Exit 0 is `PASS`, exit 77 is
`SKIP`, and other nonzero exits are `FAIL`. If the base has no registered check
or the candidate changes its bytes, status is `SKIP`; unavailable registered
execution is `UNRUN`.
`PUSHED` is reported only after the exact candidate is published by no-force
convergence. `REFUSED` means no publication; its candidate commit may remain
saved on local shared `main`.
Failed admission does not publish, and an origin advance after checking
is refused without force or retry. `UNRUN` means admission or publication could
not be verified. `SKIP` does not prove that a full suite passed.

| Result | Exit | Meaning |
|---|---|---|
| `PUSHED` | 0 | The exact candidate that was checked is now origin `main`. |
| `REFUSED` | 1 | Nothing was published: a hook or check failed, or origin moved after the check. |
| `UNRUN` | 77 | Admission or publication could not be verified. |
