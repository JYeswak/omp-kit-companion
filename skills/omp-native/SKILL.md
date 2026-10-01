---
name: omp-native
description: Use native OMP tooling before reaching for anything else: test stream rules, link rule plugins, read settings read-only.
---

# Native OMP in session

Prefer what OMP already ships. These three blocks run anywhere OMP is
installed and are re-checked by `scripts/plugin-lifecycle.sh`:

```sh verified rc=0 contains="omp/"
omp --version
```

```sh verified rc=0 contains="TTSR rules"
omp ttsr list
```

```sh verified rc=0 contains="ts-no-any"
omp ttsr test --source tool --tool edit --path src/foo.ts 'const x: any = 1' --json
```

`list` shows builtin, project, and plugin rules with their source.
`test --rule FILE` isolates one rule file and skips project loading;
`--source` is `text`, `thinking`, or `tool`. A quiet `--json` probe exits
0 with `"triggered":[]`; the human-readable form of an isolated quiet
probe exits 1, so use `--json` when scripts branch on the result.

Rules ship as OMP plugins: any npm package with an `omp` field whose
`rules/` directory holds markdown rules. Link one locally and its rules
firing show `"sourceProvider": "omp-plugins"`:

```sh
omp plugin link /path/to/package && omp plugin list
omp ttsr test --source tool --tool bash 'echo DEMO_CANARY_FIRE' --json
```

(The second command needs a rule matching the marker; the lifecycle
script proves the round trip with a demo package.) Native
`~/.omp/agent/rules` shadows a same-name plugin rule, and disabling a
plugin reactivates a same-name legacy copy under `~/.agents/rules`.

Settings are read-only here: `omp config list --json` shows every key,
`omp config get KEY --json` reads one. `set` and `reset` change the
profile and get no example.
