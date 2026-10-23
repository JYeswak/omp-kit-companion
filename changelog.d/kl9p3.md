### Fixed

- Test fixtures that seed the OMP source cache now plant the OpenTelemetry runtime entry the cache requires since the incomplete-entry fix, so the runtime and doctor tests exercise the cache instead of failing on a miss (ompkit-kl9p3).
- `omp-kit test --integrations` honours a set `OMP_KIT_TEST_WORK_ROOT`: the work dir goes under that validated caller-owned scratch root, and an unowned or foreign-workspace root fails closed with INTEGRATIONS_UNAVAILABLE before any profile is read, as the xa5s.5 entry already described.
- `omp-kit scratch new --export` archives the whole commit from the repository top level, so an export requested from a subdirectory (or an ignored scratch dir inside another checkout) is never partial or empty.
- `omp-kit service list` and `service status --all` report `loaded: false` for a job launchd does not know, instead of null.
- The packaged full test is green again past `regex-budget` and `metamorphic-ratchet` (ompkit-kl9p3):
  - `kit-rea-runtime-shipped` failed `regex-budget` with `NO_REQUIRED_LITERAL_PROBE`, because every token of its condition sat inside an alternation. That stopped the ladder and left later stages unrun. The condition now factors out the `/` every shipped path shares. The `.app/Contents/MacOS/` branch keeps its `.app` through a fixed-width lookbehind.
  - `kit-rea-runtime-shipped` and `kit-tool-result-is-not-json` fired on `echo "<their fire snippet>"`, which broke the strict metamorphic quoting invariant. Both now stay quiet when the tracer word or `JSON.parse` sits in a command segment whose command word is `echo` or `printf`. A bounded lookbehind after the literal checks this, so a stream check stays one literal scan.
  - Every existing `cases.tsv` row keeps its verdict.
  - The live scenario `tool-result-json-fire` runs the `cases.tsv` fire snippet (`node -e "...JSON.parse(...)..."`) instead of echoing the text.
  - `shipped-config-selftest` is classified as a non-case ladder stage. Since it joined the ladder, every green full test reported `Unknown stage case domain` and returned no case counts. A test now requires every `ladder.sh` stage to have exactly one case domain.
- The package-manifest fixture carries `scripts/kitlib-tmp.sh`, which `scripts/build-manifest.sh` sources since the kitlib temp migration, so packaging's manifest producer runs on it again (ompkit-kl9p3).
