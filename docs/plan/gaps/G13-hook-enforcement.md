# G13 — Operating rules must be enforced by tested omp-kit hooks, not by agent promises

Owner seat: omp-test:0.1 (chief, omp-kit custody). Status: DRAFT, review round 0. Plan: CORE8-R2 `c0455745`.

## 1. Problem (cited evidence)

- Written rules did not change behaviour. In one session (2026-10-08) the chief cited a predicted Agent Mail id in
  pane pings 7 times (48392→48383, 48396→48390, 48399, 48400, 48417, 48425, 48446→48445). Each was followed by a
  stated rule ("from now on…") and the error recurred. A memory entry and a board rule (shared item 14) were both
  in place for the last two.
- Bare-marker pings: whitespace-only bodies pass `omp-kit send`'s argument guard (`src/cli.ts:2552-2553` @
  e53715ca; DEFECT-ROUTING row 12; reproduced 04:4xZ).
- Mechanical defects caught only by director spot-check (cost ~$100 per director per 3h, 48394-48396): rewritten
  deliverables after DONE, wrong output path, borrowed identity, `artifact://` raw output.
- Hooks are installed outside omp-kit today. Live hook files under `~/.omp/**/hooks/{pre,post}`:
  `guard-rule.ts` ×7, `jev-injection-global.ts` ×5, `jev-webscreen-global.ts` ×5, each with an `INSTALL-RECEIPT.txt`
  pointing at a Jev source path, not at an omp-kit release.

## 2. Why it matters

The method only holds if the cheap, mechanical rules are enforced at the moment the agent acts. Every unenforced rule
costs director turns (the dominant cost) and produces wrong records that the labeling pipeline then learns from.

## 3. Requirement

- R1. Every operating rule that can be checked mechanically ships as an **omp-kit plugin extension** (`extensions/`),
  delivered by a kit release and installed per profile by `omp-kit apply extensions`. No hook file is written into
  `~/.omp/**/hooks` by hand or from another repo.
- R2. No extension is enabled until it passes the certification bar in §7 (adapted from the `hook-certification`
  skill's gauntlet to OMP TypeScript extensions).
- R3. Rollout is shadow → warn → enforce, one extension per pass, with the false-fire rate reviewed as a number.
- R4. Existing non-kit hooks (§1) are inventoried with their owner and either brought into the kit through R2 or
  retired with an undo; none is removed without its owner.

## 4. Existing seam

- `extensions/fleet-guard.ts` (tool_call chain, block reason contract `{block: true, reason}`), `kit-callback.ts`,
  `kit-save-guard.ts`, `kit-guard-optin.ts`, each with a `*.test.ts`.
- `omp-kit apply extensions --plan|--apply`, `omp-kit doctor` (extension listing), the pre-push FRESH-GATE.
- `skill://hook-certification` six-stage gauntlet (Claude/Codex Rust hooks); this section adapts it rather than
  inventing a second bar.

## 5. Design + rejected alternatives

First candidate, `kit-ping-guard` (tool_call, bash): block an `omp-kit send`/`ntm send` that (a) has an empty or
whitespace-only body, or (b) cites `AM <id>` that does not exist in the named project's Agent Mail archive
(`projects/<slug>/messages/**/*__<id>.md`), or cites an id with no `(<project> project)`. Class: **gate, fail-open on
its own error** (a guard crash must not block sends), decision via the block reason.

A draft of this extension plus 7 unit tests (7 pass) was written and then **withdrawn from the working tree
unreviewed** (sha `aad26ec8` / `cefd1860`) because it skipped this section, the review round and §7. It is an
input to the bead, not landed code.

Rejected: (1) more written rules/memory: measured ineffective above; (2) hand-installed `~/.omp` hooks: violates R1,
untestable per profile, invisible to kit doctor; (3) fixing only the CLI guard: covers (a), not (b).

## 6. Dependencies

G10/ID1 (seat identity: the guard needs the sender's seat to scope project names), G7 row 12 (CLI-side guard),
G24 (director loop emits pings through the guarded path), G25 (test matrix), G19 (a release must carry it).

## 7. G25 test rows (certification bar for every omp-kit extension)

| Class | Case | Pass bar |
|---|---|---|
| golden | real ping with an existing id → allowed, byte-stable decision | 0 block |
| planted-red | the 7 recorded wrong-id pings from §1, replayed from session JSONL | 7/7 blocked |
| satisfiability pair | each block has a satisfying witness (same ping with the real id) | every pair passes |
| near-miss | `echo "AM 99999 (x project)"`, a send with no id, an id in prose not a send | 0 block |
| fuzz | deterministic-PRNG mutations of send command lines (quotes, newlines, unicode, 64 KB) | no throw; declared fail-open |
| mutation adequacy | `omp-kit test --mutants` over the guard's patterns | no meaning-changing survivor |
| latency | archive lookup cold/warm on the live archive (~48k messages) | p99 < 50 ms or index-backed |
| scratch-HOME install | `omp-kit apply extensions --plan/--apply` into a fake HOME, then a real OMP session fires it | fires in-session; uninstall restores |
| shadow soak | log-only for 50 firings or 2 days on the chief seat | false-block rate stated, reviewed |

## 8. Close condition

`kit-ping-guard` shipped in a kit release, applied to the director profiles, enforce stage reached after shadow,
with the §7 artifacts hashed; zero wrong-id pings from guarded seats over the next 48h of board traffic; §1's
non-kit hooks each have an owner disposition.

## 9. Bead cards

1. **HOOK-PING-1** (omp-kit): implement `extensions/kit-ping-guard.ts` + tests per §7 rows golden/planted-red/
   satisfiability/near-miss/fuzz/mutants; acceptance = those rows green, planted-red run recorded RED on main first.
2. **HOOK-PING-2** (omp-kit): latency bench + scratch-HOME install proof + shadow soak; acceptance = §7 rows
   latency/install/shadow with numbers.
3. **HOOK-INV-1** (chief): inventory the non-kit hooks in §1 with owner and disposition (bring into kit or retire,
   with undo); no removal without owner.

## 10. Open questions (owner seat)

- Does OMP's extension `tool_call` event expose the bash command string for all bash tool variants? (omp-test:0.1)
- Archive lookup vs Agent Mail DB query for id existence: which is the supported read path? (jev:0.1, ID1 owner)
- Should the guard also check that the pinged pane's seat is a recipient of the cited message? (review round)
