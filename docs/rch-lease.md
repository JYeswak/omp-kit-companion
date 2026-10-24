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

## rchd alive but unreachable: `socket unlinked`

Bead: `ompkit-774u.6.4`. `rch --json daemon status` reports `running:false` when the daemon's socket path is gone,
even while `rchd` is alive and holds the listener, so "daemon unavailable" is a reachability fault, not missing worker
capacity. An unscoped `omp-kit doctor` reports an `rch` finding when `rch` is installed, and separates the states:

| `evidence.state` | Meaning | Status |
|---|---|---|
| `RUNNING` | the live rchd holds the path and the path is a socket | OK |
| `SOCKET_UNLINKED` | rchd is alive and holds the path, but the path is missing, no longer a socket, or a different socket (inode differs from the recorded baseline) | FAIL |
| `NOT_RUNNING` | rchd reports it is not running | OK (informational) |
| `PID_UNKNOWN`, `LSOF_UNAVAILABLE`, `SOCKET_PATH_UNKNOWN`, `RCH_UNAVAILABLE` | not enough evidence | UNVERIFIED |

Doctor inspects only; it never restarts the daemon. The canonical restore is manual:

```
rch status --jobs        # proceed only when the queue is empty, or every in-flight job is accounted for
launchctl kickstart -k gui/$(id -u)/com.rch.daemon
rch status               # verify: Daemon Running, workers healthy, slots available
```

The kickstart drops in-flight jobs, which is why it is never automated. A path replaced by a different socket IS detected: the doctor records the socket inode (`rch-socket-ino.json` in the kit state root) on a healthy read and compares later reads — a different inode is `SOCKET_UNLINKED`. `lsof` reports no inode for a unix socket, so the baseline comes from `stat`, not from lsof. A first healthy sighting only records the baseline (never FAIL); a record older than 7 days is refreshed. Only `doctor` records the baseline: `status`, `test` and `repair --plan` read and compare it but never write it.
The durable fix (moving the socket out of `~/Library/Caches`) is upstream rch work tracked on `ompkit-z7zj`.
