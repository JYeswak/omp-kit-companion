---
name: frontend-foundations
description: Use when building, changing or reviewing any web front end — pages, components, styles, motion, dashboards, or design tokens — to decide all 30 foundations first, build from the defaults, and verify before ship.
---

# Frontend foundations

Decide first, then build. Every web front end must answer the same 30
questions (F0–F29 in `references/foundations.md`) before it ships.

All script paths below are relative to this skill directory
(`skills/frontend-foundations/`), never to any client checkout. The only
client file the skill ever needs is an optional overlay; everything else
resolves inside the skill.

## The workflow, in order

1. **Decide all foundations first.** Run
   `node <skill>/scripts/init.mjs [--out frontend.foundations.json] [--build-dir dist]`
   in the project. It writes `frontend.foundations.json`: every foundation
   listed as `"default"` or `"override: <value>"`, each with either a
   `verifier` command (`verifiers/<ID>.mjs`, which you implement) or a
   `judge` note where only human judgment counts (owner accept, UNVERIFIED
   pipeline). Fill in every override before building. The file also names
   `buildDir`: the served build directory the results bind to.
2. **Pick a reference picture the owner chose.** One rendered exemplar,
   not a description. If there is no owner-picked picture, stop and ask.
3. **Build from the defaults.** Tokens → primitives (copy-in) → components
   → pattern. Light canvas, one accent. A client overlay changes hues, logo
   and type accent only.
4. **Run every verifier through the gate — never by hand.** Implement each
   `verifiers/<ID>.mjs` as an executable that exits 0/1 with deterministic
   stdout, then run `omp-kit frontend check` in the project. This executes
   trusted commands from `frontend.foundations.json`: review those commands
   before running a checker from an untrusted checkout. The gate runs every
   verifier itself (argv, bounded time, no shell), records the real exit
   plus a hash of the real output, and binds the results to
   two digests: the build digest (sorted paths + contents of `buildDir`)
   and the criteria digest (bytes of `frontend.foundations.json`). A
   foundation passes only on its own verifier's run — recorded exits,
   saved-output snippets and legacy `evidence` fields are never trusted.
   Every run writes `frontend.evidence.json` beside the decisions file
   (`--write-evidence <file>` chooses another output). Presenting it
   later with `--evidence <file>` refuses anything whose build or criteria
   digest no longer matches and re-runs all verifiers against its claims.
   Keep evidence and approval outside `buildDir`; the gate refuses inputs
   that change during verification. Ship only when the gate passes.
5. **Owner approval for the shipping gate.** Judge items (`F0` owner
   accept, `F22` event pipeline, anything you mark `judge`) report
   `NEEDS_JUDGE`, never PASS. For deploy, the owner records the exact
   digests: `frontend.approval.json` names `decision: "approve"`,
   `buildDigest`, `criteriaDigest` and `approver`. Then
   `omp-kit frontend check --require-approval --approval frontend.approval.json`
   refuses when the record is missing or names other digests. No approval
   is ever inferred.
   The record is an explicit owner attestation, not authentication or a
   cryptographic signature; a trusted owner must author it after reviewing
   the rendered build. The gate never creates approval records.
6. **Show the owner the rendered page, never words.** Screenshots or the
   live page beside the reference picture. Reviews judge pixels.

To preview the foundations as a page:
`node <skill>/scripts/build-reference.mjs [--overlay <file>] [--out <file>]`.
It renders the interactive reference from `references/foundations.md`.
The overlay is optional: without `--overlay` it renders the stock look,
so the preview works with no client files present. An explicit unreadable
overlay is an error, not a silently substituted brand. The `.md` is the
source of truth; never hand-edit the page.

## Rules

- The light canvas + one accent look is a **default overlay**, never
  mandatory. A project may go dark or multi-accent by overriding F5 in
  writing (with an ADR).
- A client overlay **overrides only what differs** (hues, logo, type
  accent). Structure, spacing, semantics and abnormal colours stay shared.
- Verifiers must be deterministic: same build, same output bytes. The gate
  hashes stdout+stderr and refuses evidence that disagrees with a live run.
- **Never fork.** A client needing a new pattern contributes it back to the
  shared components instead.
