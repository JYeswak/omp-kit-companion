# B10 slice 1/4: cold LSP measurement and root cause (rz5.43.1)

## Landing status (prior work under this bead)
- B10_LSP_TIMING emission landed as 7487b4497c ("test(lsp): land B10 cold-readiness
  timing emission and refusal distinguishability"), first shipped on origin/main via
  the 2026-10-19 push train (HEAD a9aab55848 at time of writing). No CI run has yet
  executed the emission on main (latest main CI 39202521506 predates the landing).
- No timeout was widened: cold positive control keeps timeoutMs 30_000 / 90s test
  budget (tests/cli/lsp-readiness.test.ts cold test). Debug logging (LSP-DBG) from the
  parked stash extras was never landed, per chief custody note.

## Local measurement (CI=true, darwin-arm64, OMP 18.12.3, 2026-10-20)
`CI=true bun test tests/cli/lsp-readiness.test.ts` → 17 pass, 0 fail (two runs).
B10_LSP_TIMING samples (both PASS, known_positive_reference true,
server_ready_after_request true, reference_retries 0):
- run 1: elapsed_ms 5211.2 — status not_ready (5.5ms) → capabilities (244.8ms) →
  status ready (2.6ms) → references (462.8ms) → symbols (4.8ms); ready on attempt 2.
- run 2: elapsed_ms 4270.2 — status not_ready (6.8ms) → capabilities (242.9ms) →
  status ready → references → symbols; same shape, ~1s faster cold start.
- Whole-test elapsed (~4-5s) >> sum of per-call elapsed (~0.7s): the gap is cold
  typescript-language-server startup inside the OMP-mediated route, not polling.

## Root cause (demonstrated)
'compiled LSP expected PASS, observed INCOMPLETE ... failed_checks=
[known_positive_reference]' occurs when the references turn returns a bare-empty
result because the cold server has not finished loading the project: status reports
configured/not-started on the first poll, and the references result matches neither
`Found [1-9]... reference(s)` + `src/uses.ts` (src/lsp-probe.ts known_positive_reference
check). The route now retries the references turn on bare-empty outcomes bounded by
COLD_START_MAX_REFERENCE_RETRIES with a readiness wait per retry
(cold_start_reference_retry_bounded check), so a slow-but-live server converges to
PASS (local datum above: ready on attempt 2, zero retries needed) while a dead
server still terminates INCOMPLETE/TIMEOUT with the bounded receipt.
Related fail-close trap found during this slice (per GradeL9kv review):
companion da8ac1a43d deleted `const resultsPresent` while keeping its use, forcing
every cold probe UNVERIFIED; repaired by 52c7e95244 before this measurement.

## Planted negative (this slice, local)
- Direct classifier pins pass: INCOMPLETE/TIMEOUT/IMMEDIATE_EXIT/MISSING/WRONG_MARKER
  via classifyLspProbeOutcome, plus buildLspJsonRpcReceipt redacted receipts with
  empty-references / timeout-text / server-exit inputs ("planted: isolated
  cold-refusal inputs stay distinguishable", 17/17 green).
- Deleting the propagation (state = "INCOMPLETE" at src/lsp-probe.ts:726) makes the
  cold positive consumer test fail (16 pass / 1 fail:
  "one alternative root marker permits a real cold request..."); restored after, file
  verified clean. Missing evidence cannot become PASS.

## CI distribution (pending)
No CI run has yet executed the emission (latest main CI 39202521506 predates the
landing; pushes since have not produced main runs). A branch + PR vehicle was
blocked by the shared-worktree guard (no new branches in this worktree). The
distribution (cli-contracts ubuntu-24.04 + native-certification linux-arm64-gnu)
lands here once any post-emission CI runs: grep B10_LSP_TIMING in those job logs.
