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

## Full-suite verdict (LAND1)

Before every publication the gate also requires the full-suite verdict for the exact candidate
tree (`scripts/full-suite-verdict.sh`, called by `scripts/pre-push-gate.sh` after `fresh-gate.sh`;
`omp-kit land` requires it in its publication admission too). The focused suites `fresh-gate.sh`
selected for the diff never substitute for this verdict.

The complete declared suite is every bun test under `tests/cli` and `tests/fleet-guard`, every
shell suite `tests/cli/*.test.sh`, and every python suite under `tests/cli` and `tests/scripts`
(`*_test.py`, `*.test.py`), run against the exact-commit archive. Rows of
`scripts/gate-ci-only.tsv` name tests that cannot be hermetic on a dev Mac; they are excluded by
declaration, printed, and recorded in the entry, and CI stays their judge of record. Nothing else
is excluded: no focus selection, no wall-budget deferral, no SKIP, no CI deferral, no unrelated
success.

The verdict is cached by candidate tree hash with check/runtime identity bound to the entry:

* `tree` — the git tree object of the exact candidate commit (exact source bytes).
* `checks` — sha256 of `scripts/full-suite-verdict.sh`, `scripts/fresh-gate.sh` and
  `scripts/gate-ci-only.tsv` as executed. A changed judge (including a manifest change) reruns
  every tree.
* `runtime` — os/arch plus `bun --version` plus `python3 --version` (plus `FULL_SUITE_RUNTIME_ID`
  when pinned). A changed runtime reruns every tree.

A repeated identical tree under unchanged check/runtime identity reuses the recorded verdict
without rerunning — `PASS` publishes, `FAIL` refuses. A changed tree, changed check bytes or
changed runtime never reuses. Missing, corrupt, timed-out or incomplete suite evidence is
non-pass and is never cached GREEN: only a finished run with complete counts is recorded as
`PASS` or `FAIL`. Anything else refuses without writing, so a retry reruns.

The cache lives in the pushing checkout's git dir
(`<git-dir>/omp-kit/full-suite-verdicts/<tree>.json` beside `<tree>.log`, the suite evidence),
overridden by `FULL_SUITE_VERDICT_CACHE_DIR`; it is never committed. Pruning entries only costs
a rerun. The suite is bounded by `FULL_SUITE_TIMEOUT_SECS` (default 1800) and runs at nice 10
inside the gate's own admission.
