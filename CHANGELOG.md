# Changelog

## Unreleased

<!-- New PR notes go in changelog.d/<bead>.md; legacy Unreleased bullets must end with (PR #NN). -->

## 0.2.8 — 2026-10-06

- COMMIT1 bead-id hook: `scripts/commit-msg-bead.sh` refuses commits naming no tracker-existing bead id (full `ompkit-<id>` or `rz5.<n>`, merge/template exempt, trackerless repos skipped), installed via `scripts/install-commit-msg-bead.sh` into the hooks chain; 7/7 contract tests with stubbed br plus live real-tracker proof.
- COMMIT1 installer takes an optional repo argument, absolutizes relative hooks paths, and refuses non-repos; cfsios installed and verified live per-tracker (foreign ids refused).
- COMMIT1 redesign: pre-push gate refuses id-less pushed commits (commit-tree included), the installer chains beside bespoke hooks, and ids resolve against the repo tracker (cfsios/uds shapes pass, versions don't).
- COMMIT1 chain hardening: the installer moves fail-closed bespoke wrappers with their sibling impls (`<type>-*`), keeps helper copies non-executable (chain runners only execute `NN-*` members, so helpers never run arg-less), and probes the whole chain before declaring success (bespoke-must-match-preflight, bead member must refuse an unresolvable id, pre-push member must pass an empty range), rolling every mutation back on any probe failure. Checker runs via `sh` throughout so non-executable helpers work. Planted: sibling preservation, path-sensitive move regression (refused + rolled back), pre-existing refusal preserved.
- COMMIT1 hook accepts any tracker-resolved id: the digit-shape prefilter is gone, existence comes from br show alone, so digit-less real ids (ompkit-kxdy) pass while made-up tokens are refused (12/12 contract tests, RED proven on the old filter).

- scratch service test pins quiet load; heaviest multi-spawn test gets an explicit 30s timeout.
 - fast-test and integrations suites use a suite-owned TMPDIR they remove, with a planted check that a fixture cycle leaves session-omp-test unchanged in size.

- Commit index for 0.2.8: every shipped-path commit since v0.2.7 that had no fragment of its own, grouped by bead.

- ompkit-2w7h: (commit e1a4256) (commit c563925)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.113: (commit bab5dd5)
- ompkit-ex6l: (commit 5df2583)

- RELEASE BLOCKER A2: the CI-judge signal survives into nested ladders. `cert_env()` in `scripts/native-candidate.py` passes GITHUB_ACTIONS through when the parent run sets it (local runs stay fail-closed); `scripts/runtime-adapter.sh` forwards it in the scrubbed child env; `scripts/ladder.sh` judges regex-budget regardless of load only under that signal. Planted: cert_env contains the key iff set (RED on unfixed code).

## 0.2.7 — 2026-10-06

- FLY2-1 linkage fix: `src/flywheel-score.ts` BEAD_ID accepts the dotted numeric suffix in bead ids (rz5.113); without it every dotted commit counted unlinked (linkage read 1/50). Linear-time pattern (word-bounded, exclusive classes, no nested quantifiers). Planted test: dotted ids link, truncated prefixes do not; landing-hygiene covered too.
- FLY2-1 bare resolution: realIds also accepts bare rz5.NNN exactly like the COMMIT1 hook, resolving against known tracker ids by unique suffix; unknown or ambiguous suffixes never link. Planted: resolving bare links, unknown bare does not, duplicate-suffix fixture does not.

- FLY2-2 self-pick rule: `skills/jeff-planning-enhanced/SKILL.md` section 7 now says claim from `bv --robot-next` (RERUN-REQUEST grades first) and hold at most one bead at a time, closing the gap where marching orders implied it but neither document stated it.

- scratch service test pins quiet load; heaviest multi-spawn test gets an explicit 30s timeout.

- PUB1e doctor scope: `doctor --scope public-files --project` lists missing standard public files (OK when complete, DEGRADED naming each).

- PUB1f doctor scope: `doctor --scope layout --project` reports standard layout deviations (OK when clean, DEGRADED naming each).

- Release fallback when GitHub runners queue (DS1): `dsr repos add` registration plus per-target definition, `dsr health all`, and a CONTRIBUTING procedure whose publication bar matches CI (per-platform native-cert receipts); precise gap list included (target vocabulary, unreachable macOS remotes, signing/SBOM unconfigured).
- DS1 dsr mapping: package-release accepts v-prefix, Rust triples and native (resolving to the host kit triple); repo-tracked dsr/omp-kit-companion.yaml names platform targets for up hosts with measured interface notes.

The daily OMP compatibility workflow now tests the latest three stable releases, compares their first-fire indexes and default-policy outcomes, and produces a diff-checked matrix linked from the README. The report names known policy failures and limits its claim to the tested releases and checks.

- FLY2-3 dangling imports: the pre-push chain refuses commits importing files missing from their tree (planted commit refused naming sha+path; suite 3/3).

- Commit index for 0.2.7: every shipped-path commit since v0.2.6 that had no fragment of its own, grouped by bead.

- ompkit-udm1: (commit 4e9addf)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.54: (commit 83d815c)
- ompkit-wqk9: (commit 58a11dd)
- ompkit-uzgf: (commit fd8fcd9)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.106.6: (commit 15385a7)
- ompkit-l9pt: (commit 72f14b9)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.106.5: (commit e9bab97)
- ompkit-t8do: (commit 9cc4b17)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.106.3: (commit d197245)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.113: (commit 5673499)
- feat(omp-compat): compare latest three OMP releases daily (commit 032980e)

- RELEASE BLOCKER A: `runEffectiveRuleProbe` (sync + async) in `src/diagnostics.ts` spawns OMP against an isolated probe HOME carrying only small non-database configs from `.omp/agent` and the probed profile; OMP's SQLite state init lands in throwaway and findings match real-HOME runs byte for byte. Planted test asserts an inspected HOME stays byte- and mtime-identical (RED on unfixed code, GREEN fixed).

## 0.2.6 — 2026-10-06

- F2 no-egress tripwire (box 6): `tests/cli/corpus.test.ts` runs the full corpus with all proxy vars poisoned to unroutable endpoints and asserts the seeded counts; a positive control proves the poison is lethal in the running runtime (a future runtime that ignores proxy env fails the control, never silently vacuous). Scope: CLI parent layer via the standard proxy-respecting stack; the harness child runs under runtime.ts's proxy-free allowlisted env, so any future child egress would be direct-dial.

- ID1 doctor finder: `inspectPaneIdentity` classifies live panes via `am resolve-pane` (shared name FAIL, missing file and week-idle registrations DEGRADED); live fleet run resolves all 8 omp-test panes with no collisions.

- Add read-only load census attribution for agent panes, system groups, LSP counts, and the `jobs/<id>.json` heavy-job ledger; absent ledger state reports `heavy jobs: none registered (LOAD1 not installed)`.

- COMMIT1 bead-id hook: `scripts/commit-msg-bead.sh` refuses commits naming no tracker-existing bead id (full `ompkit-<id>` or `rz5.<n>`, merge/template exempt, trackerless repos skipped), installed via `scripts/install-commit-msg-bead.sh` into the hooks chain; 7/7 contract tests with stubbed br plus live real-tracker proof.
- COMMIT1 installer takes an optional repo argument, absolutizes relative hooks paths, and refuses non-repos; cfsios installed and verified live per-tracker (foreign ids refused).
- COMMIT1 redesign: pre-push gate refuses id-less pushed commits (commit-tree included), the installer chains beside bespoke hooks, and ids resolve against the repo tracker (cfsios/uds shapes pass, versions don't).

- FLY2 score: `doctor --scope flywheel --project` grades seven fleet practices (bead size, commit linkage, self-pick, landing hygiene, close flow, freshness, verdicts, lessons) from git and the tracker with value, threshold and letter grade; planted A/F fixture suite green.
- FLY2 empty samples read N/A (UNVERIFIED), never A; close-flow A needs max in_review within 2h; the git read scrubs GIT_DIR/WORK_TREE so --project always wins.

- REAP2: scratch plan parent rows exclude nested plan rows' bytes (each byte counted once); planted nested fixture proves parent reads own bytes only.

- bash-pipe-exit: condition 0 checks the echo/printf quote lookbehinds after the pipe-to-head/tail match, not before it, so near-miss cost stays flat (16K: 1958 ms to 0.14 ms) with fire/quiet cases unchanged (ompkit-ex6l).

- Regex budget gate wired in (RX1): `ladder.sh` runs `scripts/regex-budget.ts`, and the pre-push gate runs it when `rules/*.md` changes (refuses on RED); mission Proven check already points at it. Live rules currently fail it (near-miss, lint, stream budget) — rule fixes ride in RX2/RX5/RX6.
- RX1 load gate: the budget refuses to judge on a loud box (load1 above 1.5x cores) and reports INCONCLUSIVE (exit 75) instead of failing a correct push; the push gate defers to CI on 75. Planted contention proves the path; budget unit tests 8/8.

- DISPATCH1 slice: `scripts/dispatch-check.sh --db PATH` fails closed on any disagreement between `bv --robot-next` and the `bv --robot-triage` top: agreement prints `CLAIM_TOP=<id>` (exit 0), anything else prints `BV_TOP_MISMATCH` (exit 3) so no claim is made from robot-next's pick. Live tracker agrees today (rz5.104). Still open: pagerank-certificate rerun procedure, upstream bv stranger repro if a real mismatch appears, independent rerun.
- Follow-up: empty rankings fail closed naming the cause (dry queue reports no-id instead of unreadable-JSON).

- GUARD1: fleet-guard caches only positive reservation lookups. A negative result is re-queried on the next edit instead of served stale for 30 s, so reserving right after a refusal allows the edit; another agent's hold is still refused on every recheck.

- CI1 slice: every job in the kit's three workflows carries `if: github.event.repository.private == false`, so a private fork or mirror never bills minutes. `tests/cli/workflows-private-guard.test.ts` fails on any job without the exact guard string. Still open: doctor private-repo finding, budget reporting, burn cuts, Josh's per-repo decisions.

- PUB1a slice: `scripts/doc-drift-check.sh BASE HEAD` refuses a CLI surface change with no `docs/` change, naming the undocumented surface. The surface is derived from the `src/commands.ts` registry at each revision via throwaway worktrees, never grep. Live range clean; still open: pre-push wiring, uds pilot, cross-repo runs.

- Doc status gate (`scripts/doc-status-check.sh`, `tests/cli/doc-status.test.sh`): every doc carries front-matter status; dangling superseded-by and missing status are refused; `docs/INDEX.md` regenerates deterministically. Front matter added to the kit docs (README follows when its holder lands).

- PUB1c slice: `docs/release-procedure.md` generalizes the companion release flow (fragments, assemble, semver tag, platform archives with sha256, install verify; signing delegated to rz5.59.3) for uds adoption. Still open: uds cuts a release with it, live pilot, local-copy retirement, cross-repo runs.
- Adopting the release procedure in another repo (PUB1c): fragment convention, first tag, coverage check and assembly steps in CONTRIBUTING (pointing at `docs/release-procedure.md`); the check is repo-agnostic (git runs in the caller's checkout) and flags the one uncovered direct commit here.

- `doctor --scope work` reports timed-out Git probes as `TIMED_OUT` with all state metrics unknown, never inventing zero dirty/stale counts or detached state. The check remains read-only; the 30-minute stale-age default and `OMP_KIT_WORK_STALE_EDIT_MINUTES` override are unchanged.

- PUB1e slice: `scripts/public-files-check.sh [REPO]` lists missing standard public files (SECURITY, CONTRIBUTING, CODEOWNERS, PR/issue templates, dependabot, deny.toml for Rust). Live run on this repo names 4 gaps (filed, not filled here). Still open: neutral templates, CONTRIBUTING policy comparison, doctor wiring, uds pilot.

- PUB1f slice: `scripts/repo-layout-check.sh [--strict] [REPO]` reports layout deviations as WARN (exit 0) or FAIL (exit 1) with strict opt-in, including repo-local scratch ignore (operator global ignore does not count). Ships `docs/repo-layout.md` and `docs/adr/0000-template.md`; live repo is clean. Still open: doctor wiring, uds pilot, cross-repo runs.

- PUB1 slice: `scripts/publishability-check.sh [ROOT]` scans tracked files for secret-shaped tokens, absolute home paths, private IPs and LAN hostnames (scratch, .git and binaries skipped; neutral fixtures pass), exit 1 with file:line findings. Dogfood on this repo: 0 secrets, 16 home-path findings in test fixtures/docs/lessons (filed for holders, not fixed here). Still open: TTSR rule, doctor/pre-push wiring, uds script retirement, live fire, cross-repo counts.

- ID1 slice: `scripts/br-shim.sh` puts the pane's Agent Mail identity on every `br` invocation: `--actor $AGENT_NAME` is appended when absent and must equal `$AGENT_NAME` when present (refused exit 4 otherwise), anonymous runs are refused, and a real binary resolving to the shim itself is refused instead of exec-looped. `tests/cli/br-shim.test.sh` proves injection on every write kind plus the no-shim passthrough that shows enforcement lives in the shim. Still open: spawn-time AGENT_NAME wiring, commit trailer hook, close/grade guard, doctor uniqueness check, upstream BR_ACTOR issue.
- ID1 spawn wiring: `scripts/agent-spawn-env.sh --agent NAME` installs the br identity shim into a pane-scoped bin dir and prints eval-able exports, so every pane runs br through the shim with its own identity; anonymous names refused, real br required beyond the shim.
- ID1 commit trailer: `scripts/agent-trailer-hook.sh` (installed by `scripts/install-agent-trailer-hook.sh` into the hooks chain) appends `Agent: $AGENT_NAME` when the message has none; unknown identity or existing trailer left untouched.
- ID1 close guard: `scripts/close-guard.sh BEAD` refuses when the caller holds the claim or has an Agent trailer on a naming commit, unless a reviewer-fresh-context label is present; different actors pass.
- ID1 uniqueness: `scripts/identity-uniqueness-check.sh` reads pane identity files plus live tmux panes and flags live panes without files, stale files for dead panes, and one name on two live panes.
- ID1 modes fix: the four executed shell scripts committed +x (were 100644 from index staging); file-modes test asserts committed modes.
- ID1 doctor finder: `inspectPaneIdentity` classifies live panes (shared name FAIL, missing file and week-idle registrations DEGRADED); scope wiring needs the cli/commands holders.
- ID1 scope wiring: `doctor --scope identity` routes to the pane finder (cli map + registry enum).
- ID1 scope follow-up: `doctor --scope identity` accepts `--project` for the pane-identity project key.

- Scratch reaper reads the owner formats the fleet actually writes: JSON and one-line `pid=.. label=..` files parse to the same owner as multi-line key=value, and hand-written bare-label owners are reported per root instead of silently kept. A legacy owner whose pid is alive but whose process started after the owner's `created` time is classified owner-dead-pid-reused and reaped under the lsof gate instead of staying LIVE. Directory names only need to end in `.<pid>`, and every plan row carries its size with per-verdict, per-root and malformed-owner totals. `scratch release DIR --legacy-owner --reason TEXT` releases free-form-owner dirs (operator intent recorded in the marker and receipt, never with open fds), and the canonical `createScratch` writer replaces hand-written `.owner` files. Fleet suite temp lives at `/Users/Shared/omp-kit-tmp` (outside every git tree and `~`) and is reaped the same way. CLI surfacing (`scratch create`, `--legacy-owner/--reason` flags, plan totals in `--json`, unowned-active rule in help) is still open for the commands/cli owner.
- REAP1 help doc: `omp-kit help scratch` now states the unowned-active rule (fresh activity within 72h stays LIVE; idle past 72h with no open fds goes to quarantine).

- DERIVE1 slice: `scripts/derived-check.sh FILE...` flags literal probe-readable facts in config files (version pins, absolute paths, hard-coded counts, pid/lease values), each with its replacing probe; decision lines with reasons and probe calls stay quiet. Dogfood on `.omp/*.toml` is clean. Still open: protocol rule text, TTSR rule, doctor scope wiring, bead-lint merge, cross-repo run.

- `doctor --scope kit` contract lists the `planning_skill` finding: PLAN1 added it to the kit scope components, and the grammar/refusal test pins the exact list.

- SEND1 capture proof: marker check uses the bare pane id with scrollback history (session:pane misparses as a window; rendered messages scroll off the visible screen).

- `doctor --scope beads` reports likely duplicate beads: live bead pairs sharing 75% or more of their title, description and acceptance text are listed with a similarity score (planted near-identical pair reported, distinct pair not).

- CI installs pinned br 0.7.4 (sha256-verified) for the policy-gate live tests, which refuse to skip when the binary is absent.

- Reservation-age report (`src/reservation-age.ts`, `tests/cli/reservation-age.test.ts`): audits an Agent Mail archive for exclusive holds older than the limit (default 30 min) with holder and bead; a 45-minute planted hold is reported, a 10-minute one is not. Doctor-scope registration follows when the scope files are free.

- Red main: the PROF2 strict path check broke contract fixtures whose plugin entry carries no path; when the kit package dir is unknown the check falls back to the path-contains heuristic instead of failing closed, restoring cli-contracts/profile-rules greens.
- B7 refusal proof: planted failing scenario makes the native receipt name the stage, failures and missing scenarios (candidate suite 5/5).

- Release fallback when GitHub runners queue (DS1): `dsr repos add` registration plus per-target definition, `dsr health all`, and a CONTRIBUTING procedure whose publication bar matches CI (per-platform native-cert receipts); precise gap list included (target vocabulary, unreachable macOS remotes, signing/SBOM unconfigured).

- PI1 MCP ABSENT: the planted no-server profile is separate from the shared fixture (which gained a server), so the ABSENT assertion tests the verdict, not the fixture.

- PI1 live scenarios run omp in the prepared setup repo (not an empty sibling), and the MCP judge accepts OMP 18.6.1's single-underscore tool spelling.
- PI1 scenario branches no longer embed the integration name (shell errors echoing the path self-matched judge regexes).

- PROF2 slice: a same-named rule counts as kit-loaded only when its path sits under the kit plugin's package dir; foreign-plugin and provider-only matches now land in `missing` instead of vanishing from every bucket. Planted foreign-plugin test goes DEGRADED with the rule named missing.

- Stale-base deletion guard (`src/land-guard.ts`, `tests/cli/land-guard.test.ts`): refuses a candidate tree that drops lines added after its base, naming the commit per file; planted replay of the 38afcc7e59 revert names the dropped commit.
- LAND1 wire: the pre-push hook runs the land-guard stale-deletion check first, from the base archive's code: a commit built on base B that drops lines added at B+1 is refused naming the adding commit; fresh pushes pass through.

- GATE1 slice: the pre-push hook runs gate code from the base archive (authoritative), never the working tree or the pushed head; a head that deletes a gate step is still judged by the base gate, and a failing base gate refuses.
- The base-authoritative pre-push chain now runs six checker contract suites; any failing or missing suite refuses the push.

- Shared strict `.beads/policy.yaml` template (`config/beads-policy.template.yaml`): closed is reachable only through gated edges, with per-session deltas; `tests/cli/beads-policy.test.ts` tries every status-to-closed edge on a scratch tracker (refused without a reviewer pass, closed with one) and asserts `br ready` counts are unchanged by the policy file.

- LOAD1 evidence: targeted matrix for the landed admission gate — concurrent runs serialize on one slot (timestamp-ordered markers), child runs +10 nice above its parent, SIGINT/SIGTERM release the slot with 130/143 and empty ledger. Joins the existing threshold/exit-code/no-wait/pane-exclusivity/stale-reap/timeout tests.
- LOAD1 contention plants: OMP_KIT_HEAVY_FAKE_LOAD1 seam drives end-to-end queue/no-wait deferral tests; unseamed control runs.
- LOAD1 status lines: waiting job prints position, running jobs and contention reason before deferring.

- `kit-regex-engineering` reminds agents to apply the regex-engineering skill before adding patterns. `doctor --scope regex-tools` reports the six required executables on PATH; the L6 pre-push gate and CI scan commit-exact changed JS/TS/Python with regexploit, reject findings with file:line, and exercise a planted TypeScript ReDoS negative. The gate excludes only `tests/scripts/regexploit-gate_test.py`, whose embedded malicious pattern is the fixture; the generated changed TypeScript source remains scanned and asserted vulnerable.
- RX5 slice: the regex-tools doctor finding names the exact install command per missing tool (cargo/pip per the skill toolkit). Live machine: all six present, OK. Still open: reminder-rule fire rows, pre-push regexploit path, installed-profile run, independent spot-check.

- Add per-profile plugin plan/apply/receipt/undo core with explicit DUAL_CONFIG and unwritable-profile skips.

- Deploy the kit plugin package across OMP profiles with verified profile hashes, report-derived named-profile RX2 exclusions, durable per-profile receipt rows, and exact plugin/lock rollback data.

- Report effective kit rule sources and plugin versions per OMP profile through `doctor --scope rules`; native overlays are listed, legacy `~/.agents/rules` copies are not treated as installed kit rules.

- Commit index for 0.2.6: every shipped-path commit since v0.2.5 that had no fragment of its own, grouped by bead.

- ompkit-rc-epic-land-fix-release-dogfood-rz5.123: (commit a103ed3)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.113: (commit 7341db3) (commit 3eb78d1) (commit 2d77c9f) (commit bb851b8) (commit e2d3029) (commit abdbdea) (commit e5198fc) (commit a5bcc20) (commit 329bf9c) (commit 4a91016) (commit f8d5827)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.118: (commit aacaa3c) (commit dcbd280)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.108: (commit 367381d) (commit f9be277) (commit 871b74a) (commit c81ba88) (commit 558ef2e) (commit 0e36f42) (commit ba859e1) (commit 1d22f78) (commit 316ed4f)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.103: (commit e5f536c)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.100: (commit f6978a0) (commit 80e7de4)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.106: (commit 8dcb21a)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.119: (commit cda6a9a) (commit 73d73d8)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.106.1: (commit 68eaefa)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.106.5: (commit a2167b6)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.106.6: (commit a9a63aa)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.129: (commit 8eebca6)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.128: (commit 40b8a43) (commit 20005e2) (commit 383b142) (commit 711064c) (commit 8951fb2) (commit ca8bade)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.82: (commit 5ddede7)
- ompkit-xade: (commit 799edf8) (commit 53e54e3)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.30: (commit 1b9b420)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.88: (commit 316b22f) (commit 807a861)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.86: (commit f3e7359)
- ompkit-2w7h: (commit b0dff61) (commit 1491cb5) (commit 672b432)
- ompkit-t8do: (commit cf2c48e)
- ompkit-kxdy: (commit 98c1717)
- ompkit-sewn: (commit 2908072)
- ompkit-l9pt: (commit 6189f27) (commit a83cd7c) (commit 9abebba)
- ompkit-8m75: (commit 8aed51f) (commit ad4f3d2) (commit 0f87ece)
- ompkit-pwdi: (commit 3d37e92) (commit eac5125) (commit 1f39f19) (commit 34e85a6)
- ompkit-azpk: (commit 0204f13)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.95: (commit 2085489)
- ompkit-ex6l: (commit c57f744)
- ompkit-y8f9: (commit b75193d)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.104: (commit c5f12bd)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.125: (commit 974417a)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.87: (commit 69e6122)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.56: (commit 4f4beb7)
- feat(load): add machine census and watch service (commit b82d3e5)
- fix(load): correct census telemetry and ownership (commit fb5af2a)
- feat: add load-gated heavy command (commit 9fce4c1)
- fix(load): capture owner start and enforce machine rule (commit d1000fe)
- chore: route gates through heavy admission (commit fe30746)
- feat(doctor): report effective rules per profile (commit 854b58e)
- feat(plugin): add per-profile receipt and undo core (commit 8bb1680)
- feat(plugin): document apply plugin grammar (commit 1ec9506)
- feat(plugin): wire apply and undo CLI (commit c28502e)
- fix(plugin): isolate native profile environment (commit b6c8398)
- fix(doctor): run per-profile native probes safely (commit 2d4d557)
- fix(plugin): reject nested profile stores (commit 13969cd)
- fix(plugin): clean native link on undo (commit 10aeaa0)
- perf(rules): bash-glob G4 1492ms-to-PASS (commit a9162a7)
- fix(plugin): undo absent links without unsupported unlink (commit 73e0526)
- fix(plugin): report unwritable profiles as refused (commit fc3d8b1)
- fix(doctor): ignore always-apply rules and bound probes (commit 41d111c)
- fix(rules): keep later gh -f quiet (9/9) (commit 30a78ee)
- fix(plugin): name unwritable profile refusal errno (commit dea3b5a)
- fix(plugin): postcheck profile rule coverage (commit a465ff6)
- fix(scratch): log failed reaper actions (commit ddd1383)
- fix(gate): run pre-push checks from committed archive (commit 6874521)
- fix(fleet-watch): preserve tmux env and recover steering (commit 1dee7ec)
- feat(mcp): import MCP servers from other harnesses into OMP profiles and prove them callable (commit db7369c)
- docs-footer: generated footer says the latest-OMP check runs once a day (commit 48baf6e)
- fix(diagnostics): separate rules findings 24/7→31/0 (commit 9eb58e3)
- FLY1 dedup: doctor --scope beads duplicate report (INV-28) (commit 764b915)
- MP3 slice 1: shared beads policy template + closed-edge test (commit 38afcc7)
- PROF1R: implement profile-wide plugin apply and undo (commit e673895)
- main CI health fix and FLY1 dedup (commit dbeb827)
- CYCLE1 reservation age + SEND1 proven send modules with tests (commit 744ecb9)
- PUB1b: doc status gate plus front matter and generated index (commit 7562052)
- CYCLE1: doctor reservations scope accepts --project (commit 1752ee0)
- LAND1: stale-base deletion guard with 38afcc7e59 replay (commit 1298b02)
- RX1: wire regex budget gate into ladder and pre-push (commit 9a2d1bc)
- RX1 CI fixes: pinned br install, ten-stage contract, budget skip hatch (commit ef21da7)
- PUB1d: report stale edits on reserved files (commit cdb1a2a)
- PUB1d timeout-safe work rows (commit 612b647)
- ID1 doctor finder: pane identity scope logic + unit tests (39/39; gate GREEN locally) (commit 873f175)
- MP1 private-index pre-push gate candidate (commit c4965fc)
- perf(rx2): optimize four hot rule conditions (commit d1ba07f)
- perf(scratch): prefilter tmp-path events (commit 4e06e22)
- CI red: allowlist regex-budget.ts in runtime-adapter (commit 4f58add)
- CI red: runtime-adapter.sh back to mode 100755 (4f58add8 made it 644; ladder exits 2 runtime adapter missing) (commit a54c52d)
- fix(integrations): isolate proof scenarios (commit d0b42c8)

- SVC1 service job contract (box 1, part 1): `docs/service-contract.md` states the hardening contract for every recurring job, and `src/service-contract.ts` adds static `service doctor` checks (`contract-*`) for the plist/unit items with planted negatives in `tests/cli/service-contract.test.ts`. Runtime items (single-flight, load gate, time cap, off switch, double schedule, fleet-view `--all`) are specified with owners; wiring into `checkService` waits on the `src/service.ts` holder.
- SVC1 fleet hygiene: `bunfig.toml` `[test] pathIgnorePatterns` excludes `var/agent-tmp/**` (and pins `node_modules/**`) so `bun test` no longer walks ~7,400 scratch `*.test.ts` copies; a planted failing tripwire in scratch proves the exclusion.
- SVC1 fleet view (box 2): `service status --all`/`doctor --all` reach their handlers (parser accepts declared `--all` in place of the positional), and `service list`/`status` rows carry loaded state, last exit, run count and receipt last-run age; planted loaded-job-misreported negative in `tests/cli/service-fleet.test.ts`.
- SVC1 contract wiring (box 1, part 2): `checkService`/`checkServiceLinux` run the `contract-*` checks over installed definitions, and the four interval jobs render RunAtLoad false; live `service doctor kit-update` proves all six checks (stale installs report drift until reinstalled).
- SVC1 single-flight (box 4, module): `src/service-run.ts` claims one lock per job (atomic mkdir, PID-liveness + age backstop, stale empty-dir grace, fail-closed) with 7 planted tests; `service run` wiring maps OVERLAP to SKIPPED-OVERLAP exit 4.
- SVC1 load gate (box 5, module): `src/service-run.ts` `gateRunLoad` binds the 2.5x threshold and shapes the SKIPPED-LOAD verdict (planted high-load test); `service run` wiring gates on entry with no work.
- SVC1 time cap (box 6, module): `src/service-run.ts` `runWithCap` SIGKILLs past the cap and reports TIMEOUT with elapsed time (disturbed-pipe reads guarded); live `/bin/sleep` killed at 203ms for a 200ms cap; `service run` wiring applies the cap and records it.
- SVC1 off switch (box 7, module): `src/service-run.ts` `readJobOff` disables on any `<job>.off` marker (reason from content, fail toward no-run); `service run` wiring checks it first with no run and no receipt.
- SVC1 run wiring (boxes 4-7): `service run` enforces off switch, single-flight, load gate and subprocess time cap in order, releasing the lock on every path; planted end-to-end overlap/load/timeout/off tests through the real command.

- Add `doctor --scope mcp --sources`: read-only inventory of MCP servers configured for Claude, Cursor, Codex and the project `.mcp.json`, with a per-profile matrix over every OMP profile; env and header values appear as names only.
- Add `apply mcp`: import selected servers into OMP profiles' `mcp.json` (interactive walk-through on a terminal, explicit flags otherwise), validated against the installed OMP `mcp-schema.json`, env values written as references, literal credentials refused, existing bytes left in place, one receipt for `undo`; `--startup-timeout-ms`, `--override NAME=ABS_JSON` and `--env-literal` cover slow starts, corrected commands and non-secret config.
- Add `test --mcp`: per profile, a fresh `omp --mode rpc` on a private mirror of the profile's config lists each server's tools through OMP's own client and makes each `--call` through OMP's tool bridge; reports CALLABLE / ZERO_TOOLS / START_TIMEOUT / START_FAILED / CALL_FAILED / NOT_CALLED / NOT_CONFIGURED with a receipt, exit 1 unless every selected server is CALLABLE.
- Fix `test --mcp` false pass: a `--call` is CALLABLE only when its result text has no error shape (`AUTH_ERROR`, `HTTP 4xx/5xx`, `Unauthorized`, `Forbidden`) and matches `--expect SERVER:REGEX`; error text is CALL_FAILED even when the server sets `isError` false (the wolfram-alpha 401 case), and an unchecked answer is UNVERIFIED_RESULT.
- `test --mcp` checks each server's env before the session: an env-name reference unset where OMP runs (process env and the dotenv files OMP loads) is ENV_UNSET, and a `!command` value that fails or prints nothing is COMMAND_FAILED; command output is never shown.
- Add `apply mcp` edit mode: `--env-command SERVER:KEY='!CMD'` sets one env value of an existing entry to an OMP command value (e.g. a macOS keychain lookup), and `--enable NAMES` removes servers from `disabledServers`; both edit in place with plan, receipt and `undo`. The secret scan now also checks the text of `!command` values.

- Fixed doctor rules inventory to keep installed-byte and ownership evidence separate from native per-profile effective-rule findings; `doctor --scope rules` now reports both without altering health evidence.

- Added `omp-kit planning score` for per-mission or fleet scoring from git, beads, and CI evidence; packaged the planning skill and defaults, added repo-level overrides, and made `doctor --scope beads` flag acceptance criteria left in descriptions.
- Corrected health diagnostics to inspect the optional planning-skill row only in kit scope or when the packaged skill file exists; kept N+2 candidate fixtures aligned with packaged `config/` and `skills/` roots.

- Adds a six-hour `fleet-lessons` service job with run-at-load behavior.

- SEND1 proven send (part 2): `omp-kit send SESSION PANE MESSAGE` wraps ntm with a marker poll (15 s), one retry and a state-root drop-folder fallback; the exit code is delivery (OK 0, NOT_DELIVERED 1), never the send call.

- TOOL1 toolchain pins (part 1): `src/infra.ts` parses the pin file fail-closed and diffs installed versions into DRIFT rows, with planted negatives in `tests/cli/infra.test.ts`. Live pin file, `infra check`/`promote` and doctor wiring follow.
- TOOL1 candidate check: `checkInfraCandidate` runs the ladder with the candidate prefix leading PATH and reports PASS or the failing stage (machine toolchain untouched; per-tool acquisition URLs still open).
- TOOL1 guarded promote: `promoteInfra` refuses without human authorization and without a PASSING check for the exact candidate, installs via injection, updates the pin and writes the receipt; `undoPromote` promotes back (readback in pins). Same planted REFUSED/FAILED coverage.
- TOOL1 CLI registration: `infra pin|check|promote|undo` commands with guarded promote (human + passing check + installed readback) and pin backup/restore; candidate staging verifies the binary reports the candidate version.
- TOOL1 quiet-machine rule: `loadGate` refuses ladder work above 1.5x cores and a forced run reports INCONCLUSIVE (never PASS/FAIL), with planted tests; CLI gate + wait + origin/main export follow when `src/cli.ts` frees.
- TOOL1 quiet wiring: `infra check` refuses above 1.5x cores (or waits with `--wait`, or runs forced as INCONCLUSIVE) and runs the ladder from an export of origin/main, never the dirty tree.

- CYCLE1 reservation age (part 1): `doctor --scope reservations` reports exclusive Agent Mail holds older than the limit (default 30 min) with holder, bead and age from `AGENT_MAIL_STORAGE_ROOT`, FAIL when any are overdue.

- Corpus rejects missing or non-directory `--sessions` roots with `INVALID_CORPUS_SELECTION`; unknown schema versions refuse with a named error before writing a report; fixed-fixture bash counts match the legacy Python extractor.
- Corpus counts malformed rows as parse errors without failing the run (planted truncated row yields parse_errors 1, counts unchanged).
- Corpus seeded fixture reproduces identical counts on repeat runs (two consecutive reports deep-equal).

- Fixed fleet-watch service setup and capture handling: the service preserves `TMUX_TMPDIR`, rejects missing config/socket-directory inputs, and uses absolute PATH entries; capture failures report `NO_DECISION` with the error instead of nudging an assumed-idle pane. Idle `Steering · N` panes submit one queued message with `M-Up` then `Enter` and log it; busy panes are left untouched. Added coordinator/worker configuration and doctor coverage.

- Added explicit `allow_bypass: false` to the shared Beads policy template and a known-bad fixture; fresh-context gate providers no longer bypass the implementer-identity guard.

- SYNC1 start gate (box 1): `scripts/sync-check.sh --repo DIR` refuses exit 4 unless HEAD equals origin/main after fetch, printing `drop back: sync first`, the behind count and the exact `merge --ff-only` command; 19-case contract in `tests/cli/sync-check.test.sh` (file:// bare origin: current passes, 3-behind refused with count + command).
- SYNC1 fast-forward (box 2): `sync-check.sh --repo DIR --fast-forward` moves HEAD via git's own ff-only merge (refuses rather than overwrite dirty paths), reports DIVERGED without attempting when histories split, and never stashes, resets or rebases; planted dirty-blocked and diverged cases prove HEAD and content untouched.
- SYNC1 post-push assertion (box 3): `sync-check.sh --repo DIR --assert-synced` reports POST-PUSH-GAP with the behind count after a landing (exit 4) or clean (exit 0); planted gap + clean cases in the contract.
- SYNC1 close gate at review entry (box 4): `scripts/br-shim.sh` runs `close-guard.sh` unchanged on `br update ID --status in_review` and `br close ID`, refusing the transition on its FAIL before a grader spends time on self-review; all other invocations pass through byte-identical. Planted claimant-refused / other-passes / label-passes / non-review-ungated cases in `tests/cli/br-shim.test.sh` (stub br serves canned bead JSON, argv file proves the transition never reached real br on refusal).
- SYNC1 install + doctor (box 5): `scripts/install-sync-check.sh [REPO]` installs a self-contained copy with a verify probe and printed undo (planted installer contract); `doctor.sh` check 10 `sync` fetches every dev-root repo carrying scripts/sync-check.sh and RED-names laggards. Rolled out to uds; baseline 2026-10-06: uds 251 behind, companion 51 behind; 0-behind-for-a-day measurement started.

- Add `omp-kit heavy` for bounded, machine-wide load admission with nice-10 execution, per-pane exclusion, queue status, and `--no-wait` deferral; route ladder and fresh-gate heavy work through it.

## 0.2.5 — 2026-10-04

Certified on OMP 18.4.2 (minimum) and 18.6.0 (latest). The `v0.2.4` tag failed its release-notes check before any build and was never published; this release carries everything since 0.2.3.

### New

- Worker callbacks: the plugin's `kit-callback` extension reports a worker's terminal `DONE`/`BLOCKED` line, or a bounded `IDLE` excerpt, to its fleet coordinator when the agent stops. It skips continuations and coordinator panes, suppresses identical repeats, and stays silent when unconfigured or when sending fails.
- A `fleet-watch` service job (`omp-kit service install fleet-watch`): a config-driven idle watcher that nudges idle worker panes, escalates panes that stay idle, records each decision as JSONL, and honors an off switch.
- `omp-kit doctor --scope sessions` lists live OMP sessions and their tmux panes and names any session that predates the installed OMP, kit plugin, or `~/.agents/AGENTS.md`.
- `omp-kit doctor --scope browsers` finds headless Chrome left behind by OMP's browser tool, including reparented processes and their code-sign clones; the scratch job reaps those orphans by recorded PID and never quarantines a clone that a live Chrome still uses.
- `omp-kit scratch release DIR` marks finished task scratch for the reaper. The scratch reaper now applies its plan, records each run, and runs at load and every six hours.
- `kit-regex-engineering` reminds agents to use the regex-engineering skill before adding patterns; `omp-kit doctor --scope regex-tools` reports the required regex tools, and the pre-push gate and CI scan changed JS/TS/Python for catastrophic-backtracking patterns.
- An opt-in `kit-update` service job runs kit updates on a schedule and reports an explicit outcome, including undone runs.
- Skill-set selection pins the core skills named in `AGENTS.md` and picks a router skill for lean profiles.

### Fixed

- Five Bash safety rules (`kit-relative-path-not-cwd`, `kit-no-force-push`, `kit-gate-must-name-the-plant`, `zz-canary-scope-probe`, `kit-close-needs-evidence`) match their literal first and recognize tab- and newline-separated commands. On long streamed commands they no longer cost quadratic time (for example 6,957 ms to under 0.01 ms on a 16 KB input).
- Extension apply bundles the fleet guard with its imports, rolls back an extension whose imports do not resolve, and skips the import check for configuration-only applies.
- Service jobs run with a private `TMPDIR` under the omp-kit state root, and `doctor` checks that exact path and its permissions. Scratch release refuses an owner PID that was reused by another process. Linux interval jobs install and report their `.timer` correctly.
- Regexes that read external input (digests, profile names, CLI input) check input length before matching.
- `omp-kit doctor --scope work` works again.
- The Agent Mail hook installer matches the project by its canonical Git root, including from linked worktrees, so the pre-commit and pre-push guards find the project's reservations.
- Migrate recognizes unedited copies of rules from earlier kit releases as removable and keeps edited copies as overlays.
- Private memory audits recognize the reviewed OMP 18.5.1 sources.

### Contributors and release

- Native certification and package checks derive rule counts from the release manifest instead of fixed numbers; `MANIFEST.tsv` is generated at package time.
- The pre-push gate tests an exact archive of the pushed commit as a source checkout, including a CLI compile, the harness gate, and focused suites for changed areas.
- CI runs the differential oracle and checks that a planted mismatch fails it; `scripts/differential-fuzz.ts` compares native and reference rule matching over generated inputs.
- The release-notes check accepts fragments that name commits, and covers tag-time release commits.
- `omp-kit corpus` refuses missing `--sessions` roots and unknown schema versions with named errors.

## 0.2.3 — 2026-10-03

- doctor --scope work inventories configured developer repositories read-only: dirty files, upstream/ahead state, stashes, detached worktrees, last-commit age, active worktrees, bounded per-repo timeouts, risk sorting, JSON envelopes and human tables. It never fetches or writes. (PR #57)
- Packaged test isolation falls back to OS-approved temporary roots when `TMPDIR` points outside them, keeping stage adapters within their system-temp boundary.
- The metamorphic ratchet baseline is deleted: `test --metamorphic` and the ladder now fail on any break, with no checked-in allowance (L1). (PR #55)
- Memory readiness recognizes the shared OMP 18.4.10/18.4.11 memory-settings/resolver/config-source fingerprint for on-disk OFF; unknown source stays UNVERIFIED and runtime stays NOT_PROBED.
- `scripts/omp-compat.json` is the only checked-in OMP minimum; CI runs the ladder and native certification on that floor and the run-resolved npm latest, recording both versions per advertised platform. (PR #25)
- Memory readiness trusts only reviewed source hashes for OMP memory settings and the redactor. OMP 18.4.9 reports the known synthetic PEM redaction miss; runtime stays NOT_PROBED and changed source bytes stay UNVERIFIED.
- Private at-rest memory audits trust reviewed OMP/Mnemopi source-hash sets rather than release labels; exact reviewed bytes remain covered under newer labels while changes to pinned sources stay UNVERIFIED.
- Fast-test case denominators now derive from the release-manifest-verified `cases/cases.tsv`, removing manually synchronized count pins.

- `doctor --scope extensions` resolves hook imports from the extension's real path, avoiding false unresolvable-import findings for symlinked hooks. (PR #52)

- CI uploads ladder reports as a seven-day artifact on failure and uploads nothing on successful runs. (PR #51)

- Fleet-guard installation plans skip unmanaged extension collisions with `SKIPPED_UNMANAGED`, preserve operator-owned bytes, and still install `fleet-guard.ts`. (PR #56)

- `kit-test-skip` now blocks a Go `t.Skip` inserted by an `edit` in a live session. OMP matches edit arguments as JSON, where tab indentation becomes `\t`, and the rule's word boundary missed it; live scenarios now cover both `write` and `edit`. Native certification derives its expected live-scenario set from `tests/live/scenarios.json` instead of a fixed count.

- Metamorphic validation now respects each rule's declared source scope, so prose-only rules no longer falsely block tool actions; generated native-vs-kit checks report only explicitly tracked runtime mismatches.

- `omp-kit corpus` works when OMP was installed with npm: native edit inspection resolves `@oh-my-pi/pi-natives` from the installed OMP package instead of assuming a hoisted sibling. Corpus scan failures name the harness exit code and a bounded stderr tail with kit- and OMP-relative module paths, redacting other paths. (commit 2f404c3) (commit 7d9da7e) (commit 62e99d3) (commit 34938fc)

- Bash rules prefilter the command boundary before long quoted-argument lookbehinds. Large positive Bash `--observe` probes report the verified terminal match without replaying every prefix; full G2/G3 gate sweeps remain exhaustive.

- Runtime scratch roots resolve through the canonicalized system temp directory; a `TMPDIR` that is missing, outside the platform temp root, or nested under the caller's `HOME` falls back to the platform root (Darwin `getconf DARWIN_USER_TEMP_DIR`, else `/tmp`). (commit ea63cdf) (commit ccac6bb) (commit e955ada) (commit 1343517) (commit 428a16f)

- Memory readiness recognizes the reviewed OMP 18.5.0 memory sources; an unreviewed source is reported with its exact file and sha256 and stays UNVERIFIED.

- Add a calibrated rule doctor report.

- Update expectations share parsing with manifest-verified `cases.tsv`, and native case counts come from the installed corpus.

- Release assembly preserves merge-safe per-bead fragments, prints previews by default, requires `--write` for in-place updates, and reports each merged PR's fragment or tagged Unreleased-line coverage; uncovered PRs fail the check.
- The release check now covers direct main commits by their `Bead:` trailer and requires a reason for `[no-changelog]` waivers.

- Bun tests preload the shared test scratch setup.

- Gate native differential fuzzing on live wire parity.

- Contributors get a pre-push gate: the manifest check, the harness gate and changed-area focused suites run against a `git archive` of the pushed commit, refusing stale manifests and deleted gate functions.

- The release-notes check passes on the assembled release commit, where legacy Unreleased lines have moved into the new version section.

## 0.2.2 — 2026-10-02

- `doctor --scope services` inventories launchd jobs and validates declared required jobs without loading or writing services. (PR #24)
- `omp-kit service` manages launchd and systemd user jobs with idempotent install, backup-first replacement, status, doctor, logs, and run; `omp-watch` remains render-only. (PR #27)
- Skill-set recipes now resolve per project, keeping project skills out of the global recipe. (PR #29)
- The NE-6 AST-grep candidate for `kit-test-skip` is gated by named live-scenario evidence, retaining regex fallback. (PR #30)
- Four rules enforce the documented agent scratch, process-kill, deletion-request, and force-push procedures. (PR #31)
- Scratch planning and consented reaping use owner/liveness/open-file checks, quarantine and receipts; a daily service reports without applying reaps. (PR #32)
- The plugin session-shutdown guard reports dirty, unpushed, or no-upstream repository state without changing it. (PR #33)
- `doctor --scope extensions` reports unresolvable imports from listed hooks and extensions without executing them. (PR #34)
- README and NE-9 now direct v0.2.0/v0.2.1 upgrades through the installer when embedded case counts differ. (PR #36)
- `migrate --plan|--apply` previews legacy rule migration and removes only plugin-identical copies, with backups, source verification, and undo. (PR #37)
- Migration plans now show unified diffs and native overlay destinations for edited rules, including the `kit-standing-law` exception. (PR #38)
- LSP probes retain a bounded failure-only JSON-RPC receipt ring without payload bodies. (PR #39)
- Isolated live tests disable implicit local model-provider discovery; TERM/INT now terminates and reaps the active process tree. (PR #40)
- Update postchecks derive expectations from hash-verified target release files and distinguish named failures from changed OMP identity. (PR #41)
- `test --mutants` measures per-rule mutation adequacy through the real matcher, reporting survivors, compile failures, and budget truncation. (PR #42)
- Extension plans skip profiles with named configuration problems and report uncovered profiles rather than refusing the entire plan. (PR #43)
- Fleet-guard sessions export the live Agent Mail root; doctor reports when the guard could fail open without it. (PR #44)
- `doctor --scope dicklesworthstone` compares installed and latest tool versions while reporting uncertain installation sources honestly. (PR #46)
- `test --repeat` reports statistically bounded repeat verdicts and supports scenario and baseline selection. (PR #47)
- `test --metamorphic` checks rule behavior under invariant-preserving transformations and ratchets against a reviewed baseline. (PR #48)
- The cold-start LSP probe removes an unproven reference retry and cleans up while retaining failure-only diagnostics. (PR #49)
- The metamorphic corpus now covers seven env-prefix anchors; the corresponding rule fixes and baseline updates ship together. (PR #50)
- Quoting and line-continuation false-fire fixes bring the metamorphic ratchet baseline from 161 to 0. (PR #53)
## 0.2.1 — 2026-10-01

- The rule pack installs as a native OMP plugin: the repository root carries an `omp` manifest, so `omp plugin install github:JYeswak/omp-kit-companion#v0.2.1` delivers the rules and the guard extension through OMP's own plugin loader, with no copies in `~/.agents/rules`. `scripts/plugin-lifecycle.sh` proves install, live blocking, disable, uninstall, git install and upgrade on the installed OMP.
- `doctor --scope context` reports what each profile lists into the prompt (skills, context files, rules, tool descriptors), measured with OMP's own loaders. `test --capabilities FILE` checks that a declared set of required skills, tools, rules and LSP languages still resolves, and exits 1 naming any that are missing.
- `examples skill-set` derives a skill set from the skills a profile actually read in its recent sessions, and renders, but never applies, a pruned-profile recipe. The recipe's listing bytes are measured through OMP's loader and gated by `test --capabilities`.
- Leaked mock servers can no longer accumulate silently: `scripts/e2e-live.sh` reaps each scenario mock with a bounded wait (TERM, grace, KILL) and fails at exit naming any defiant or surviving scenario, and the real-HOME journey ends with a `no_leaked_processes` step that expects zero processes with argv or cwd under the journey work dir.
- The source `scripts/doctor.sh` no longer runs the legacy model-role/quota check; `scripts/role-check.ts` is removed from releases and embedded runtime allowlists. Model/provider routing remains outside the kit.
- `doctor --scope settings` reads listed profile TTSR keys through native OMP `config get` and reports per-key `OK`, `DRIFT` or `UNVERIFIED` without claiming runtime activation. An optional JSON array at `$XDG_CONFIG_HOME/omp-kit/ttsr-profiles.json` (default `$HOME/.config/omp-kit/ttsr-profiles.json`) selects profiles; invalid or unsafe files fail closed. `apply policy --plan` emits exact per-profile native `config set` commands; consented apply stores byte-exact configs for each changed profile under the private state root and verifies every changed key with native readback. Policy fields outside the TTSR allowlist are refused, leaving model/provider routing to their owner.
- `apply policy --plan` no longer depends on legacy `~/.agents/rules`, so plugin-managed rules remain a valid route; repair preserves `INVALID_STATE_ROOT`, and pre-write policy drift is `FRESH_PLAN` while post-write failure remains `POLICY_APPLY_PARTIAL`.

- The `test-skip-ts-fire` live scenario carries a realistic post-match tail so the gate no longer depends on OMP's late-interrupt race; the old short-tail shape survives as the report-only `omp-late-interrupt-probe` scenario (`PROBE omp-late-interrupt: continued|aborted`, never counted, surfaced per OMP version in the compatibility workflow summary).
- Two quoted-text false fires are quiet: `kit-test-skip` now scopes `edit`/`write` to code extensions (`*.rs`, `*.ts`, `*.tsx`, `*.js`, `*.jsx`, `*.mjs`, `*.cjs`, `*.py`, `*.go`) plus the `tests/` and `spec/` trees, so quoting a skip marker in Markdown no longer blocks; `kit-settings-mutation` no longer fires when the config-set text sits inside a double- or single-quoted argument opened by `=` or `--flag` of another command (executable `$(...)` substitutions still fire). All existing fire rows still fire.
- Four agent-procedure rules enforce `~/.agents/AGENTS.md`: `kit-scratch-tmp` (writes under `/tmp` by write tool or shell redirect; reads and `$TMPDIR`-under-`var/agent-tmp` stay quiet), `kit-no-pattern-kill` (`pkill`/`killall`; PID kills and quoted mentions stay quiet), `kit-no-ask-rmrf` (assistant text asking the human to clear scratch; refusals and backticked mentions stay quiet), and `kit-no-force-push` (bare `--force`/`-f`; `--force-with-lease` stays quiet). Each cites its AGENTS.md section and carries fire plus quiet near-miss rows; quotes that merely mention a pattern do not fire. Corpus now 22 rules, 295 cases, 78 live scenarios.
- Session-end save guard: the plugin's new `extensions/kit-save-guard.ts` listens for OMP's `session_shutdown` event and runs read-only git inspection in the session repo, emitting one warning line for uncommitted files, commits ahead of upstream, or a missing upstream. Installing the plugin is the opt-in; it never commits, stashes, or pushes, and stays silent for clean repos, non-repos, and every error.

## 0.2.0 — 2026-10-01

- A real-HOME journey (52,000-file HOME, edited rules, legacy 0755 state root, a concurrent writer) runs the install-to-update path on macOS and Linux CI with a JSONL step log. It would have caught every real-machine failure fixed in this release.
- The README is a 60-second start; usage, configuration and a native-OMP guide live under `docs/`, and their verified command blocks run in the test suite against the installed OMP.
- The OMP-compatibility workflow records each case's G3 first-fire index per OMP version as an artifact and reports index changes against the previous version in the run summary, even when green. It also runs the G4 live suite a second time under OMP's own default TTSR settings (`scripts/e2e-live.sh` honors `OMP_KIT_DEFAULT_TTSR=1` to skip installing the kit policy) and reports that outcome separately; only the kit-policy run gates the job.
- `test --record` saves the verdict and the tested OMP in the private state root, and `status`/`doctor` add an `omp_drift` finding that turns DEGRADED when OMP changes after the last recorded test or that test failed. `examples omp-watch` renders, but never installs, a launchd agent or systemd `.path` unit that re-runs `test --record` whenever OMP's package changes and notifies only on failure. Plain `test` remains read-only.
- `omp-kit health` judges only what a read-only inventory can prove (kit, manifest, omp, state root, installed rules, and `omp_drift`), so a healthy install with a recorded passing test exits 0. Structurally unprovable rows (effective profile, matcher, and the rest) are still reported but listed separately in `data.not_judged` with their reasons and never affect the exit code. A passing `health` never certifies the effective OMP profile. `status` and `doctor` are unchanged.
- `test --full` and the `update --apply` postcheck work on a real HOME. The integrity check no longer hashes the entire HOME, which always exceeded its 5,000-entry bound and changed under concurrent agent work, so every real machine failed. It now watches only operator paths a kit run could write: OMP profile config files, rule and extension directories, installed plugins, the kit state root, and the selected project's `.omp`/`.agents`/`.claude`. Content and mode are compared; failures name the exact changed path.
- A kit state root created with group or other permissions (for example 0755 by pre-CLI install scripts) no longer surfaces as a generic `STATE_UNSAFE` receipt error from `audit`, `undo`, `why`, `apply`, `repair` or `update`. The error now names the path and mode, `doctor` reports a `state_root` finding, and `repair --scope state` restores 0700 on that directory only, leaving its contents untouched.
- A failed update postcheck reports why: failing stages, changed operator paths, OMP version and live counts in `postcheck_detail`, plus the exact `omp-kit undo RECEIPT --yes` that returns to the previous release and clears the pending receipt.
- `omp-kit --version` (or `-V`) prints the kit version; `update --version X.Y.Z` is unchanged. Human (non-`--json`) status and doctor output is a one-line-per-component summary with distinct next actions instead of a raw JSON dump; user-facing text no longer cites internal tracker item numbers, and the effective-profile action points at OMP's own `omp config list`.
- Upgrading from v0.1.x: those binaries cannot finish `update --apply` on a real HOME (the snapshot bug above), so reinstall with the installer. If an earlier attempt left a pending update, `omp-kit undo RECEIPT --yes` (receipt from `omp-kit audit`) restores the previous release and clears it.
- The internal TTSR harness reports a selected rule/case through the real OMP matcher: completed payload, first streamed or final hit, typed unavailable states, and OMP/kit artifact digests. An independently supplied rule SHA-256 rejects same-name substitutions; these are matcher/prefix observations, not G4/effective-profile proof.
- Installed `test --rules ABS_DIR --cases ABS_FILE` checks the explicitly selected external pack through the real native matcher instead of silently testing the bundled pack. Bundled defaults remain separate; external mode refuses `--full`/project scopes and reports unavailable dependencies without converting them to quiet passes.
- Explicit `--live-fixture` adds selected-rule G4 after external G1–G3 passes. Its strict public/synthetic language permits three fixed native write scenarios, checks actual allow/block/quiet markers and attributed interruption evidence, and records input/runtime/resource readbacks. It executes no caller-provided commands and makes no effective-profile claim.
- Read-only `review rules` compares old/new rule bytes on the frozen union of authored witnesses, preserving deleted or relabeled incumbent cases. It reports provenance, conflicts, native whole/prefix transitions, identity brackets, and a bounded denominator; it never approves or applies a rule change.
- The shared line-deletion reducer enforces strict UTF-8 size decrease, attempt/time budgets, stable evaluator identity, and independent final replay. Unavailable or lost predicates cannot produce an accepted result; it does not claim global minimality or provide a private-transcript export path.
- Installed `review reduce` accepts an explicitly approved public/synthetic false-fire fixture, preserves its authored context and native G2/G3 predicate, and exports a hash-pinned replay fixture only after independent final replay. `--replay-only` observes the real matcher again; missing evidence, changed identity, and lost fires cannot become successful reductions.
- The isolated no-terminal hook-refusal probe is qualified for OMP 18.4.5: exit 2, a TTY refusal, and no synthetic hook import. This adds no hook activation or release certification; 18.4.2 and unqualified versions remain explicitly skipped.
- The installed runtime adapter now transfers its PID to the embedded runtime after validation. Terminating a private mock server closes its socket and output streams instead of leaving an orphan child holding them open.
- The settings-mutation reminder offers installed-only read-only plans when the selected profile permits them, otherwise an explicit owner-approval handoff. A real OMP continuation case now checks the tool result rather than a scripted model claim; it never auto-applies profile changes.
- The explicitly consented `doctor --scope lsp --deep` path exercises OMP's real `lsp` tool against a private TypeScript fixture and loopback mock model. It refuses workspace-local/custom commands, preserves static-readiness semantics, reports distinct failure classes and input/runtime snapshots, and stops only the private LSP mux; it does not certify every server type or the target workspace runtime.

## 0.1.1 — 2026-09-29

- The standalone installer now prevents its Python subprocesses from writing standard-library bytecode into a fresh macOS HOME. Offline and online dry runs, and a failed online archive download, leave the isolated HOME untouched; the real-archive regression also runs on native macOS CI.
- Rebuild and recertify all four native release targets against the exact tagged source. The `v0.1.0` assets remain immutable; upgrade only by explicitly choosing `v0.1.1`'s reviewed local index and archive.

## 0.1.0 — 2026-09-29

- First public source-only root for the compiled `omp-kit` companion. The original working repository and its prior history remain private; this root does not inherit those commits. The [MIT license](LICENSE) and [release assets](https://github.com/JYeswak/omp-kit-companion/releases/tag/v0.1.0) describe the published boundary.
- The CLI inspects OMP, checks 18 rules against 274 fire/quiet cases and streamed prefixes, runs isolated live/mock-model scenarios, previews guarded rule/policy/extension changes, records receipts, and offers read-only profile, LSP and MCP examples. Installed checks do not certify a user's effective profile.
- Versioned macOS and Linux arm64/x64 archives are distributed only for native-certified targets in the release index. The standalone installer checks the archive digest and internal file manifest before atomically selecting a versioned executable. Index hashes give integrity, **not** publisher authentication. OMP, models and profiles are never installed by implication.
- The kit-only updater requires an exact newer version and matching **local** index and archive. At initial publication no newer release existed; OMP updates remain external. A failed post-check leaves a pending recovery receipt rather than claiming rollback or GREEN.
- The README hero was graded on its [exact shipped JPEG](visual/hero-identity-grade.json) with the hash-locked Yuzu anchor and unchanged 70-point numeric formula: ChatGPT OAuth `gpt-5.6-luna` scored 80.9; independent xAI `grok-4.7` scored 79.5. The original `gpt-4o-mini` judge did **not** run; the receipt identifies the substitution.

This is the beginning of the public timeline, not a relabeling of the older private development history. See [NEGATIVE_EVIDENCE.md](NEGATIVE_EVIDENCE.md) for measured limits and refuted claims.
