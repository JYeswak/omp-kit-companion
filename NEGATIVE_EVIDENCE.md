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

## NE-6 (2026-09-24) — replace `kit-test-skip`'s regex with AST patterns

- Hypothesis: AST patterns distinguish actual test-skip markers from text mentions without losing blocking behavior.
- Historical result: a private candidate classified sampled edit/write payloads more precisely, but both live skip scenarios wrote the target file before the AST interrupt. On omp 18.3.0, `astCondition` was evaluated at `toolcall_end` after the write. Matching accuracy did not imply blocking. Those experiment logs are private; the public harness and live suite can be rerun against a new omp release.
- Verdict: NO-SHIP for blocking rules. The regex remains; G1 rejects `astCondition` on tripwires.
- Retry condition: on a newer omp, an AST-only tripwire passes the live `test-skip-ts-fire` scenario with `web/app.test.ts` absent. Only then reconsider the G1 restriction.

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

## NE-9 (2026-10-02) — `update --apply` from a release whose rule-case counts differ

- Hypothesis: `omp-kit update --apply` from v0.2.0 to v0.2.1 completes on a real HOME, as the 0.2.0 → candidate journey did.
- Result: refused on the maintainer's machine (OMP 18.4.9 unchanged before and after). The postcheck reported `OMP_CHANGED_DURING_KIT_UPDATE` with G2/G3 "case count did not match the shipped contract". The running binary judges the new release with its own compiled counts (v0.2.0: 274 cases, 138 quiet; v0.2.1: 278 and 140 after the quoted-text fixes), and a failed run's missing OMP version is misread as an OMP change. The earlier journey passed only because its candidate had the same case count. `omp-kit undo` restored v0.2.0 cleanly; the installer then installed v0.2.1, and `test` passes on it.
- Verdict: kit bug. The fix takes the expected counts from the release being judged and reports an OMP change only when two successful identity reads differ. Until a release carrying the fix is the one running the update, upgrade by reinstalling with the installer (README).
- Retry condition: an update from a fixed release to a build with more cases completes in the journey test, and a mutant that uses the running binary's counts fails it.

## NE-10 (2026-10-02) — metamorphic relation breaks recorded as known limits

- Hypothesis: the five MT3 relations hold for every rule case (quoting suppresses;
  whitespace, env prefix, path form and chaining preserve the verdict).
- Measured result (`bun scripts/ttsr-harness.ts --metamorphic-json`, 295 cases,
  1765 variants, OMP 18.4.9): 182 breaks. Quoting 138 (quoted payload still fires;
  rules deliberately match quoted shell words, e.g. `''commit''` forms, and a local
  regex cannot tell `echo "..."` from `bash -c "..."`); backslash-newline
  continuations 37 (wire-position anchors match at wire start or after shell
  separators, not after a continuation); env-prefix 4 fire-quiet (same anchor
  family, e.g. `FOO=1 pkill`) plus 3 quiet-fire where the prefix defeats the
  HOME=/tmp test-harness exemption; leading/trailing space, chaining and
  path-form hold everywhere (the one leading-space miss, kit-no-pattern-kill,
  was fixed by allowing `\\s*` after wire starts).
- Verdict: record, do not fix by loosening anchors here. Anchor and quoting
  semantics are recall/precision tradeoffs owned per rule; loosening them risks
  the prose false-fires S4/R1 closed. Per-rule fixes go to fix beads (quoting
  exclusions Q1/Q2/Q3, continuation matching W, env-prefix anchors E); this
  entry keeps the measurement.
- Ratchet adopted 2026-10-02: `scripts/ladder.sh` runs the metamorphic step
  against `tests/cli/metamorphic-baseline.json` (170 known break ids, each
  with a FIX-class reason; re-measured on OMP 18.4.10: quoting 126,
  whitespace 37, env-prefix 7 over 295 cases / 1746 variants). 12 of the
  original 182 were text/thinking-scope prose-in-quotes where firing is
  correct; the harness now skips the quoting relation there instead of
  counting breaks. A NEW break fails the ladder; a fixed break is removed
  from the baseline by hand-edit (no auto-update, so the count can only
  fall by review). Nothing is listed as known without its reason.
- Retry condition: re-run the metamorphic report after any rule-condition edit;
  a class reaching zero breaks is removed from this entry and the baseline.
