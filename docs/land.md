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
The file needs a #! line whose interpreter resolves on the machine; the file is
executed directly, so any shebang works (#!/bin/sh, #!/bin/bash,
#!/usr/bin/env bash) and the recorded version is `unknown`.
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
On `PUSHED`, land removes only the named ovnfs checkout (`--checkout NAME`, or `land --patch` when the patch file lies inside a checkout's path) after re-checking its diff and bytes plus modes right before `ovnfs rm`; without a name it only reports matches with their `ovnfs rm` lines and removes nothing. All files inside a removed checkout, including untracked and ignored ones, are removed with it. Pass `--keep-checkout` to keep even the named checkout; `ovnfs rm <name>` is for abandoned ones.

| Result | Exit | Meaning |
|---|---|---|
| `PUSHED` | 0 | The exact candidate that was checked is now origin `main`. |
| `REFUSED` | 1 | Nothing was published: a hook or check failed, or origin moved after the check. |
| `UNRUN` | 77 | Admission or publication could not be verified. |

## `omp-kit ovnfs-land`

Commit changes inside the isolated worker checkout first, then run:

```sh
omp-kit ovnfs-land --repo /path/to/shared --checkout /path/to/worker --base BASE --apply --yes --json
```

`BASE` is the commit used to create the worker checkout, not its latest commit.
The existing `ovnfs-land` verb accepts both a Worktrunk builder's linked worktree
of the same repository (shared object store) and an independent committed Git
checkout, including ovnfs. No daemon or Worktrunk executable is needed to land.
The worker must have no staged, unstaged or untracked changes.

The linear commits in `BASE..worker-HEAD` are replayed in order, one normal
commit per worker commit, preserving each message, author and author date.
Their parent and committer change; the worker branch is never rebased or moved.
Merge commits and empty commits are refused before applying any changes.
An explicit base prevents unrelated main history from being replayed.

One Git-common-directory-keyed exclusive lock covers admission, application,
every commit, push and readback. Every touched path across all worker commits
(both endpoints of a rename, even edits later reverted) must be clean in shared
main, including ignored/untracked obstructions, and untouched on main since
`BASE`. A main edit followed by a revert still refuses. Dirty or diverged paths
are named and refused before any patch, index update or commit. Disjoint main
advances and unrelated staged/worktree changes are preserved byte-for-byte.
Submodule changes are not supported.

Application uses Git's checked binary patches, not `ovnfs apply` or a shared
cherry-pick sequencer. Native `git commit --only` runs configured commit hooks
for each landed commit, and ordinary non-force push runs publication hooks.
No stash, rebase, restore or automatic conflict resolution runs. A hook/push
failure after application retains the applied changes and any earlier landed
commits on main for inspection; `applied`, `commit`, `commits` and `published`
describe that partial state. It never discards bytes to roll back. On success land removes only the named ovnfs checkout (`--checkout NAME`, or `--patch` inside a checkout); without a name it reports matches and removes nothing, and `ovnfs rm <name>` is for abandoned ones. All files inside a removed checkout, including untracked and ignored ones, are removed with it. On refusal the worker branch and worktree remain intact for inspection; the lead removes worker branches only after verifying landing.

`PUSHED` requires origin main, local main, and the landed paths' index and
working tree to agree with the captured worker tip. The lock serializes
this verb, not arbitrary Git clients or editors: existing main custody and
publication protections remain required. No reservation guard is retired.

## `omp-kit save`

`omp-kit save -m MSG -- PATH...` is `land --paths PATH... --message MSG` with
`--apply --yes` implied: the same owner, reservation, hook and push checks run.
It prints one line, `SAVED <sha> on origin in <n> s` or `REFUSED <code>: <remediation>`,
keeps land's exit code, and adds a `save` object under `--json`. Each save appends
`{ts, repo, sha, outcome, code, elapsed_s}` to `<git-common-dir>/omp-kit/save.log`.

## Selected-hunk patch mode

`omp-kit land --patch FILE --message MSG --apply --yes` reconstructs the caller's
selected hunks onto freshly fetched `origin/main`, rather than staging whole
shared-worktree files. Supply a standard `a/` / `b/` unified diff whose paths
are covered by the caller's current exclusive reservations. New files work;
`--patch` and `--paths` are mutually exclusive. Patch mode accepts an
optional `--base SHA`: the commit the patch was produced from. Land checks
the patch out on that tree and requires it to apply cleanly there — proof
the patch was authored on it — then records `Authored-On: SHA` in the
commit message itself, so the stale-worktree hook judges provenance
instead of bytes. `--base` must be an ancestor of (or equal to) fresh `origin/main`, or land refuses as `LAND_BASE_NOT_ANCESTOR` before creating any commit. A patch that does not apply to the base, or an unknown
 base, lands nothing; path mode writes no trailer.

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

The full-suite verdict for the exact tree (`scripts/full-suite-verdict.sh`) gates the release:
`scripts/release-local.sh` refuses unless the source tree has a reusable main-role PASS, and
`omp-kit land` requires it in its publication admission. A push runs the focused suites
`fresh-gate.sh` selects and prints `DEFERRED full-suite-verdict` with the command to run before the
release, so a push takes minutes (GATESPEED1, J-2026-10-31-09); `PRE_PUSH_FULL_SUITE=push` runs the
complete suite inside the push again. The focused suites never substitute for this verdict.

When a push changes executable judging inputs, the adapter runs the committed base's
`fresh-gate.sh` against the candidate archive before running the candidate's own gate.
This includes both gate scripts, `scripts/check-*.sh`, their runner/helper dependencies,
the compiled CLI source tree, dynamically selected tests and their fixtures, and judging
configuration. Selection uses the adapter's own path set, never candidate code.
A candidate that deletes or replaces a gate step with `exit 0` still faces base policy;
neither run reads dirty working-tree gate code. Other changes run the unchanged candidate
gate once, without an additional base fresh-gate invocation.
The candidate must always pass its own runner and checker contracts. Base-focused results
are separate and never stand in for candidate main-role qualification. With no remote base
(an initial push), only the candidate gate is available.

Measure five real local fixture pushes per change class (ordinary and gate-editing):

```sh
nice -n 10 sh -c '. ./tests/cli/pre-push-gate-fixtures.sh; latency_pushes' tests/cli/pre-push-gate.test.sh
```

Each sample publishes a new commit to a disposable bare origin through the real adapter;
output includes elapsed time, exit status, base-run count and machine load. The probe is
separate from the test entrypoint; it never substitutes for the contract suite. These tiny
fixture policies measure transport/adapter overhead, not production fresh-gate duration.

The complete declared suite is every bun test under `tests/cli` and `tests/fleet-guard`, every
shell suite `tests/cli/*.test.sh`, and every python suite under `tests/cli` and `tests/scripts`
(`*_test.py`, `*.test.py`), run against the exact-commit archive. Rows of
`scripts/gate-ci-only.tsv` defer those files only in base-role local checks. The one main-role
qualification runs every declared file, including the manifest rows, from a Git-initialized
exact-commit export. Its main-role PASS is the release qualification; no second CI-only
judgment is required. No focus selection, wall-budget deferral or unrelated success substitutes for it.

Each reusable verdict is keyed by a four-part identity:

* `tree` — the Git tree object of the exact candidate commit (exact source bytes).
* `role` — `base` judges a proposed commit using the base revision's gate; `main` judges a
  commit already on main using its own gate. Their verdicts never satisfy each other's lookup.
* `checks` — a path-and-byte digest of the full judge and its transitive helpers,
  fresh gate, budget CLI/configuration, temporary-directory helper, and CI-only manifest.
  `python3 scripts/suite-metrics.py identity --root . --scope full` prints this identity;
  changing any bound bytes invalidates earlier results. The judge exported by `land` comes
  entirely from the authoritative base, never the working tree.
* `runtime` — OS/architecture, Bun and Python versions, plus a digest of runner-affecting
  environment inputs (`PATH`, `LANG`, timeout and optional `FULL_SUITE_RUNTIME_ID`).

A repeated identical tree under unchanged role/check/runtime identity reuses the recorded
verdict without rerunning — `PASS` publishes, `FAIL` refuses. A changed tree, judge, role or
runtime never reuses. Schema-v3 evidence contains exactly one complete measured record for every
declared file, including files covered by the same-tree focused pass. Missing records, unknown
source closure, producer-identity mismatches, and older aggregate-only entries are cold. A
timed-out or incomplete execution retains its partial log but writes no reusable verdict; a
completed failing execution remains a reusable `FAIL`, never a `PASS`.

Each cache entry records the SHA-256 of its paired `.log`. A missing or altered log invalidates
the entry and forces a complete rerun; no verdict is reused without matching raw suite evidence.

The store is shared by checkouts with the same canonical Git origin, outside every checkout.
By default it is `$XDG_STATE_HOME/omp-kit/full-suite-verdicts` (or
`$HOME/.local/state/omp-kit/full-suite-verdicts` when unset), partitioned by repository identity.
`$XDG_CONFIG_HOME/omp-kit/full-suite-verdict.json` may set an absolute `store_root`; the
`FULL_SUITE_VERDICT_CACHE_DIR` environment variable overrides that location for a process. The
store is never committed. Pruning entries only costs a rerun. The suite is bounded by
`FULL_SUITE_TIMEOUT_SECS` (default 1800) and runs at nice 10 inside the gate's own admission.
One full suite runs at a time on the machine, whatever launched it (SUITESERIAL1): after a cache
miss the judge takes the suite lease (`scripts/suite-lease.sh`). A request for the exact tree and
role already running joins that run and reads its verdict; any other request waits in a bounded
queue or exits 75 with `SUITE_LEASE_QUEUE_FULL` or `SUITE_LEASE_WAIT_TIMEOUT`
(`FULL_SUITE_LEASE_QUEUE_MAX`, default 3; `FULL_SUITE_LEASE_WAIT_SECS`, default 3600). A suite
uses at most 6 inner workers, whatever `FULL_SUITE_JOBS` asks for.

Inspect stored entries with `omp-kit full-suite verdict list [TREE] [--repo PATH]`; use
`omp-kit full-suite verdict get TREE [--repo PATH]` for one tree. Listing includes invalid
records and reports tree, judge role/check identity/runtime, verdict and integrity status.

### Measured test budgets

Each file records its runner, exact argument vector, elapsed milliseconds, CPU time,
exit code, producer identity, output digest, and conservative whole-source-tree closure.
The verdict also records stage/run wall time, start/end load, and the actual worker counts.
`<record>.timings.<pid>.csv` sits beside each verdict, with `stage`, `file`, `elapsed_s`, `rc`,
`workers`, `load_1m`, CPU, command, judge, and closure columns.

Complete runs refresh native Bun `{"version":1,"files":{"path":milliseconds}}` maps in
`<store>/timings/core-test-timings.json` and `script-test-timings.json`; unobserved entries
are retained, as with Bun's `--update-timings`. The external maps survive archive cleanup and
are shared by checkouts of the same repository. The fresh-gate ledger remains
`<git-dir>/omp-kit/fresh-gate-runs.jsonl`; it records the terminal gate outcome and whole-gate
interval, separately from per-file test stages. An archive-only fixture does not write the
checkout's operational ledger unless explicitly requested.

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
smoke runs a 10-second control, a 300-second file refused against the unchanged
225-second cap, and that same 300-second file through a fixture-only gate with budget
enforcement removed. The original refusal assertion must reject the mutant's successful
result. Allow about 11 minutes; the opt-in test has a 720-second harness timeout.

```sh
OMP_KIT_LITERAL_SUITE_BUDGET=1 bun test tests/cli/fresh-gate.test.ts \
  --test-name-pattern 'SUITEBUDGET1 literal'
```
