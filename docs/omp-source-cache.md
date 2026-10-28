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
