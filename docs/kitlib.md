# kitlib

kitlib holds the kit's shared primitives. Any work that repeats across kit scripts and tests belongs here: one
implementation for each language and one conformance corpus that all languages pass. Use a primitive; do not
re-implement it at the call site.

| Primitive | TypeScript | Python | POSIX sh | Corpus |
|---|---|---|---|---|
| Bounded run | `run()` in `src/kitlib/run.ts` | `run()` in `scripts/kitlib_run.py` | — | `tests/fixtures/kitlib-run/corpus.json` |
| Owned temp dir | `ownedTmp()` in `src/kitlib/tmp.ts` | `owned_tmp()` in `scripts/kitlib_tmp.py` | `kitlib_tmp` in `scripts/kitlib-tmp.sh` | `tests/fixtures/kitlib-tmp/corpus.json` |
| Private resource lock | `privateLock()` in `src/kitlib/lock.ts` | `private_lock()` in `scripts/kitlib_lock.py` | — | `tests/fixtures/kitlib-lock/corpus.json` |
| Atomic byte replace | `atomicReplaceBytes()` in `src/kitlib/io.ts` | `atomic_replace_bytes()` in `scripts/kitlib_io.py` | — | `tests/fixtures/kitlib-io/corpus.json` |

## Bounded run (KITLIB-RUN, ompkit-hsfyp)

The child gets its own process group and `/dev/null` as stdin, and runs under a deadline. At the deadline the group
receives SIGTERM, then SIGKILL after a grace period. Output is capped per stream. Source headers give the full
semantics.

```ts
import { run } from "../src/kitlib/run";
const result = await run(["git", "status", "--porcelain"], { deadline_s: 30 });
```

```python
import kitlib_run
result = kitlib_run.run(["git", "status", "--porcelain"], deadline_s=30)
```

## Owned temp dir (KITLIB-TMP v1, ompkit-41l85)

The primitive creates `<root>/<label>.<pid>.<6 random [a-z0-9]>` with mode 0700. The root is the TMPDIR-honouring
system temp dir and must exist. Labels must match `^[a-z0-9][a-z0-9-]{0,47}$`.

Each dir holds a `.owner` file (mode 0600) that `omp-kit scratch` can parse: `pid`, `label`, `repo`, `created`, and
`bead` when one is given.

The dir is removed by `cleanup()`, which is idempotent, and by a per-process registry that runs at exit and on
SIGHUP, SIGINT and SIGTERM. After cleaning up on a signal, the process still dies with that signal. Only SIGKILL
leaves the dir behind, and its `.owner` names the dead pid for the reaper.

A tree that holds a non-writable dir, such as the 0555 `releases/<v>` dirs an install makes, still gets removed. If
the first removal fails, every dir inside the owned dir is made owner-rwx and removal is retried once. Symlinks are
never followed, so nothing outside the owned dir changes. If the retry also fails, `cleanup()` throws (TS), raises
`OSError` (Python) or returns non-zero (sh); the exit and signal hooks never fail.

To get a temp file, create it inside an owned dir.

```ts
import { ownedTmp } from "../src/kitlib/tmp";
const work = ownedTmp("my-tool", { bead: "ompkit-41l85" });
try { /* use work.path */ } finally { work.cleanup(); }
```

```python
import kitlib_tmp
with kitlib_tmp.owned_tmp("my-tool") as work:
    ...  # work is the path string
```

```sh
. "$KITLIB/kitlib-tmp.sh"
kitlib_tmp work my-tool || exit 1   # never work=$(kitlib_tmp ...): the subshell would own and remove it
kitlib_tmp_atexit 'printf "done\n"' # kitlib owns the EXIT/HUP/INT/TERM traps; register extra exit work here
```

In sh, `KITLIB_TMP_ROOT` overrides the root and `KITLIB_TMP_BEAD` adds the bead. `kitlib_tmp_cleanup PATH` removes a
dir early. The library refuses to run under zsh, because zsh scopes an EXIT trap to the function that sets it.

### Keeping a dir past exit (ompkit-b3zgu)

Some dirs must outlive the process that made them: a returned artifact dir, a `--keep` workDir, a sandbox root its
caller drains first. Turn auto-cleanup off for those: TS `ownedTmp(label, { autoCleanup: false })`, Python
`owned_tmp(label, auto_cleanup=False)`, sh `KITLIB_TMP_AUTO_CLEANUP=0 kitlib_tmp VAR label`. The dir and its
`.owner` are the same, but no exit or signal hook removes it; `cleanup()` (`kitlib_tmp_cleanup`) still does on
demand. If the process crashes, the scratch reaper reaps it from its `.owner` (dead pid, no open fds). Removal stays
the caller's job.

## Private resource lock (KL08, ompkit-lsn3a)

