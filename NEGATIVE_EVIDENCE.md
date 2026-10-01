# Negative evidence

Refuted hypotheses and no-ship experiments for omp-kit. Read before changing TTSR policy, changing tripwire wording, or adding a rule. These entries retain their original identifiers and verdicts. Historical model/corpus measurements below came from private sessions that are **not distributed** with this repository. They are observations, not independently reproducible public benchmarks; use the named retry condition and run the relevant public gates before changing a rule.

## NE-1 (2026-09-24) — `contextMode: keep` exposes a blocked partial tool call

- Hypothesis: with `ttsr.contextMode: keep`, an aborted assistant message retains the partial tool call, helping the model identify the blocked command.
- Historical result: in four aborted messages examined under omp 18.3.0, the retained message contained text but no `toolCall` block. `keep` preserves earlier prose; it does not make the blocked call visible. The session JSONL is private and is not included here.
- Verdict: REFUTED.
- Retry condition: a future omp release persists partial tool calls after a TTSR abort or passes matched text to the interrupt template. Inspect a fresh, consented probe session before changing attribution wording.

## NE-2 (2026-09-24) — "Your last `bash` call" stops retry loops

- Hypothesis: describing the blocked call as "your last bash call" prevents the model from retrying it.
- Historical result: in a private A/B experiment with six runs per wording, the older wording produced one loop-free run; wording that says the call was cut off while being written produced six. An aborted tool call was not the last visible call in the transcript. Private model runs and their grading files are not included here; these counts are not a portable performance claim.
- Verdict: REFUTED.
- Retry condition: NE-1's retry condition becomes true and the blocked call is actually visible.

## NE-3 (2026-09-24) — add a rule against local cargo builds

- Hypothesis: local Rust builds bypassing a remote-build shim remain frequent enough to warrant a new TTSR rule.
- Historical result: private bash-session sampling showed a high historical rate that declined near the end of the sampled period. The recent window had 11 potential hits in roughly 69,000 commands and no confirmed local builds. The corpus and paths to it are private; do not treat those figures as a public baseline.
- Verdict: NO-SHIP.
- Retry condition: a newly authorized command corpus shows at least 20 matching local-cargo calls with confirmed local builds in any seven-day window after 2026-09-24.

## NE-4 (2026-09-24) — accept a closing `'` as a bypass-flag boundary

- Hypothesis: adding a single quote to the flag lookahead catches real single-quoted shell bypass flags without new false fires.
- Historical result: in the historical corpus comparison, the two newly matched calls were quoted heredoc documentation, not bypasses. A separate executable-flag bypass after a search command revealed a narrower lookbehind defect; the rule and `cases/cases.tsv` retain that distinction. The historical corpus is not distributed. Later cases also exercise a single-quoted `--no-verify` flag, so do not assume this old result describes every quoted-flag case in the current rule.
- Verdict: REFUTED for the broad lookahead change; not a finding that single-quoted flags are safe.
- Retry condition: an executable bypass followed by `'` is observed and a candidate catches it without firing on heredoc prose or quiet streamed prefixes.

## NE-5 (2026-09-25) — treat every encoded newline as a Git command boundary

- Hypothesis: recognizing `\\n` beside `git` captures column-zero shell commands without confusing input data with execution.
- Historical result: one newly matched call used a quoted heredoc as test input to `omp ttsr test`, not as an executable bypass. This counterexample defeated the no-new-false-fire hypothesis. The original corpus row is private. The runtime guard's shell lexer, rather than this lexical TTSR expansion, must assess executable heredoc bodies.
- Verdict: NO-SHIP.
- Retry condition: a candidate separates executable shell input from quoted test/documentation input on a fresh authorized corpus and preserves every quiet streamed prefix, without a blanket heredoc exemption.

## NE-6 (2026-09-24; retried 2026-10-01) — AST candidate for kit-test-skip

- Hypothesis: AST patterns distinguish actual test-skip markers from text mentions without losing blocking behavior.
- Historical result: on OMP 18.3.0, astCondition was evaluated after the write, so both private live skip scenarios wrote their target files. Verdict was NO-SHIP and G1 rejected blocking AST tripwires.
- Retry result on OMP 18.4.9: the AST candidate with astLiveScenario test-skip-ts-fire blocked before execution; web/app.test.ts was absent. The same scenario with the AST plugin disabled wrote web/app.test.ts and named no rule (planted negative). G1/G2/G3 passed 278/278 cases with 0 quiet-prefix fires. The regex conditions remain as a compatibility fallback.
- Verdict: SHIP candidate evidence is green on OMP 18.4.9; the kit gate accepts a blocking astCondition only when it names the pre-execution live scenario. This is not coverage of all test-skip forms or older OMP releases.
- Retry condition: if a future OMP release fails the named live scenario or the AST candidate loses a required fire/quiet case, revert to the regex-only rule and reopen NE-6.

## NE-7 (2026-09-24) — replace `rs-unsafe-added-router`'s regex with AST patterns

- Hypothesis: AST patterns catch syntactic `unsafe` added to Rust while ignoring comments and strings.
- Historical result: the best pattern set matched 11/19 private samples against 16/19 for the regex. Pattern strings could not express every item carrying an unsafe modifier, and the observed TTSR interface accepted pattern strings rather than structured ast-grep rules. The sample script is not distributed, so the count is an archival observation rather than a current conformance claim.
- Verdict: NO-SHIP.
- Retry condition: omp accepts structured ast-grep rule objects, or a new pattern set matches at least the regex's 16/19 on equivalent samples while retaining every positive case.

## NE-8 (2026-10-01) — late TTSR interrupt aborts the run instead of continuing the turn

- Hypothesis: a TTSR interrupt that fires at or after assistant-message completion still continues the turn with the interrupt message.
- Historical result: `test-skip-ts-fire` (short post-match tail) failed 8/20 local runs on omp 18.4.6 and 4/28 on 18.4.8 with the identical signature — 1 model request, rule named 0x, omp exit 1, file correctly absent — while three control scenarios passed 30/30 and the same scenario with a ~25-line post-match tail passed 10/10. Root-cause path: the installed `@oh-my-pi/pi-coding-agent` package schedules the post-interrupt continuation 50 ms out, and the turn continues only if the abort is still pending, the prompt generation is unchanged, and the target message is still found; otherwise the gate resolves without continuing and the run ends. An upstream issue draft with file:line refs was prepared from this evidence; filing is tracked separately.
- Verdict: NO kit fix — the abort/continue decision is inside omp. The gating `test-skip-ts-fire` scenario carries a realistic post-match tail, and the short-tail shape survives as the report-only `omp-late-interrupt-probe` scenario.
- Retry condition: when an omp release continues 20/20 on the probe scenario, make it gating again and delete this note.
