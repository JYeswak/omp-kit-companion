# FULLSUITEPAR1 paired full-suite measurement

**Consumer:** the non-author pregrade for `ompkit-9t6f2` and its AC1/AC3 replay.
**Gate:** AC3's `awk` check below; AC1 compares the sorted suite result lines and the JSON `shell_suites`/`shell_fail` counts.
**Observed defect:** the serial run took 2,606.056 s overall, including a 1,632.818 s shell stage, past the 1,800 s publish limit. Five-way shell execution reduced the measured shell stage while preserving its suite results.
**Deletion condition:** retain while `ompkit-9t6f2` or a reviewer/gate references this evidence; remove only after the bead is closed and no active acceptance or review consumes it.

## Paired runs

Both complete runs used the same source commit `831e25df768e93101c91055bd6b361e02513c1ba` and tree `313c3007553e7bdae082356f1205680c875addea` on macOS 25.5.0, Darwin/arm64, 32 online cores, Bun 1.4.3 and Python 3.9.6. Each declared 264 Bun files, 54 shell suites and 27 Python suites; four CI-only suites were excluded by the manifest. The only intended variable was the shell worker setting. `FULL_SUITE_TIMEOUT_SECS=3600` allowed complete measurement records; it was not a publish-gate change. The release gate remains 1,800 s.

The five-worker choice was based on the per-suite timing model recorded in bead comment 15616: the longest measured suite was about 404 s and the five-worker projection was about 411 s. This paired run validates the selected width against serial execution; it is not a worker-count sweep or a claim that five is globally optimal.

| Run | Shell workers | Bun wall | Python wall | Shell wall | Total wall | Load average, start → end | Verdict |
|---|---:|---:|---:|---:|---:|---|---|
| Serial, 2026-10-30 22:53:19Z | 1 | 682.368 s | 285.058 s | 1,632.818 s | 2,606.056 s | `[19.7808, 20.3740, 20.6035]` → `[21.4824, 18.6377, 18.3887]` | complete `FAIL` |
| Parallel, 2026-10-30 23:42:19Z | 5 | 652.595 s | 319.949 s | 565.623 s | 1,543.633 s | `[13.4531, 15.3120, 16.8945]` → `[19.8423, 17.2197, 17.3765]` | complete `FAIL` |

shell_stage_wall_s_before: 1632.818
shell_stage_wall_s_after: 565.623
shell_workers_measured: 5

The shell stage fell by 1,067.195 s (65.36%); total wall fell by 1,062.423 s (40.77%). The parallel measurement's total was below 1,800 s, but it was a measurement invocation with a 3,600 s timeout and its verdict was `FAIL`, not a published gate result.

## Isomorphism and observed failures

The serial and parallel logs have identical sorted `GREEN`/`RED` suite-result lines: 92 total across all suite categories, 89 green and 3 red. For shell suites specifically, both have 54 lines: 51 green and the same three red lines. Both verdict JSON records report `shell_suites=54` and `shell_fail=3`.

The unchanged shell failures are:

- `tests/cli/gap-mention.test.sh`: its fixture has no `HEAD`; `git ls-tree ... HEAD` refuses and the expected `GAP_UNFILED` message is missing.
- `tests/cli/install-commit-msg-bead.test.sh`: 97 pass / 2 fail; the inert fixture lacks `inertkit/scripts/portable_paths_check.py`.
- `tests/cli/stale-worktree.test.sh`: 65 pass / 8 fail; its fixture has no `HEAD`, so the portable-paths check refuses.

The full-run verdicts are not otherwise identical: `bun_fail` changed from 4 (serial) to 3 (parallel), while `py_fail=0` in both. These Bun test failures are outside the shell-isomorphism claim and remain visible here; neither full run is claimed green. The parallel run named `tests/cli/gate-plane.test.ts` and two `tests/cli/private-index-land.test.ts` failures. No attempt was made to repair unrelated failures or weaken the publish gate.

## Replay and artifact identity

Both replay commands passed on a clean `git archive` of the same commit followed by `git init -q`, with no source overlay and no `TRUSTED_SOURCE` variables:

- `sh tests/cli/full-suite-verdict-incomplete.test.sh` → rc 0, `pass=68 fail=0`; covers serial/parallel line and count equality, a named planted failing shell suite, and a planted hang that times out, remains uncached, preserves partial output, and leaves no live process or runner side files.
- `sh tests/cli/full-suite-complement.test.sh` → rc 0, 29 pass / 0 fail.

Raw JSON and logs remain in owned scratch `var/agent-tmp/9t6f2-measure.39732/`; release that directory only after this evidence commit is complete. The common stem is `313c3007553e7bdae082356f1205680c875addea.base.5305c2e429d39b3784f9776e85824f4462b05ee6060764aee534812b81e0fd97`.

| Artifact | SHA-256 | Bytes |
|---|---|---:|
| Serial JSON | `90a8f5bf89345809b21756163664048134d74024ca1036b38ff8a2691c370591` | 822390 |
| Serial log | `a74dc94c3c37d556d399bf2b0542ecdb45e6dce8cfbc44cc3bddb71908932e30` | 158981 |
| Parallel JSON | `ceb746c235105a499f5fcfc43a4aded098a74908d0b68f45bf4c600d6acd5834` | 820305 |
| Parallel log | `9edf7f9db325065265fd149948248ca179b285343c97340953a9a6fac386b3b8` | 157155 |

The later `[live]` acceptance box remains unchecked: this measurement is not the next companion publish gate.