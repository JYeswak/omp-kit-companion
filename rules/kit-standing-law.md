---
description: "Standing kit law. No stream condition, so this is not a TTSR rule."
alwaysApply: true
---

A step you can satisfy by believing you did it is not a step.

The twelve forbidden patterns (including their parenthetical qualifications):

1. gate self-weakening ("temporarily" loosening a check to land a change)
2. proof-class inflation (relabeling weak evidence as strong)
3. golden regeneration reflex (regenerating goldens until they pass)
4. commit-stream pumping (many trivial commits to look productive)
5. tautological tests (tests that assert what the code does, not what it should do)
6. easy-lever cherry-picking (only attempting levers known to pass)
7. close-pump abuse (closing beads to move a metric)
8. scope-splitting (splitting work to dodge gate thresholds)
9. spec-editing as progress (editing the spec instead of the code)
10. conformance metastasis (growing the conformance suite instead of fixing failures)
11. dependency smuggling (undeclared dependencies)
12. bench-path hardcoding (special-casing the benchmark input)

Three load-bearing rules sit above the list:

- Never weaken a gate to land a change (B7).
- No self-grading without independent verification.
- Demotions are always allowed (D4).

A self-speedup is maintenance, not a win. A win needs the incumbent live in the same invocation. Report a loss plainly, revert, and try the next lever. This is a maintainer principle, not a benchmark result.

Do not invent a reviewer, a command output, or a commit SHA. If you did not run it, say UNVERIFIED and name the command that would verify it.

## Joshua standing decisions

