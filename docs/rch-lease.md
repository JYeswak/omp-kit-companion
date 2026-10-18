---
status: current
---

# `omp-kit rch lease`

Bead: `ompkit-5vph`. `rch lease` wraps one native `rch` build in a lease. omp-kit adds no daemon, cache
or slot policy of its own: capacity, reclaim and execution all go through `rch`. Without `rch` on PATH the command
refuses; nothing else in omp-kit needs `rch` (an unscoped `omp-kit doctor` omits it when it is not installed).

```
omp-kit rch lease --slots N [--worker ID] [--project PATH] [--plan | --apply --yes] -- COMMAND [ARG ...]
```

Order of work: observe the configured workers (capacity and disk), reclaim only under rch's own policy, admit a
worker with enough free slots, run COMMAND there, then verify that the next agent can still build.
`--plan` reports what would happen and changes nothing; `--apply --yes` runs it.

| Flag | Meaning |
|---|---|
| `--slots N` | Admission capacity the command needs. Required. It is a check, not a reservation. |
| `--worker ID` | Require this exact configured worker; never silently repin to another. |
| `--project PATH` | Build working directory; defaults to the current directory. |
| `--job` | Native arbitrary-job mode, keeping its output and the remote exit status. |
| `--result-dir PATH` | Native job output directory to bring back, including after a failure. Repeatable. |
| `--require-tool NAME@VERSION` | Qualify the worker by an exact tool version. Repeatable. |
| `--base REV` | Native immutable source base. |
| `--dependency-base PATH=REV` | Native dependency base. Repeatable. |
| `--overlay-path PATH` | Native explicitly owned overlay path. Repeatable. |
| `--clean-overlay` | Native clean overlay mode. |
| `--no-overlay` | Native base-only mode. |
| `--source-content-receipt` | Ask rch for source-content evidence. |
| `--plan` / `--apply --yes` | Plan only, or run. |

Result (`--json` data.overall): `PLAN`, `REFUSED` (with a typed capacity or qualification reason), `COMPLETE`,
`BUILD_FAILED`, `CANCELLED`, or `UNREADY` (the build ran but the next agent could not build after it).

Example:

```
omp-kit rch lease --slots 2 --plan -- cargo test --locked -j 2
omp-kit rch lease --slots 2 --worker contabo-3 --apply --yes -- cargo test --locked -j 2
```
