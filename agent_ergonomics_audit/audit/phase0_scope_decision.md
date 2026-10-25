# Phase 0 scope decision (pass 1)

- Target: omp-kit CLI, source `/Users/josh/Developer/omp-kit-companion/src/cli.ts` + `src/commands.ts`, run as `bun /Users/josh/Developer/omp-kit-companion/src/cli.ts`. The installed release is 0.2.74; source is 0.2.75-pre.
- Mode: **full** (J-2026-10-25-32/33: easy for humans and agents alike; skill invoked with no restriction).
- Branch: main (current). No new branch.
- Tier: Squad (44 commands). Triangulation: non-claude (gpt-6.1-sol background agents) plus lead review.
- CASS: quick.
- Agent profile: Claude Code / omp seats (round-trip cost high; mega-commands weighted x1.5).

## Must not touch (guardrails)
- Release-lane files until 0.2.75 is cut: scripts/release-local.sh, scripts/full-suite-verdict.sh, scripts/fresh-gate.sh, scripts/install-commit-msg-bead.sh, src/hook-refresh.ts, scripts/package-release.ts, .github/workflows/*.
- No companion commits while X 7c5d7b67c9 is publishing (RusticPine is the sole publisher). Phase 5 applies after it lands.
- Portability (plan constraint 2): no fleet-only tool may be required. Fleet data (br, Tern, Agent Mail, cc) only via optional adapters with a stock default.
- Additive only: existing flags, verbs, exit codes and the JSON envelope (`ok/tool_version/data/meta/warnings/commands/errors`) stay; renames go through deprecation.