Mechanisms below are source-observed partial controls, not runtime guarantees; `unenforced` means no checked mechanism. Conflicts are resolved below by the lead (J-2026-11-03-49: decide from data, don't escalate); the newer decision governs unless a line says otherwise.

### Working

- R06: Record direct decisions this turn; deduplicate intake into goal-connected blocks or counted queues without promoting relays into law. [J-2026-10-19-58,J-2026-10-25-97,J-2026-10-26-22] mechanism=scripts/bead_lint.py
- R07: Derive docs, goals and dispatches from one evidence-backed mission/architecture/contracts/measures/risks/exit plan; update observed gaps and consumer wiring. [J-2026-10-19-72,J-2026-10-19-73,J-2026-10-25-54,J-2026-10-25-93,J-2026-10-28-01,J-2026-10-28-02] mechanism=unenforced
- R08: Gate existing/new projects through versioned input-to-ready planning/execution stages; prove mission authority and autonomy before scaling staff. [J-2026-10-20-12,J-2026-10-20-16,J-2026-10-20-24,J-2026-10-20-25,J-2026-10-20-27,J-2026-10-20-40,J-2026-10-24-06,J-2026-10-25-89] mechanism=unenforced
- R09: Reject duplicates/off-mission ideas cheaply with citations; require executable constraints, multi-family rescue, evaluator/budget and revisit evidence before human hard-kill. [J-2026-10-20-17,J-2026-10-20-19,J-2026-10-20-20,J-2026-10-20-26] mechanism=unenforced
- R10: Record human mission/product verdict labels; replay rework; graduate/demote per-gate/size reviews using measured streaks and held-out classifier coverage. [J-2026-10-20-21,J-2026-10-20-22,J-2026-10-20-23,J-2026-10-20-35,J-2026-10-20-36] mechanism=unenforced
- R11: Validate merged plans: zero UNKNOWN/major defects, resource/cancel contracts, independent planted-flaw rounds and evidenced mandatory/project skill coverage. [J-2026-10-20-29,J-2026-10-20-30,J-2026-10-20-31,J-2026-10-20-34] mechanism=unenforced
- R12: Maintain mission-linked claimable work; allow one in-progress bead per seat or logged background-agent wave; repair stale blockers; measure outcomes. [J-2026-10-15-12,J-2026-10-16-08,J-2026-10-16-10,J-2026-10-17-01,J-2026-10-17-02,J-2026-10-17-03,J-2026-10-26-32] mechanism=src/claim-cut.ts
- R13: Honor pauses/mode exceptions; arm only named mission/constraint supply; reject off-cut claims; expose owned exhaustion/refill instead of busywork. [J-2026-10-18-02,J-2026-10-18-52,J-2026-10-24-04,J-2026-10-25-08,J-2026-10-25-46,J-2026-10-25-47,J-2026-10-25-49,J-2026-10-25-102,J-2026-10-26-06,J-2026-10-29-07,J-2026-10-29-18,J-2026-10-30-09,J-2026-10-30-11,J-2026-10-30-12,J-2026-10-30-16,J-2026-10-30-21,J-2026-11-02-13,J-2026-11-02-19] mechanism=src/claim-cut.ts
- R14: Admit builds only with clean rework/custody/dirt/disk/publication/wave/seat readings; permit owned grading and line-clearing repairs. [J-2026-10-26-41,J-2026-10-26-42,J-2026-10-27-03] mechanism=unenforced
- R15: Finish every authorized consumer/file obligation; prioritize quality and published outcomes over parallel activity; preserve original scope. [J-2026-10-25-60,J-2026-10-25-100,J-2026-10-26-44,J-2026-10-27-46] mechanism=unenforced
- R18: Version runbooks as typed trigger/tool/gate/evidence/measure steps; score events and revise from incidents. [J-2026-10-19-65,J-2026-10-19-67] mechanism=unenforced
- R33: Implement shared mechanics once in kitlib; migrate consumers to common resolvers and bounded owned-temp primitives; prevent hand-rolled copies. [J-2026-10-21-18,J-2026-10-21-19,J-2026-10-22-02,J-2026-10-22-05,J-2026-10-22-06,J-2026-10-22-07,J-2026-10-22-08,J-2026-10-26-39] mechanism=src/kitlib/run.ts
- R36: Threat-model projects; apply formal/exploit/fuzz/property/scanning checks; admit pinned official integrity-checked tools/dependencies with exact-version receipts, canary and rollback. [J-2026-10-23-06,J-2026-10-23-09,J-2026-10-23-11,J-2026-10-23-33,J-2026-10-27-19,J-2026-10-27-40,J-2026-10-31-14,J-2026-10-31-18] mechanism=unenforced
- R37: Ship reusable protocols/prompts/skills publicly; configure private operator data; exercise portable defaults and runtime-detected optional adapters. [J-2026-10-17-16,J-2026-10-30-13] mechanism=scripts/pre-push-gate.sh
- R38: Keep uds for Dicklesworthstone upgrades; move fleet infrastructure to kit only after equivalent verification; keep products independent. [J-2026-10-17-15] mechanism=unenforced
- R39: Honor MIT-plus-rider eligibility for Joshua/agents; use narrow tested license exceptions instead of re-asking settled eligibility. [J-2026-10-17-07,J-2026-10-18-24] mechanism=unenforced
- R40: Deliver researched measurable public docs, outsider setup and human/agent ergonomics through shared product gates. [J-2026-10-20-05,J-2026-10-20-07,J-2026-10-21-06,J-2026-10-25-26,J-2026-10-25-34] mechanism=unenforced
- R41: For CC HTTP, serve GET/HEAD; return JSON 405 with Allow for others; permit only the declared non-echoing stored-credential 500. [J-2026-10-23-17,J-2026-10-23-18,J-2026-10-23-23] mechanism=unenforced
- R42: Within CFS, preserve senior frontend/schema/derived-model and real-user hire receipts; require names/phone, optional email; protect production backup/review and separate send/spend/destroy/uninstall grants. [J-2026-10-18-17,J-2026-10-18-18,J-2026-10-18-19,J-2026-11-02-28] mechanism=unenforced
- R43: Keep omp find on approved Clef infrastructure; disqualify uncalibrated judgments; keep Jev product inference local-only. [J-2026-10-15-13] mechanism=unenforced
- R44: Classify OMP events by declared versioned schema; reject undeclared fields/types precisely; admit gated fields from their first declared version. [J-2026-10-29-09] mechanism=unenforced
- R45: Read mature implementing code and prior generations before building/escalating/blocking; report prior/did/applied or searched repositories/queries and justified rebuilding. [J-2026-10-23-26,J-2026-10-23-27,J-2026-10-23-28,J-2026-10-23-30,J-2026-10-24-01,J-2026-10-24-02,J-2026-10-25-10,J-2026-10-25-11,J-2026-10-25-24,J-2026-10-30-22,J-2026-10-30-23,J-2026-11-02-16] mechanism=extensions/kit-flywheel-guard.ts
- R47: Plan resource/actor/day-two lifecycle verbs; turn missing commands or repeated workarounds into owned native-verb improvements. [J-2026-10-25-17,J-2026-10-25-18] mechanism=unenforced
- R48: Inventory machine tools; choose portable stage/language/artifact/math adapters by measured value; encode adoption once and prove actual use. [J-2026-10-27-09,J-2026-10-27-10,J-2026-10-27-11,J-2026-10-27-12,J-2026-10-27-14,J-2026-10-27-18,J-2026-10-27-35,J-2026-10-27-39] mechanism=unenforced

### Saving

- R25: Maintain shared-main history; reserve paths, pin bases and integrate three-way; protect peer bytes/leases; publish verified commits through native checks. [J-2026-10-15-11,J-2026-10-18-48,J-2026-10-21-11,J-2026-10-25-12,J-2026-10-26-33,J-2026-10-26-38,J-2026-10-26-56,J-2026-10-27-73,J-2026-10-27-77,J-2026-10-27-78,J-2026-10-31-19,J-2026-11-01-02,J-2026-11-01-03,J-2026-11-02-07,J-2026-11-02-09,J-2026-11-02-20,J-2026-11-02-21] mechanism=scripts/check-commit-gate.sh
- R31: Create scratch through owned bounded kit primitives; dispose every exit after content-proven durable evidence transfer; use reapers only as crash backstops. [J-2026-10-16-03,J-2026-10-18-10,J-2026-10-18-20,J-2026-10-18-31,J-2026-10-18-49,J-2026-10-19-102,J-2026-10-25-81,J-2026-10-25-82,J-2026-10-30-14,J-2026-10-31-04] mechanism=src/scratch.ts
- R32: Give runners deadlines, bounded reads/memory and whole-group cancellation/reaping; release locks/allocations every exit; reclaim only identity-proven dead leftovers. [J-2026-10-18-28,J-2026-10-18-29,J-2026-10-20-15,J-2026-10-21-17] mechanism=src/kitlib/run.ts
- R34: Maintain measured 20–25 percent internal headroom and safety floor; reclaim through owned routes; hash/receipt external offloads before redirecting access. [J-2026-10-17-17] mechanism=src/heavy.ts
- R35: Fetch secrets from Infisical at use; exclude them from files, environments and output; retire unused credentials without printing. [J-2026-10-11-01,J-2026-10-11-02,J-2026-10-15-01,J-2026-10-15-08] mechanism=extensions/secret-output-guard.ts

### Verifying

- R26: Require independent non-author, non-fixture-author replay of exact-published-tree acceptance and consumers with paired controls/logs; prefer another family, never require it; only non-author seats close. [J-2026-10-18-12,J-2026-10-18-26,J-2026-10-23-31,J-2026-10-26-47,J-2026-10-27-07,J-2026-10-29-06,J-2026-10-29-10,J-2026-10-29-11,J-2026-10-29-20,J-2026-10-30-26] mechanism=extensions/kit-flywheel-guard.ts
- R27: Require lint-passing, phase-tagged, replayable, independently sound acceptance; retain original obligations/failure witnesses; repair preparation defects at the earliest gate. [J-2026-10-21-14,J-2026-10-23-13,J-2026-10-23-14,J-2026-10-23-20,J-2026-10-25-106,J-2026-10-25-107,J-2026-10-25-108,J-2026-10-25-109,J-2026-10-26-23,J-2026-10-26-50,J-2026-10-29-21,J-2026-10-29-22,J-2026-10-30-03,J-2026-10-30-25] mechanism=extensions/kit-flywheel-guard.ts
- R49: Govern hooks/rules/guards through researched versioned owner/retirement lifecycle, paired controls, staged rollout and effect/false-refusal/cost measures; teach reachable safe clearing commands. [J-2026-10-19-69,J-2026-10-19-70,J-2026-10-25-23,J-2026-10-25-30,J-2026-10-25-42,J-2026-10-25-64,J-2026-10-25-96,J-2026-10-25-103,J-2026-10-27-13,J-2026-10-27-71,J-2026-10-27-72,J-2026-11-02-29,J-2026-11-02-30] mechanism=unenforced
- R51: Classify failures; repair earliest admitting mechanisms; daily build a refusal, prove an existing refusal, or record an owned mechanism bead. [J-2026-10-15-10,J-2026-10-18-27,J-2026-10-18-40,J-2026-10-18-50,J-2026-10-19-68,J-2026-10-19-104,J-2026-10-20-03,J-2026-10-20-48,J-2026-10-21-12,J-2026-10-21-15,J-2026-10-22-01,J-2026-10-23-16,J-2026-10-23-19,J-2026-10-25-06,J-2026-10-25-28,J-2026-10-25-29,J-2026-10-25-72,J-2026-10-25-78,J-2026-10-25-101,J-2026-10-25-111,J-2026-10-25-116,J-2026-10-26-07,J-2026-10-26-08,J-2026-10-26-43,J-2026-10-26-49,J-2026-10-26-53,J-2026-10-26-55,J-2026-10-27-33,J-2026-10-27-38,J-2026-10-27-57,J-2026-10-29-14,J-2026-10-30-17,J-2026-10-30-27,J-2026-11-01-13,J-2026-11-01-15,J-2026-11-02-15,J-2026-11-02-24,J-2026-11-03-39,J-2026-11-03-41,J-2026-11-03-43,J-2026-11-03-47,J-2026-11-03-48] mechanism=unenforced
- R52: Change policy/config only with discriminating metric/control, quoted research, bounded canary/rollback and replaced-rule record; reverse harm; never waive acceptance via heuristic changes. [J-2026-10-15-07,J-2026-10-16-01,J-2026-10-17-10,J-2026-10-19-61,J-2026-10-26-40,J-2026-10-31-01,J-2026-11-02-17] mechanism=unenforced

### Releasing

- R19: Derive prompts from the comprehensive plan; promote through complete fail-closed clarity/tools/rules/logging/rigor gates, incumbent comparisons and canary/readback; demote regressions. [J-2026-10-18-14,J-2026-10-18-32,J-2026-10-18-38,J-2026-10-19-60,J-2026-10-19-62,J-2026-10-19-63,J-2026-10-20-43,J-2026-10-20-44,J-2026-10-21-10,J-2026-10-25-31,J-2026-10-25-84,J-2026-10-25-85,J-2026-10-25-98] mechanism=unenforced
- R23: Move published releases automatically through save/self-restart; prove loaded version and restored recorded mode, not merely notice delivery. [J-2026-10-17-11,J-2026-10-18-39,J-2026-10-18-47,J-2026-10-19-55,J-2026-10-20-09,J-2026-10-25-36] mechanism=extensions/kit-upgrade-notice.ts
- R24: Default safeguards on; record reasoned opt-outs; activate verified work with rollback and actual consumer/version readback. [J-2026-10-27-59,J-2026-10-27-61,J-2026-11-02-26] mechanism=src/activation.ts
- R28: Derive executable trains from live constraints; record authorized recuts but preserve original membership/misses; close only when every owed member is evidenced complete. [J-2026-11-01-11,J-2026-11-01-12,J-2026-11-01-14,J-2026-11-01-16,J-2026-11-02-22] mechanism=unenforced
- R29: Have the lead release certified published trees locally; prove accepted/published/running and repeated push-through-installed within four minutes, including local tests; preserve exact-tree proof. [J-2026-10-18-22,J-2026-10-18-23,J-2026-10-18-30,J-2026-10-20-33,J-2026-10-21-05,J-2026-10-25-16,J-2026-10-25-27,J-2026-10-27-63,J-2026-10-27-65,J-2026-10-29-02,J-2026-10-29-13,J-2026-10-30-19,J-2026-10-30-20,J-2026-10-31-03,J-2026-10-31-05,J-2026-10-31-11,J-2026-11-01-05,J-2026-11-01-07,J-2026-11-02-32,J-2026-11-03-35,J-2026-11-03-36,J-2026-11-03-40] mechanism=scripts/release-local.sh
- R30: Keep affected-only commit/push/land fast through tested selection and identity-bound verdict reuse; check cheap prerequisites before load-admitted parallel work; retain full release qualification. [J-2026-10-25-88,J-2026-10-27-80,J-2026-10-29-17,J-2026-10-31-08,J-2026-10-31-09,J-2026-10-31-10,J-2026-10-31-12,J-2026-10-31-15,J-2026-11-01-04,J-2026-11-02-06,J-2026-11-03-34] mechanism=scripts/release-local.sh

### Fleet

- R04: Keep one lead for ecosystem guidance, production and Joshua communication; use its own agents, not CFS seats or peer-chief waits. [J-2026-10-17-08,J-2026-10-19-56,J-2026-10-19-57,J-2026-10-19-74,J-2026-10-21-16,J-2026-10-22-03,J-2026-10-22-04,J-2026-10-23-10,J-2026-10-25-43,J-2026-10-25-50,J-2026-10-29-08,J-2026-10-30-07,J-2026-10-31-02,J-2026-11-01-06,J-2026-11-02-27,J-2026-11-03-38,J-2026-11-03-46] mechanism=unenforced
- R05: Give every item a durable owner and checked outcome; transfer/release/reap owned state with receipts on cancellation or respawn. [J-2026-10-16-05,J-2026-10-17-05,J-2026-10-18-07,J-2026-10-18-08,J-2026-10-20-11,J-2026-10-21-08,J-2026-10-21-09] mechanism=src/kitlib/proc.ts
- R16: Detach long finite work with deadlines; collect boundary results while continuing authorized work, without blocking waits or polling. [J-2026-10-18-43,J-2026-10-19-64,J-2026-10-21-04] mechanism=extensions/kit-flywheel-guard.ts
- R17: Use Sol 6.1 or explicitly permitted Muse for lead agents, never Opus 5.5; preserve measured quota/scoped model overrides across restart. [J-2026-10-18-33,J-2026-10-18-34,J-2026-10-18-41,J-2026-10-25-58,J-2026-10-27-17,J-2026-10-27-41,J-2026-10-27-45,J-2026-10-27-74,J-2026-10-28-04,J-2026-10-29-03,J-2026-10-29-04,J-2026-10-29-19,J-2026-11-01-01,J-2026-11-03-37,J-2026-11-03-44] mechanism=unenforced
- R21: Resolve live Tern/OMP targets natively without registry admission; return busy queued verdict within one second; prove later consumption or failure. [J-2026-10-25-91,J-2026-10-30-02,J-2026-10-30-04,J-2026-11-01-10] mechanism=src/send.ts
- R22: Restore each seat’s recorded identity/session/mode, including goal-less or paused exceptions; prove composer/receiver continuity and preserve release/suite work. [J-2026-10-18-01,J-2026-10-18-06,J-2026-10-18-15,J-2026-10-18-16,J-2026-10-18-21,J-2026-10-18-25,J-2026-10-18-42,J-2026-10-18-44,J-2026-10-18-45,J-2026-10-18-46,J-2026-10-25-02,J-2026-10-25-37,J-2026-10-25-38,J-2026-10-25-39,J-2026-10-25-90,J-2026-10-25-104,J-2026-10-26-01,J-2026-10-26-11,J-2026-10-26-18,J-2026-10-26-20,J-2026-10-26-35,J-2026-10-26-36,J-2026-10-26-37,J-2026-10-30-06,J-2026-10-31-07] mechanism=extensions/kit-flywheel-guard.ts
- R50: Mine cross-project/external repositories monthly through native evidence intake, ownership, ranked dispositions and adoption measures; give daily failures effective mechanisms or owned beads. [J-2026-10-25-19,J-2026-10-25-20,J-2026-10-25-21,J-2026-10-25-32] mechanism=unenforced
- R53: Collect attributable deterministic fleet events in one ledger; derive bounded incremental role/project/mission measures/countermetrics; give every bad/UNKNOWN reading cause/owner/action/consequence. [J-2026-10-17-12,J-2026-10-17-13,J-2026-10-20-41,J-2026-10-24-07,J-2026-10-25-01,J-2026-10-25-07,J-2026-10-25-09,J-2026-10-25-44,J-2026-10-25-45,J-2026-10-25-55,J-2026-10-25-56,J-2026-10-25-99,J-2026-10-26-09,J-2026-10-26-26,J-2026-10-26-28,J-2026-10-26-29,J-2026-10-27-47,J-2026-10-27-56,J-2026-10-31-16,J-2026-10-31-17,J-2026-11-02-04,J-2026-11-02-05,J-2026-11-02-11,J-2026-11-02-12] mechanism=unenforced

### Communication

- R01: Attribute instructions to their actual author; retain agent provenance and never promote relays into Joshua authority. [J-2026-10-25-41] mechanism=unenforced
- R02: Preserve verbatim Joshua quotes; use native terms, explicit actors/triggers/scope, comprehension checks and English tracker/mail text. [J-2026-10-18-35,J-2026-10-18-36,J-2026-10-18-37] mechanism=unenforced
- R03: Answer Joshua immediately with measured precedent; decide authorized matters; escalate only human-owned choices through prepared one-step lead requests. [J-2026-10-15-03,J-2026-10-15-04,J-2026-10-15-05,J-2026-10-15-06,J-2026-10-15-09,J-2026-10-17-04,J-2026-10-17-09,J-2026-10-27-75,J-2026-10-27-79,J-2026-10-29-15,J-2026-10-30-08,J-2026-10-31-20,J-2026-10-31-22,J-2026-11-01-09,J-2026-11-02-23] mechanism=extensions/kit-flywheel-guard.ts
- R20: ACK typed mail obligations individually; prove recipient wake, not persistence; queue mid-turn wakes until turn end. [J-2026-10-18-11,J-2026-10-18-13,J-2026-10-20-47,J-2026-10-26-13,J-2026-10-26-19] mechanism=extensions/kit-agent-mail-guard.ts
- R46: Cite fetched sources with URL, retrieval time, exact quote and changed decision/artifact; exclude memory-only or unapplied citations. [J-2026-10-25-22] mechanism=unenforced
- R54: Report raw-backed shipped value, goal target/trend, dated owned commitments, risks, causal gaps and next measurable change immediately; retain queryable multi-day deltas. [J-2026-10-25-92,J-2026-10-25-113,J-2026-10-26-21,J-2026-10-26-25,J-2026-10-26-27,J-2026-10-26-51,J-2026-10-26-54,J-2026-10-27-04,J-2026-10-29-05,J-2026-11-02-02,J-2026-11-02-03] mechanism=unenforced

### Review and deltas

- Record same-day decision deltas with Joshua’s verbatim words in `~/.claude/skills/omp-kit-orchestration/decisions/joshua.jsonl`; update this law the same day. [J-2026-10-19-58] mechanism=unenforced
- Review monthly (next 2026-12-03), quarterly (next 2027-02-03), and yearly (next 2027-11-03); reconcile sources, conflicts, coverage and stale mechanisms. [J-2026-10-25-19] mechanism=unenforced


### Conflict dispositions

Resolved by the lead on 2026-11-03 (J-2026-11-03-49). Basis: the newer decision supersedes the older, except where a loaded source (AGENTS.md) already states the rule.
- C1: 4 minutes means push to installed, tests included [J-2026-11-03-35,J-2026-11-03-36,J-2026-11-03-40]; supersedes the release-reading reading [J-2026-10-31-11,J-2026-11-02-32]. mechanism=unenforced
- C2: a different model family is preferred; a same-family reviewer is allowed when disclosed [J-2026-10-29-11, AGENTS.md J-2026-10-18-12]; supersedes the strict mandate [J-2026-10-23-31,J-2026-10-25-61,J-2026-10-30-07]. mechanism=unenforced
- C3: a non-author verifies; when no other seat is active the lead records the close on that evidence [J-2026-11-03-49, J-2026-11-03-46]; nobody closes work they authored [J-2026-11-01-18]. mechanism=extensions/kit-flywheel-guard.ts
- C4: one chief, no waits on a peer chief [J-2026-10-30-07,J-2026-10-27-68,J-2026-10-26-52]; supersedes [J-2026-11-01-19]. mechanism=unenforced
- C5: off-constraint seats report NO-WORK and repair stays scoped [J-2026-10-29-18,J-2026-10-30-09], as AGENTS.md states; the downtime grader queue [J-2026-10-30-16,J-2026-10-30-21] applies only on the declared constraint. mechanism=unenforced
- C6: a cut is derived from live state; an authorized recut keeps its recorded misses [J-2026-11-02-08,J-2026-11-02-22]; supersedes fixed train membership [J-2026-11-01-16]. mechanism=unenforced
- C7: only narrow, tested safe-path repairs; no gate is weakened [J-2026-11-02-29]; supersedes self-set relaxations [J-2026-10-26-40,J-2026-10-27-59,J-2026-10-31-01,J-2026-10-31-05]. mechanism=unenforced
- C8: a restart restores each seat's recorded mode, so goal-less directors and owner pauses are kept [J-2026-10-31-07,J-2026-10-29-07,J-2026-10-26-37]; supersedes universal goal resumption [J-2026-10-25-38,J-2026-10-26-02]. mechanism=unenforced
- C9: fresh sessions are allowed; resume is for scoped recovery [J-2026-10-31-07,J-2026-10-18-21]; the fresh-only reading [J-2026-10-25-02] is superseded. mechanism=unenforced
- C10: rollouts use the named-canary readiness steps [J-2026-10-19-63,J-2026-10-20-44]; supersedes all-at-once with no canary [J-2026-10-18-38]. mechanism=unenforced

