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
`PUSHED` is reported only after the exact candidate is published by an ordinary, non-force push.
`REFUSED` means no publication; a constructed candidate may remain locally for inspection.
Failed admission does not publish, and an origin advance after checking
is refused without force or retry. `UNRUN` means admission or publication could
not be verified. `SKIP` does not prove that a full suite passed.

| Result | Exit | Meaning |
|---|---|---|
| `PUSHED` | 0 | The exact candidate that was checked is now origin `main`. |
| `REFUSED` | 1 | Nothing was published: a hook or check failed, or origin moved after the check. |
| `UNRUN` | 77 | Admission or publication could not be verified. |

## Selected-hunk patch mode

`omp-kit land --patch FILE --message MSG --apply --yes` reconstructs the caller's
selected hunks onto freshly fetched `origin/main`, rather than staging whole
shared-worktree files. Supply a standard `a/` / `b/` unified diff whose paths
are covered by the caller's current exclusive reservations. New files work;
renames and copies are refused. `--patch` and `--paths` are mutually exclusive.

The patch is limited to 4 MiB. The bytes read and parsed are the bytes applied:
replacing the file during fetch cannot introduce an unselected hunk.
Git's three-way application preserves newer, non-conflicting origin content.
A non-applying patch or conflict names the affected files and hunks and creates
no commit. An origin advance during construction refuses publication without
retry or force; a constructed candidate can still exist locally.

Patch mode leaves the caller's local `main`, shared index and worktree unchanged.
`PUSHED` confirms the exact checked candidate on origin, not local catch-up;
inspect `base`, `localMain`, `commit` and the phase evidence separately.
Use path mode for ordinary shared-main saves. Patch mode supplies the selected-
hunk construction requested by the UDS committer; it does not establish full
UDS adoption or replace JEV's separately reviewed index/history publisher.
Neither mode grants a history rewrite or force-push.

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
* `checks` — a path-and-byte digest of the full judge and its transitive Python helpers,
  fresh gate, budget CLI/configuration, temporary-directory helper, and CI-only manifest.
  `python3 scripts/suite-metrics.py identity --root . --scope full` prints that identity;
  changing a dependency invalidates earlier results. The judge exported by `land` comes
  entirely from the authoritative base, never the working tree.
* `runtime` — os/arch plus `bun --version` plus `python3 --version` (plus `FULL_SUITE_RUNTIME_ID`
  when pinned). A changed runtime reruns every tree.

A repeated identical tree under unchanged check/runtime identity reuses the recorded verdict
without rerunning — `PASS` publishes, `FAIL` refuses. A changed tree, changed check bytes or
changed runtime never reuses. Schema-v2 evidence contains exactly one complete measured
record for every declared file, including files covered by the same-tree focused pass.
Missing records, unknown source closure, producer-identity mismatches, and schema-v1
aggregate-only entries are cold. A timed-out or incomplete execution retains its partial
log but writes no reusable verdict; a completed failing execution remains a reusable `FAIL`.

Each cache entry records the SHA-256 of its paired `.log`. A missing or altered log invalidates
the entry and forces a complete rerun; no verdict is reused without matching raw suite evidence.

The cache lives in the pushing checkout's git dir
(`<git-dir>/omp-kit/full-suite-verdicts/<tree>.json` beside `<tree>.log`, the suite evidence),
overridden by `FULL_SUITE_VERDICT_CACHE_DIR`; it is never committed. Pruning entries only costs
a rerun. The suite is bounded by `FULL_SUITE_TIMEOUT_SECS` (default 1800) and runs at nice 10
inside the gate's own admission.

### Measured test budgets

Each file records its runner, exact argument vector, elapsed milliseconds, CPU time,
exit code, producer identity, output digest, and conservative whole-source-tree closure.
The verdict also records stage/run wall time, start/end load, and the actual worker counts.
`<tree>.timings.csv` sits beside the JSON/log, with `stage`, `file`, `elapsed_s`, `rc`,
`workers`, `load_1m`, CPU, command, judge, and closure columns.

Complete runs refresh native Bun `{"version":1,"files":{"path":milliseconds}}` maps in
`<cache>/timings/core-test-timings.json` and `script-test-timings.json`; unobserved entries
are retained, as with Bun's `--update-timings`. Durable cache maps survive archive cleanup.
The fresh-gate ledger is `<git-dir>/omp-kit/fresh-gate-runs.jsonl`; it records the terminal
gate outcome and whole-gate interval, separately from per-file test stages. An archive-only
fixture does not write the checkout's operational ledger unless explicitly requested.

`.github/test-budget.json` declares the 600-second push-p95 requirement, 900-second cycle
requirement, and the **starting heuristic** of 225 seconds per file (`full_cycle_s / 4`).
The fresh gate compares actual file-process duration to that cap; `OVER_BUDGET` names the
file, measurement, and cap even when the test itself passed.

```sh
bun scripts/test-budget.ts --derive --check
bun scripts/test-budget.ts --derive --check --workers 4 --timings-dir PATH
bun scripts/test-budget.ts --derive --verdict-history arrival-service.json --json
```

Default derivation prefers the durable cache maps when both exist, otherwise `.github`.
It reports recorded work `W`, longest file `p_max`, worker count `m`, all three budgets,
and the necessary lower bound `max(W / m, p_max)`. Exceeding either the file cap or cycle
lower bound fails the check. This is not a sufficient scheduling bound or a p95 guarantee.
If neither location has both timing maps, derivation refuses instead of inventing
durations. A complete measured full-suite run must supply the missing observations;
legacy aggregate-only verdicts cannot seed per-file maps.
Arrival/service history contains `{arrival_ms,service_ms}` samples; without measured
history, utilisation/variability remain `NOT_MEASURED`. The initial cap is not presented
as distribution-derived.

The ordinary regression uses a tiny fixture-only cap. The optional literal boundary
smoke really runs a 10-second control and a 300-second file:

```sh
OMP_KIT_LITERAL_SUITE_BUDGET=1 bun test tests/cli/fresh-gate.test.ts \
  --test-name-pattern 'SUITEBUDGET1 literal'
```
