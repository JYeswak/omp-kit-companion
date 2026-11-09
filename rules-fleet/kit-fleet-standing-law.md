---
description: "Joshua's personal standing decisions for opt-in fleet installs."
alwaysApply: true
---

## Joshua standing decisions

Mechanisms below are source-observed partial controls, not runtime guarantees; `unenforced` means no checked mechanism. Conflicts are resolved below by the lead (J-2026-11-03-49: decide from data, don't escalate); the newer decision governs unless a line says otherwise.

### Working

- R06: Record direct decisions this turn; deduplicate intake into goal-connected blocks or counted queues without promoting relays into law. [J-2026-10-19-58,J-2026-10-25-97,J-2026-10-26-22] mechanism=unenforced
- R07: Derive docs, goals and dispatches from one evidence-backed mission/architecture/contracts/measures/risks/exit plan; update observed gaps and consumer wiring. [J-2026-10-19-72,J-2026-10-19-73,J-2026-10-25-54,J-2026-10-25-93,J-2026-10-28-01,J-2026-10-28-02] mechanism=unenforced
- R08: Unpause or add seats only after live data proves the project's mission authority and that the seats can work on their own. [J-2026-10-20-12,J-2026-10-25-89,J-2026-11-05-09,J-2026-11-06-03] mechanism=unenforced
- R11: A plan is ready when every item names its resource and cancel contract and executable acceptance with a planted negative; no UNKNOWN or major defect remains. [J-2026-10-20-29,J-2026-10-20-30,J-2026-10-20-31,J-2026-10-20-34,J-2026-11-06-07] mechanism=unenforced
- R12: Maintain mission-linked claimable work; allow one in-progress bead per seat or logged background-agent wave (CLAIM_REFUSED); repair stale blockers; measure outcomes. [J-2026-10-15-12,J-2026-10-16-08,J-2026-10-16-10,J-2026-10-17-01,J-2026-10-17-02,J-2026-10-17-03,J-2026-10-26-32,J-2026-11-07-02] mechanism=extensions/kit-flywheel-guard.ts
- R13: Honor owner pauses and Joshua-assigned missions over goal-mode work; reject off-cut claims; never sit idle with ready work: keep a builder on the clearing bead, and report real exhaustion with its owner. [J-2026-10-29-18,J-2026-10-30-09,J-2026-11-02-13,J-2026-11-05-11,J-2026-11-06-01,J-2026-11-06-02] mechanism=unenforced
- R15: Finish every authorized consumer/file obligation; prioritize quality and published outcomes over parallel activity; preserve original scope. [J-2026-10-25-60,J-2026-10-25-100,J-2026-10-26-44,J-2026-10-27-46] mechanism=unenforced
- R33: Use native omp/Tern surfaces first. Put shared mechanics in kitlib only where no native surface covers them, implemented once, with consumers migrated and no hand-rolled copies. [J-2026-10-21-18,J-2026-10-22-02,J-2026-10-26-39,J-2026-11-06-06,J-2026-11-07-05] mechanism=src/kitlib/run.ts
- R36: Admit tools and dependencies only as pinned, official releases with a verified checksum, an exact-version receipt and a rollback path. Threat-model checks run only where a bead's acceptance needs them. [J-2026-10-23-06,J-2026-10-27-19,J-2026-10-31-14,J-2026-10-31-18,J-2026-11-06-10,J-2026-11-06-11] mechanism=unenforced
- R37: Ship reusable protocols/prompts/skills publicly; configure private operator data; exercise portable defaults and runtime-detected optional adapters (the gate checks portable paths only). [J-2026-10-17-16,J-2026-10-30-13] mechanism=scripts/pre-push-gate.sh
- R38: Keep uds for Dicklesworthstone upgrades; move fleet infrastructure to kit only after equivalent verification; keep products independent. [J-2026-10-17-15] mechanism=unenforced
- R39: Honor MIT-plus-rider eligibility for Joshua/agents; use narrow tested license exceptions instead of re-asking settled eligibility. [J-2026-10-17-07,J-2026-10-18-24] mechanism=unenforced
- R40: Deliver researched, measurable public docs, outsider setup and human/agent ergonomics, proven by each bead's executable acceptance. [J-2026-10-20-05,J-2026-10-20-07,J-2026-10-21-06,J-2026-10-25-26,J-2026-10-25-34,J-2026-11-07-08] mechanism=unenforced
- R41: For CC HTTP, serve GET/HEAD; return JSON 405 with Allow for others; permit only the declared non-echoing stored-credential 500 (enforced in omp-kit scripts/cc/cc_http.py). [J-2026-10-23-17,J-2026-10-23-18,J-2026-10-23-23] mechanism=unenforced
- R42: Within CFS, preserve senior frontend/schema/derived-model and real-user hire receipts; require names/phone, optional email; protect production backup/review and separate send/spend/destroy/uninstall grants. [J-2026-10-18-17,J-2026-10-18-18,J-2026-10-18-19,J-2026-11-02-28] mechanism=unenforced
- R43: Keep omp find on approved Clef infrastructure; disqualify uncalibrated judgments; keep Jev product inference local-only. [J-2026-10-15-13] mechanism=unenforced
- R44: Classify OMP events by declared versioned schema; reject undeclared fields/types precisely; admit gated fields from their first declared version. [J-2026-10-29-09] mechanism=unenforced
- R45: Read mature implementing code and prior generations before building/escalating/blocking; report prior/did/applied or searched repositories/queries and justified rebuilding. [J-2026-10-23-26,J-2026-10-23-27,J-2026-10-23-28,J-2026-10-23-30,J-2026-10-24-01,J-2026-10-24-02,J-2026-10-25-10,J-2026-10-25-11,J-2026-10-25-24,J-2026-10-30-22,J-2026-10-30-23,J-2026-11-02-16] mechanism=extensions/kit-flywheel-guard.ts
- R47: Plan resource/actor/day-two lifecycle verbs; turn missing commands or repeated workarounds into owned native-verb improvements. [J-2026-10-25-17,J-2026-10-25-18] mechanism=unenforced
- R48: Inventory machine tools; choose portable stage/language/artifact/math adapters by measured value; encode adoption once and prove actual use. [J-2026-10-27-09,J-2026-10-27-10,J-2026-10-27-11,J-2026-10-27-12,J-2026-10-27-14,J-2026-10-27-18,J-2026-10-27-35,J-2026-10-27-39] mechanism=unenforced

### Saving

- R25: Keep main's history shared and linear: builders commit in Worktrunk worktrees and never push, one writer per file per wave; only the lead lands to main with three-way integration; commits and pushes run affected tests only and are never refused for a red main. [J-2026-10-15-11,J-2026-11-02-20,J-2026-11-07-01,J-2026-11-08-10,J-2026-11-08-11] mechanism=scripts/check-commit-gate.sh
- R31: Create scratch through owned bounded kit primitives; dispose every exit after content-proven durable evidence transfer; use reapers only as crash backstops. [J-2026-10-16-03,J-2026-10-18-10,J-2026-10-18-20,J-2026-10-18-31,J-2026-10-18-49,J-2026-10-19-102,J-2026-10-25-81,J-2026-10-25-82,J-2026-10-30-14,J-2026-10-31-04] mechanism=src/scratch.ts
- R32: Give runners deadlines, bounded reads/memory and whole-group cancellation/reaping; release locks/allocations every exit; reclaim only identity-proven dead leftovers. [J-2026-10-18-28,J-2026-10-18-29,J-2026-10-20-15,J-2026-10-21-17] mechanism=src/kitlib/run.ts
- R34: Before heavy work run `sbh check --need 10G` and check load against cores. When load is high, look first for leftover processes. Reclaim through owned routes (forced tool-cache prune allowed). Hash and receipt external offloads before redirecting access. [J-2026-10-17-17,J-2026-11-05-02,J-2026-11-06-13] mechanism=src/heavy.ts
- R35: Agents write and use Infisical secrets but never read their values: inject them only into a child process. Native dcg packs and restrictedFolders hold the authority. Never print, persist or export secrets. Retire unused credentials without printing them. [J-2026-10-11-01,J-2026-10-15-08,J-2026-11-08-01,J-2026-11-08-06] mechanism=extensions/secret-output-guard.ts

### Verifying

- R26: Close a bead only on its acceptance tests' verdict run on the exact pushed tree, including a planted negative; nobody closes work they authored; keep a non-author review only for acceptance a test cannot express. [J-2026-11-01-18,J-2026-11-03-49,J-2026-11-06-07,J-2026-11-07-08] mechanism=extensions/kit-flywheel-guard.ts
- R27: Require lint-passing, phase-tagged, replayable, independently sound acceptance; retain original obligations/failure witnesses; repair preparation defects at the earliest gate. [J-2026-10-21-14,J-2026-10-23-13,J-2026-10-23-14,J-2026-10-23-20,J-2026-10-25-106,J-2026-10-25-107,J-2026-10-25-108,J-2026-10-25-109,J-2026-10-26-23,J-2026-10-26-50,J-2026-10-29-21,J-2026-10-29-22,J-2026-10-30-03,J-2026-10-30-25] mechanism=extensions/kit-flywheel-guard.ts
- R49: Govern hooks/rules/guards through researched versioned owner/retirement lifecycle, paired controls, staged rollout and effect/false-refusal/cost measures; teach reachable safe clearing commands. [J-2026-10-19-69,J-2026-10-19-70,J-2026-10-25-23,J-2026-10-25-30,J-2026-10-25-42,J-2026-10-25-64,J-2026-10-25-96,J-2026-10-25-103,J-2026-10-27-13,J-2026-10-27-71,J-2026-10-27-72,J-2026-11-02-29,J-2026-11-02-30] mechanism=unenforced
- R51: Classify failures; repair earliest admitting mechanisms; daily build a refusal, prove an existing refusal, or record an owned mechanism bead. [J-2026-10-15-10,J-2026-10-18-27,J-2026-10-18-40,J-2026-10-18-50,J-2026-10-19-68,J-2026-10-19-104,J-2026-10-20-03,J-2026-10-20-48,J-2026-10-21-12,J-2026-10-21-15,J-2026-10-22-01,J-2026-10-23-16,J-2026-10-23-19,J-2026-10-25-06,J-2026-10-25-28,J-2026-10-25-29,J-2026-10-25-72,J-2026-10-25-78,J-2026-10-25-101,J-2026-10-25-111,J-2026-10-25-116,J-2026-10-26-07,J-2026-10-26-08,J-2026-10-26-43,J-2026-10-26-49,J-2026-10-26-53,J-2026-10-26-55,J-2026-10-27-33,J-2026-10-27-38,J-2026-10-27-57,J-2026-10-29-14,J-2026-10-30-17,J-2026-10-30-27,J-2026-11-01-13,J-2026-11-01-15,J-2026-11-02-15,J-2026-11-02-24,J-2026-11-03-39,J-2026-11-03-41,J-2026-11-03-43,J-2026-11-03-47,J-2026-11-03-48] mechanism=unenforced
- R52: Change policy/config only with a discriminating metric or paired control, cited research, a bounded canary with rollback, and a record of the rule it replaces. Reverse harm. Repair false refusals through a narrow tested path, never by weakening a gate. [J-2026-10-15-07,J-2026-10-17-10,J-2026-11-02-17,J-2026-11-02-29,J-2026-11-07-08] mechanism=unenforced

### Releasing

- R19: Change prompts against the incumbent on a named canary with readback; demote regressions. [J-2026-10-19-63,J-2026-10-20-44,J-2026-11-07-08] mechanism=unenforced
- R23: Every seat, paused goal or not, moves to each published release through save and self-restart; prove the loaded version and the restored mode, not delivery of the notice. [J-2026-10-18-39,J-2026-11-09-03] mechanism=extensions/kit-upgrade-notice.ts
- R24: Default safeguards on; record reasoned opt-outs; activate verified work with rollback and actual consumer/version readback. [J-2026-10-27-59,J-2026-10-27-61,J-2026-11-02-26] mechanism=src/activation.ts
- R28: Cut a release once, when its scope of fixes has landed, from an exact green-main sha; record any authorized recut with what it dropped. [J-2026-11-02-22,J-2026-11-06-14,J-2026-11-07-08] mechanism=unenforced
- R29: The lead runs the automated release path (green main, tag, build, sign, publish, install) on an exact frozen sha. The full suite runs once per release on remote workers. Prove the installed version is the one loaded. A release never blocks saving. [J-2026-11-03-50,J-2026-11-07-08,J-2026-11-07-09,J-2026-11-08-10,J-2026-11-08-11] mechanism=scripts/release-local.sh
- R30: Keep affected-only commit/push/land fast through tested selection and identity-bound verdict reuse; check cheap prerequisites before load-admitted parallel work; a red release verdict stops only that release; commits and pushes on a red main are reported, never refused. [J-2026-10-25-88,J-2026-11-03-34,J-2026-11-08-05,J-2026-11-08-10,J-2026-11-08-11] mechanism=scripts/pre-push-gate.sh

### Fleet

- R04: The lead (PeachLeopard) is chief and director of omp-kit and Joshua's single point of communication; it works through its own background agents, never CFS seats, and waits on no peer. [J-2026-11-03-46,J-2026-11-06-04,J-2026-11-09-01] mechanism=unenforced
- R05: Give every item a durable owner and checked outcome; on cancellation or restart, transfer, release or reap owned state with receipts, judging liveness by pid incarnation, never a bare pid. [J-2026-10-16-05,J-2026-10-21-08,J-2026-10-21-09] mechanism=src/kitlib/proc.ts
- R16: Detach long finite work with deadlines; collect boundary results while continuing authorized work, without blocking waits or polling. [J-2026-10-18-43,J-2026-10-19-64,J-2026-10-21-04] mechanism=extensions/kit-flywheel-guard.ts
- R17: Background task agents run Sol 6.1 or Muse 1.3 contributor, never Opus 5.5, set by omp `task.agentModelOverrides` in every profile's config.yml so it survives restart. [J-2026-11-03-37,J-2026-11-03-44,J-2026-11-05-15] mechanism=unenforced
- R21: Resolve live Tern/OMP targets natively without registry admission; return busy queued verdict within one second; prove later consumption or failure. [J-2026-10-25-91,J-2026-10-30-02,J-2026-10-30-04,J-2026-11-01-10] mechanism=src/send.ts
- R22: A seat restarts itself with omp's own /restart (same session and flags); an active goal resumes once, an owner pause stays paused and is reported, a goal-less seat gets its next turn; prove it by a new turn in the session file, not a pid. On omp >= 18.18.1, running subagents survive. [J-2026-11-03-53,J-2026-11-04-01,J-2026-11-08-02,J-2026-11-08-08,J-2026-11-09-03] mechanism=extensions/kit-upgrade-notice.ts
- R50: Mine every active project and selected external repositories through native evidence intake. Rework and waste count, not just failed calls. Give rankings, owners and adoption measures. Every daily failure gets a working mechanism or an owned bead. [J-2026-10-25-19,J-2026-11-03-41,J-2026-11-03-48,J-2026-11-03-51] mechanism=unenforced
- R53: Derive fleet measures from native `omp stats`/session logs and the command center, without duplicating them in kit code. Measures are per seat/project under the flat design. Every bad or UNKNOWN reading gets a cause, owner, action and consequence. [J-2026-10-25-01,J-2026-11-06-08,J-2026-11-07-05,J-2026-11-09-01] mechanism=unenforced

### Communication

- R01: Attribute instructions to their actual author; retain agent provenance and never promote relays into Joshua authority. [J-2026-10-25-41] mechanism=unenforced
- R02: Preserve verbatim Joshua quotes; use native terms, explicit actors/triggers/scope, comprehension checks and English tracker/mail text. [J-2026-10-18-35,J-2026-10-18-36,J-2026-10-18-37] mechanism=unenforced
- R03: Answer Joshua immediately with measured precedent; decide authorized matters; escalate only human-owned choices through prepared one-step lead requests. [J-2026-10-15-03,J-2026-10-15-04,J-2026-10-15-05,J-2026-10-15-06,J-2026-10-15-09,J-2026-10-17-04,J-2026-10-17-09,J-2026-10-27-75,J-2026-10-27-79,J-2026-10-29-15,J-2026-10-30-08,J-2026-10-31-20,J-2026-10-31-22,J-2026-11-01-09,J-2026-11-02-23] mechanism=extensions/kit-flywheel-guard.ts
- R20: ACK typed mail obligations individually; mail wake is on for every seat; prove recipient wake, not persistence; queue mid-turn wakes until turn end. [J-2026-10-18-11,J-2026-10-18-13,J-2026-10-20-47,J-2026-10-26-13,J-2026-10-26-19,J-2026-11-09-02] mechanism=extensions/kit-agent-mail-guard.ts|extensions/kit-mail-wake.ts
- R46: Cite fetched sources with URL, retrieval time, exact quote and changed decision/artifact; exclude memory-only or unapplied citations. [J-2026-10-25-22] mechanism=unenforced
- R54: Report raw-backed shipped value, goal target/trend, dated owned commitments, risks, causal gaps and next measurable change immediately; retain queryable multi-day deltas. [J-2026-10-25-92,J-2026-10-25-113,J-2026-10-26-21,J-2026-10-26-25,J-2026-10-26-27,J-2026-10-26-51,J-2026-10-26-54,J-2026-10-27-04,J-2026-10-29-05,J-2026-11-02-02,J-2026-11-02-03] mechanism=unenforced

### Review and deltas

- Record same-day decision deltas with Joshua’s verbatim words in `decisions/joshua.jsonl` within the canonical `omp-kit-orchestration` skill directory; update this law the same day. [J-2026-10-19-58] mechanism=unenforced
- Review monthly (next 2026-12-03), quarterly (next 2027-02-03), and yearly (next 2027-11-03); reconcile sources, conflicts, coverage and stale mechanisms. [J-2026-10-25-19] mechanism=unenforced


### Conflict dispositions

Resolved by the lead on 2026-11-03 (J-2026-11-03-49). Basis: the newer decision supersedes the older, except where a loaded source (AGENTS.md) already states the rule.
- C1: the full suite runs once per release, never on every push; commits and pushes run affected tests only [J-2026-11-08-10]; supersedes the 4-minute push-to-installed reading [J-2026-11-03-35,J-2026-11-03-36,J-2026-11-03-40]. mechanism=unenforced
- C2: a different model family is preferred; a same-family reviewer is allowed when disclosed [J-2026-10-29-11, AGENTS.md J-2026-10-18-12]; supersedes the strict mandate [J-2026-10-23-31,J-2026-10-25-61,J-2026-10-30-07]. mechanism=unenforced
- C3: a non-author verifies; when no other seat is active the lead records the close on that evidence [J-2026-11-03-49, J-2026-11-03-46]; nobody closes work they authored [J-2026-11-01-18]. mechanism=extensions/kit-flywheel-guard.ts
- C4: one chief, no waits on a peer chief [J-2026-10-30-07,J-2026-10-27-68,J-2026-10-26-52]; supersedes [J-2026-11-01-19]. mechanism=unenforced
- C5: off-constraint seats report NO-WORK and repair stays scoped [J-2026-10-29-18,J-2026-10-30-09], as AGENTS.md states; the downtime grader queue [J-2026-10-30-16,J-2026-10-30-21] applies only on the declared constraint. mechanism=unenforced
- C7: only narrow, tested safe-path repairs; no gate is weakened [J-2026-11-02-29]; supersedes self-set relaxations [J-2026-10-26-40,J-2026-10-27-59,J-2026-10-31-01,J-2026-10-31-05]. mechanism=unenforced
- C8: a restart restores each seat's recorded mode, so goal-less directors and owner pauses are kept [J-2026-10-31-07,J-2026-10-29-07,J-2026-10-26-37]; supersedes universal goal resumption [J-2026-10-25-38,J-2026-10-26-02]. mechanism=unenforced
- C9: fresh sessions are allowed; resume is for scoped recovery [J-2026-10-31-07,J-2026-10-18-21]; the fresh-only reading [J-2026-10-25-02] is superseded. mechanism=unenforced
- C10: rollouts use the named-canary readiness steps [J-2026-10-19-63,J-2026-10-20-44]; supersedes all-at-once with no canary [J-2026-10-18-38]. mechanism=unenforced

