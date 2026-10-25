# Portable ergonomics push gate recommendation

Consumer: CLI repositories adopting Joshua's J-2026-10-25-34 requirement. Feature gated: published automation interface, not fleet compliance. Defects: malformed/mixed streams, hanging non-TTY calls, incorrect typo remediation, undocumented exits and incompatible schemas. Delete or supersede this design when the portable gate is implemented and its schema/negative fixtures document the contract. No release-lane files are changed here.

## Admission

An arbitrary CLI cannot safely be crawled by executing guessed verbs. Each repository supplies a small explicit safe argv matrix: discovery, one successful read, a usage error, a typo, and declared raw/JSONL exceptions. This is irreducible policy, not a copied live inventory. Binary location and runtime prerequisites come from the repository's ordinary build. No required omp-kit, sbh, br, Tern, Agent Mail, cc, home layout or host identity. Use platform temporary storage with cleanup, portable bounded subprocess capture, stdin closed, serial runs. Missing success prerequisites => UNVERIFIED with an actionable reason, never a green error-envelope match.

## Checks and cost model

Times below are UNMEASURED. Invocation counts are source-derived costs; T is measured per-call duration on the repository's safe matrix. No suite or target probes ran in this audit.

| Check | Candidate reused logic | Per safe route cost | False-positive / false-pass control |
|---|---|---|---|
| stdout/stderr split | verify-stdout-stderr-split.sh patterns | 2 target calls (help + read), JSON validation | Script currently accepts empty/multiple JSON documents via jq, returns green after target failure and only warns on stderr JSON. Require exactly one declared document, valid success control and mode-specific structured-diagnostic rules; allow declared raw/JSONL. |
| determinism | verify-determinism.sh comparison | 2 sequential target calls + canonicalization | Do not erase every timestamp/_etag recursively: semantic times/hashes matter. Normalize only explicitly declared volatile paths and unordered sets. Compare exit, stream contract and semantic success too. Never freeze observed live facts to force green. |
| non-TTY | verify-non-tty-discipline.sh | 5 target calls; default worst case about 5×(20 s + 1 s kill grace), helper setup extra | Already uses closed stdin and bounded completion separate from inherited descriptors. Generic top-level error checks cannot prove arbitrary schema success; stdin-driven tools need explicit fixture input rather than this helper. Suppressed stderr needs separate capture. No guarantee about actual TTY-only env behavior. |
| capabilities / robot docs presence | existing discovery shape checks | 2–3 safe discovery calls, reusable across checks | Require coherent documented equivalents, not literal verb names for unrelated CLI conventions. Presence is not correctness; unknown-command output is not documentation. |
| schema pin | validate emitted data against versioned consumer schema | 1 schema export plus reused read captures | Enforce required fields/types and declared compatibility. Additive unknown properties must not automatically be breaking. Raw/JSONL contracts explicit. Negative fixture removing/changing a required field must fail. |
| exit-code dictionary | capabilities/schema + observed matrix | 0 extra discovery calls when reused; one call per selected success/error | Dictionaries cannot prove all routes. Assert selected observed exits are covered, raw-child passthrough explicitly declared, never renumber compatibility exits merely to match a universal dictionary. |
| typo handling | existing nearest/semantic suggestions | 2–4 safe error cases | Typos must not authorize execution. Semantic next intent must never recommend test. Suggestions must name an executable correction in scope; shared missing-dependency error is not typo recovery. Pair each planted bad form with valid success control. |

A shared discovery/read cache can reduce duplicated probes, but determinism must still use two fresh executions. A minimal unshared matrix costs roughly 13–18 target calls plus selected error coverage. Wall time is the sum of bounded serial calls, not an asserted millisecond figure. Start advisory when a contract is absent; enforce only after canonical success and planted negatives prove the check. An admitted gate must fail when those negatives are broken. Do not weaken a gate to accommodate current code.

## Upstream script readiness

Do NOT run the stream or determinism scripts unchanged on push: they use hard-coded /tmp captures, lack bounded target execution and do not establish semantic success. The installed intent runner additionally hardcodes 5 seconds and /tmp, conflicting with this audit's 30-second claimed-scratch contract. The non-TTY helper is materially stronger and portable after declared prerequisites and temporary ownership are reconciled, but still needs command-specific success controls.

Proposed src/commands.ts diff: optional per-command output_contract metadata (mode, schema identifier, volatile paths, exit categories, read-only eligibility). Proposed src/cli.ts diff: expose that additive metadata through existing capabilities and schema; documentation points at the gate contract. A later gate implementation belongs in ordinary portable repository tooling, never in this audit's forbidden release lane.
