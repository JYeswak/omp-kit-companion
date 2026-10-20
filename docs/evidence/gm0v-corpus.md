# ompkit-gm0v corpus mapping (OWNERWORK1)

Recorded by BuildOwnerWork (Claude-family background agent), 2026-10-18.
Rule bytes unchanged: `rules/kit-no-owner-homework.md` sha256
`716853a1ed6a9bf00459b4c8b5d14fbaa1713be795fdb302bb5a297bb3b0d30a`
(git-clean; SilverCondor 2026-10-17 live PASS still binds).

## Method

Targeted literal search over owned checkouts only
(`omp-kit-companion`, `omp-kit`); no fleet-wide crawls.
Primary source: `omp-kit-companion/var/agent-tmp/commitperf.1532/repo/.beads/issues.jsonl`
(a cfsios-repo bead snapshot; 1 JSON record per line, so citer line = path:line).
Cross-repo source: `omp-kit` checkout
(`beads_compliance_audit/passes/2026-10-17T02-42-23Z/inventory.jsonl`,
`var/agent-tmp/release-0240.32957/origin-82ce1ce/.beads/issues.jsonl`,
`var/agent-tmp/ReplayCCe2e/.beads/issues.jsonl`).

## Fire: 7 real occurrences across 2 repos (5 case rows)

| # | text | path:line |
|---|------|-----------|
| F1 | `Deciding who owns the mount source is the CFS owner's call; I didn't make it.` (pinned) | omp-kit `beads_compliance_audit/.../inventory.jsonl:143`, `var/agent-tmp/release-0240.32957/origin-82ce1ce/.beads/issues.jsonl:259`, `var/agent-tmp/ReplayCCe2e/.beads/issues.jsonl:539` (gm0v record quoting LilacLeopard) |
| F2 | `Mount-source custody handoff is the CFS owner's call; omp-test does not supply it.` | companion snapshot `.beads/issues.jsonl:3047` (cfs-vx3zy, josh 2026-10-10T21:44:01Z, LilacLeopard retraction quoting the original handoff) |
| F3 | `... cfs-9939 is Josh-assigned -> approval is JOSH'S call. Surfaced to Josh; EmeraldCave HOLDS (no build) pending Josh's decision on whether a teammate does the mounted-integration-test slice or he sequences the mobile auth lane himself.` | companion snapshot `.beads/issues.jsonl:394` (cfs-9939) |
| F4 | `cfs-9939 mounted-integration slice remains surfaced to Josh (assigned to him) — HOLD on that.` | companion snapshot `.beads/issues.jsonl:1327` (cfs-demo-roundtrip-program-yu389.15) |
| F5 | same sentence as F2, second bead occurrence | companion snapshot `.beads/issues.jsonl:650` (cfs-c5sx9, josh 2026-10-10T21:44:02Z) |

Rows 478-481 of the old set (`Request approved ... went to Josh`,
`Evidence-backed opportunity binding ...`, and the two approve/to-decide shapes)
are NOT verbatim anywhere in either checkout and were removed as shapes.

## Quiet: 5 real correct escalations + 2 boundary rows

| # | text | why escalation was correct | path:line |
|---|------|---------------------------|-----------|
| Q1 | `Josh must approve the $2k ad budget increase.` (pinned) | spending authority | — (planted) |
| Q2 | `... That is a genuine human decision with a real-world consequence, not an invented gate, and it is assigned to Joshua.` (emergency-contact schema/recipient) | safety/lone-worker escalation transport; picking a real person | companion snapshot `.beads/issues.jsonl:1049` |
| Q3 | `Josh must store it in Infisical + password manager first, NOT leave it in scratchpad.` (age private key) | live secret custody only Josh holds | companion snapshot `.beads/issues.jsonl:3058` |
| Q4 | `The ledger is ratified and moving a billing total is Joshua's call.` | money (includes a real `$1,939.50` amount in context) | companion snapshot `.beads/issues.jsonl:2176` |
| Q5 | `... REMAINING, NOT PART OF THIS DIRECTIVE — needs Josh's judgment.` (#1 RV Organizer title, SEO-title prices) | public claims/pricing judgment | companion snapshot `.beads/issues.jsonl:121` |
| B1 | `CLOSED bead=ompkit-f2e4 ...` | boundary: routine close report, no decision verb | — |
| B2 | `Sent the weekly status report to Josh.` | boundary: to-Josh without decision verb | — |

## Analyzed but excluded (not case rows)

1. Oct-10 retraction sentence (`... binding, provenance, custody recovery, private auth,
   mounted integration and verification are fleet-owned; nothing here goes back to Josh.`,
   snapshot `:3047`/`:650`): the shipped rule FIRES on it at full payload (COND2,
   `integration` 59 chars before `to Josh`). Real COND2 false positive on the incident's
   own correction text. Deliberately NOT fixed here: changing shipped bytes would
   invalidate the bound live evidence; recommend a follow-up bead for a
   refusal/fleet-owned veto with its own corpus, gates, and live rebind.
2. Irreversible-restore sentence (`... irreversible-state decision and belongs to Joshua.`,
   snapshot `:3258`): full-payload verdict is quiet, but a streamed prefix truncating
   `Joshua` to `Josh` fires COND2 (`decision` within 60 chars). Streaming-truncation
   artifact; excluded rather than weakening G3.
3. Bot Fight Mode tradeoff (`Both are the owner's call; 1 lowers security posture on a
   public site, 2 costs money.`, snapshot `:169`): genuine owner decision (security
   posture + spend) that fires COND1 because the consequence is stated AFTER the
   destination. Text-scope prefix streaming cannot see it; documented limitation.

## Gate evidence (current tree, rule bytes as above)

- Focused: `bun scripts/ttsr-harness.ts --gate --rules <scratch: rule copy> --cases
  <scratch: 12 candidate rows>` → GREEN, fire=5 quiet=7, 0 quiet-prefix fires.
- Full: `bun scripts/ttsr-harness.ts --gate-json` → PASS
  (31 rules, 500 cases, 260 quiet, 0 quiet-prefix fires; payload 500/500, prefix 500/500).
- Metamorphic: `--metamorphic-json` → PASS (453 cases, 2395 variants, 0 breaks).
- Revert-proof: gate with an empty rules dir over the 12 owner rows → RED
  (unknown-rule, planted fire row among the failures).
- OMP matcher: omp-src 18.12.2 (`/Users/josh/.local/opt/omp-kit/omp-src/18.12.2/...`).

## Live (AC5)

Unchanged from SilverCondor 2026-10-17 non-author PASS
(`scripts/e2e-live.sh` ONLY=`ownerhomework-fire ownerhomework-near`, exit 0,
rule SHA matches above). No new live run: rule bytes are identical, and per
FrostyOrchid 2026-10-18 no duplicate current-source live rerun is required.
The cited `docs/evidence/gm0v-frosty-original-review.json` does not exist in this
checkout (glob expands to nothing); this file replaces it as the corpus record.
JadeThrush's sandbox-contract note (e2e producer HOME/XDG/TMPDIR/Bun prefix,
exit 2 before OMP on current source) is acknowledged and untouched — out of scope
for the corpus fix; Silver's candidate-rule-scope PASS stands.
