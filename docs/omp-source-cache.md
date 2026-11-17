---
status: current
---

### OMP source cache

OMP installed through Tern ships compiled code without the TypeScript the
matcher needs. omp-kit fetches `@oh-my-pi/pi-coding-agent` at the exact
installed OMP version into `$HOME/.local/opt/omp-kit/omp-src/<version>` (or
`OMP_KIT_OMP_SRC_CACHE`) with `bun add --exact --ignore-scripts`, checks npm
integrity, and keeps the two newest versions. An entry is used only with its
`.verified.json` receipt and matching files. `OMP_KIT_OMP_SRC_FETCH=0` stops new
fetches.

```sh
omp-kit --info     # shows the OMP launcher, its version proof and the source cache entry
```

### Offline SDK consumers

`tests/cli/kit-sdk-lifecycle.test.ts` (default 18.21.0, `KIT_SDK_LIFECYCLE_VERSION` override) and `tests/cli/kit-sdk-pty.test.ts` (18.22.0) resolve their exact sources through the shared test-side selector `tests/cli/kit-sdk-source.ts`. `scripts/suite-hermetic-env.sh` prepares exactly those suites before the existing fence/exec boundary: it reuses a forwarded verified cache read-only when it already holds the exact version, otherwise `scripts/seed-sdk-source.ts` provisions that one version with the existing `ensureOmpSource` verifier into the file's owned scratch (only the `OMP_KIT_OMP_SRC_CACHE` pointer is set; consumer `OMP_KIT_OMP_SRC_FETCH` stays `0`). Setup shares the unchanged outer deadline and process group; a failed setup aborts before the consumer and stays non-PASS.
