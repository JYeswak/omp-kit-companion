# kitlib

kitlib holds the kit's shared primitives. Any work that repeats across kit scripts and tests belongs here: one
implementation for each language and one conformance corpus that all languages pass. Use a primitive; do not
re-implement it at the call site.

| Primitive | TypeScript | Python | POSIX sh | Corpus |
|---|---|---|---|---|
| Bounded run | `run()` in `src/kitlib/run.ts` | `run()` in `scripts/kitlib_run.py` | — | `tests/fixtures/kitlib-run/corpus.json` |
| Owned temp dir | `ownedTmp()` in `src/kitlib/tmp.ts` | `owned_tmp()` in `scripts/kitlib_tmp.py` | `kitlib_tmp` in `scripts/kitlib-tmp.sh` | `tests/fixtures/kitlib-tmp/corpus.json` |

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