The domain names a resource, never a lock path: `{namespace, path}` (canonicalised with realpath, so aliases of one
file share one key) or `{namespace, name}`. The lock is the persistent file `<state>/<namespace>/<sha256(key)>.lock`,
where `<state>` is `$XDG_STATE_HOME/omp-kit` (default `~/.local/state/omp-kit`). Both languages take the same
`flock(2)` on the same inode, so a TypeScript holder blocks a Python waiter and the other way round.

Every call validates the state dir, the namespace dir and the lock file. A symlink, another uid, any group/other mode
bit, a second hard link or a replaced inode refuses with a typed `PrivateLockError` (`.code`, `.evidence`). The wait
is monotonic and bounded; on timeout it refuses `DEADLINE` with path, key, deadline, waited and attempts. Nothing is
ever unlinked, and neither file age nor a pid decides liveness: the kernel releases a flock when its last descriptor
closes. Cancellation closes the owner descriptor. Inheritance is opt-in (`inherit`), and the flag is read back.
`release()` closes the descriptor and returns `RELEASED`, or `INODE_REPLACED` when the path no longer names the held
inode. macOS and Linux only; elsewhere the call refuses `UNSUPPORTED_PLATFORM`.

```ts
import { privateLock } from "../src/kitlib/lock";
const lock = await privateLock({ namespace: "create-admission", path: database }, { deadline_s: 5 });
try { /* critical section; pass lock.fd in a Bun.spawn stdio slot to hand it to a child */ } finally { lock.release(); }
```

```python
import kitlib_lock
with kitlib_lock.private_lock({"namespace": "create-admission", "path": database}, deadline_s=5) as lock:
    ...  # lock.fd; pass_fds=(lock.fd,) hands it to one child
```

SQLite connection locks (`service-run`), mkdir admission (`heavy`), Git index locks (`index-lock`), pane locks and
distributed append leases are separate protocols; do not route them through this primitive.

## Atomic byte replace (KL06, ompkit-67i70)

Replaces or creates a file with exactly the given bytes, all at once: a reader sees the old bytes or the new ones,
never a mix. The bytes go to a fresh temp `.<name>.<pid>.<12 hex>.tmp`, created with O_EXCL|O_NOFOLLOW at mode 0600.
The temp must have one link and be owned by this user. It is then set to the requested `mode` (a subset of 0o755),
so the umask never decides the result. Every byte is written and the size is checked, then the temp is renamed
over the target.

Callers name the durability; there is no default:
- `none`: rename only;
- `file`: fsync the bytes before the rename;
- `full`: also fsync the directory after it.

The result reports publication and durability separately: `fileSynced`, `directorySynced`, and `durable`, which is
true only for `full` with both syncs done.

An optional `validate(tempPath)` runs on the complete temp before the rename; if it throws, nothing is published.

Each refusal is an `AtomicReplaceError` with a `code`:
- `UNSAFE_PATH`: the path is relative or not normalized, or the target is a symlink, directory or other non-file.
- `TEMP_EXISTS`, `TEMP_SYMLINK`, `TEMP_HARDLINKED`, `TEMP_REPLACED`: the temp already existed, is a symlink, gained
  a second link, or no longer names our file.
- `EXDEV`: the stage dir is on another filesystem, or the rename crossed filesystems. There is never a copy fallback.
- `STAGE_IN_PUBLIC_TREE`: `publicRoot` was given and the stage lies inside it. A stage outside a public tree must
  be passed as an explicit, same-filesystem `stageDir`.
- `WRITE_FAILED`, `PARTIAL_WRITE`, `SIZE_MISMATCH`, `FILE_SYNC_FAILED`, `VALIDATION_FAILED`, `RENAME_FAILED`,
  `CANCELLED`: the step that failed.

Before the rename, any failure removes the temp (only while its name still names our file) and leaves the target
untouched, with `published: false`. After the rename the new bytes are visible:
- a failed directory fsync throws `DIR_SYNC_FAILED` with `published: true`, so never assume the old bytes remain;
- a cancel (TS `signal`, Python `cancel` event) arriving after the rename does not undo it. The requested
  durability still runs, and the result says `cancelledAfterPublish`.

Serialization stays with the caller (bytes in, bytes out). Atomic replace is not a transaction: a read-modify-write
needs the KL08 lock around both the read and this call, or a concurrent update is lost. The primitive installs no
exit or signal handlers and never changes the umask. It runs on POSIX only; elsewhere it refuses with
`UNSUPPORTED_PLATFORM`.

    import { atomicReplaceBytes } from "../src/kitlib/io";
    const r = atomicReplaceBytes(path, Buffer.from(json), { mode: 0o600, durability: "full" });

    import kitlib_io
    r = kitlib_io.atomic_replace_bytes(path, data, mode=0o600, durability="full")
