# Changelog

## [Unreleased]

<!-- New notes go in changelog.d/<bead>.md (optional first line `### Added|Changed|Fixed|Removed|Breaking Changes`); the release train folds them here. -->

## [0.2.43] - 2026-10-17

### Changed

- Main CI and native certification install OMP 18.11.3, certified by omp-certify. (PR #106)

### Fixed

- Run the existing fleet lessons report producer through a keeper-bound, capped child for `service run fleet-lessons`, instead of the matcher fallback; producer failure records a failed job receipt.
- Refuse intake trackers not registered by configured repositories before producer writes, and refuse registered services without an implemented body instead of running the matcher.
- Preserve a fleet lessons OFF transition before child execution as no-run without a success receipt, and refuse zero-exit child results that do not confirm the report producer.
- Keep fleet lessons subprocess descendants in the producer's owned group so timeout and cancellation stop nested work; the `omp-watch` matcher retains its existing execution mode.
- Hold learning intake writes when native tracker inventory is malformed or incomplete, and read all intake and grade-marker results rather than silently accepting a partial page. (commit 007ede74ea)
- Exercise managed-job matcher retention from packaged runtime assets without requiring a Git HEAD, and honor the caller's logical case directory in archive-based verification. (commit 2e72be6dab)
- The push gate now runs CI's shellcheck version on changed shell files instead of whatever is installed locally (ompkit-f2e4). Local shellcheck 0.11.0 stays silent on SC2015-info while CI's apt 0.9.0 exits 1, which turned main red for 4 commits on release-train.sh guards. The focused stage prefers `koalaman/shellcheck:v0.9.0` via docker (pulling once when missing) and falls back to the local binary with an explicit version-skew warning naming both versions. Shell findings now refuse the push: previously a finding inside the focused stage was swallowed because the step runner's condition context disables errexit, so the gate printed the finding and reported GREEN.

## [0.2.42] - 2026-10-17

### Breaking Changes

- Service single-flight claims now carry a random per-acquisition token. Old, malformed or unreadable claims fail closed until their owner reconciles them; age alone no longer authorizes takeover. A failed PID probe proves death only for `ESRCH`, never `EPERM`.
- Serialize claim-file mutations with a persistent per-job SQLite kernel-lock inode, using Bun's built-in driver without an additional dependency. Never unlink the gate during routine cleanup. Release verifies the acquired nonce and directory identity before removing a claim.
- Bind gate/body and delegated-child admission to the new claim token, including same-PID acquisitions in one clock tick. Remove the production-only fixture constructor; test fixtures construct their own metadata.
- Source and owned-consumer regressions do not qualify installed binaries, activate services, or authorize production scratch reclamation. Original SVC1 installed-source and controlled actual-body acceptance remains separate.
- Manual scratch BUSY coverage acquires a real scheduled keeper through the production lock API instead of planting obsolete claim metadata; it still requires the actual holder PID in the CLI result.
- Scratch CLI fixtures keep the absolute-path browser process inventory empty in keeper and worker processes. This prevents the affected test suite from selecting real OMP browsers while preserving real owner-PID/start, open-file, quarantine and reap controls.

### Changed

- Native tracker-export regeneration of .beads/issues.jsonl is no longer refused as a foreign-bead revert: when every removed row's issue id still has a row in the staged file, rule (b) skips it; any lost issue row is still refused.
- The stale-worktree guard no longer judges moved lines as reverts: a removed line re-added in the same commit at least as often is a move (rule (b) only; stale mtimes still refuse). A `Supersedes: <sha>` trailer declares rewrites at Revert strength. Tracker-export `.beads/issues.jsonl` regenerations that lose no issue row skip rule (b); any lost row still refuses.
- Fix service-run claim contention so a blocked acquisition leaves no unreported live claim and can acquire normally once a reader releases the gate.
- Shared-checkout reminders now cover bare `git pull` and route reserved-path publication through owner-bound `omp-kit land` instead of hand-built private-index candidates.
- The reservation cache honors only covered results on read: a cached negative can never allow an edit, so a refusal followed by a grant inside the cache window is allowed on re-query.

### Fixed

- The private memory audit now recognises OMP 18.11.3, the version Tern installs for the fleet. It previously refused 18.11.3 sources as unsupported. The 18.11.3 source tuple was reviewed against 18.9.2: only `mnemopi/config.ts` and `mnemopi/state.ts` changed, with no change to any store, bank, table or row. The two OMP 18.10.2 and 18.11.3 changelog entries that blocked certification are recorded as not affecting the kit, which never calls `ui.approve`. (ompkit-3zhf)
- `kit-no-double-quoted-substitution` now stops the bash call before it runs instead of reminding afterwards. A backtick or `$(` inside a double-quoted argument to `br comments add`, `br create`, `br update` or `git commit -m` is a tripwire (`interruptMode: tool-only`). The shell runs the substitution before the command sees it. It leaked an environment into a tracker comment on 2026-10-10, and on 2026-10-16 it ran a sync script with `--apply` against shared records. Single quotes, `-f <file>`, escaped backticks and plain `$VAR` still pass. (ompkit-3zi7)
- Release certification on macOS runners no longer stalls for 900 s per harness. The runner image ships with about 13% of its disk free, under sbh's 14% pressure floor, so `omp-kit heavy` correctly deferred every native-certification and real-home-journey leg. `scripts/ci-install-sbh.sh` now frees preinstalled SDKs the kit never uses (Android, .NET, inactive Xcode versions), one at a time, until sbh admits. The floor itself is unchanged, and the script only acts on Actions macOS runners. (ompkit-fp72.117)
- The staged-imports commit guard and the push gate's import check accept TypeScript NodeNext imports. A `.ts` file that imports `./registry.js` is backed by `registry.ts` (likewise `.jsx` by `.tsx`, `.mjs` by `.mts`, `.cjs` by `.cts`, and declaration files). Valid commits in NodeNext repositories were refused with "imports missing ./registry.js". An import with no source behind it is still refused. (ompkit-fp72.122)
- Align substitution live scenarios with the pre-execution tripwire rule: the unsafe double-quoted substitution must not create its action marker; the single-quoted near miss still executes. Preserve the production matcher and coverage checks.

## [0.2.41] - 2026-10-16

### Added

- Add `omp-kit tern` native SDK/control commands, context-aware Luau bindings, declaration and documentation drift checks, wire codecs, and optional native plugin assets; incomplete or ambiguous SDK replies fail closed, and native observations remain separate from coverage and fleet-promotion claims.

### Changed

- The doctor names rch daemon reachability distinctly: a live rchd whose socket path is missing or replaced reports FAIL as socket unlinked (with the kickstart restore route), never as missing worker capacity.
- Beads doctor and planning score share configurable acceptance-breadth limits (5 files and 3 path-derived components by default), include component-aware split suggestions, and preserve UNKNOWN/UNVERIFIED for missing or unparseable scope.
- After compaction, the flywheel guard blocks edit, write, br update/close/comments and git commit/push until it observes a successful read of the named AGENTS.md and a br show of the session's in_progress bead (or an empty br list); gate errors block.

### Fixed

- New `commit-msg` guard member refuses any commit that would revert lines landed in HEAD, naming path, commit and bead, unless the revert is declared with a `Revert: <sha>` trailer; same-bead rework still passes. New `doctor --scope stale-worktree` lists worktree paths that remove landed lines with their blamed commits. (ompkit-fp72.120.10)
- Release certification no longer fails at once on every native target. `omp-kit heavy` now refuses with exit 69 when its disk observer (sbh) is missing, rather than skipping the disk check. The release train's `native-certification` and `real-home-journey` jobs never installed sbh, so the harness gate stopped there (train run 38956579974, `producer_rc=69` on all ship platforms). Both jobs now install the same pinned sbh as the ladders. [selftest]
- `omp-kit scratch` no longer takes a live owner's pid for a reused one when the `.owner` gives only a coarse `created` time. It used to read a bare date such as `created: "2026-10-15"` as UTC midnight. So any process started later that same day counted as reused, and its scratch was planned for REAP while it was still running. On 2026-10-16 this happened to a live eval kernel's review dir. Reuse is now proven only when the process started after the end of the created value's own precision: a whole day plus the widest UTC offset for a bare date, the whole minute for minute precision, and the whole second for second precision. Any other format counts as unprovable, so the dir stays LIVE. [test]
- The fleet guard's amend refusal also catches git called by its full path (`/usr/bin/git commit --amend`). It no longer misreads commit option values (`-m`, `--message`, `-F`, `--file`, `--author`, `--date`, reuse/reedit, and a trailing `-m` in a flag bundle) as flags. (ompkit-xa5s.25)

## [0.2.40] - 2026-10-16

### Breaking Changes

- Add `omp-kit converge` to report, explicitly resolve, and publish shared-main integration without overwriting peer staged or worktree changes (commit e8543ce).
- Change `omp-kit land` to commit reserved paths on shared main before publication, replacing private-index candidates with explicit saved-but-unpublished and uncertain-save outcomes.
- Retire the legacy `align` command; use `converge` to preserve the shared main history.

### Added

- `tern-ref` command group: version-pinned, searchable, runtime-validated local reference for the Tern Plugin SDK (`build`, `query`, `validate`, `drift`), with frozen queries/eval fixtures and e2e coverage. (ompkit-fp72.120.8)
- Fleet-round barrier timer wakes seats when the config opts in (`barrier.deliver: true`, default false): a newly REJECTED report notifies that project's `director` seat only, and a first-seen MET/MISSED barrier or new ESCALATE notifies the `chief` seat, all via `omp-kit send` with dedup keys in `barrier-state.json`. (ompkit-axpa)
- New kit rule `kit-no-owner-homework`: fleet-owned engineering (opportunity binding, mount-source custody, the private-auth route, mounted render integration) is decided from metadata and source, never delegated upward as owner homework. Spending approvals with amounts and director rulings with tried options stay quiet. (ompkit-gm0v)
- Add context-aware native Tern SDK binding generation, declaration/documentation drift checks, and bounded Surface Protocol codecs. The root CLI command and native runtime qualification are not enabled by this source save.
- Add session-backed Tern seat observations with explicit UNKNOWN for state that cannot be established from the native journal (commit cc0ad65).
- Owner gate `scripts/check-tap-owner.sh`: before any tap or formula is published, the distribution account recorded for the tap must own it, or publication is refused (exit 4). A formula is a delivery path; it never changes what the kit does. (ompkit-rc-epic-land-fix-release-dogfood-rz5.59.4.4) (commit 249b395)

### Changed

- Land now recognizes native Herdr pane identity through its project-scoped Agent Mail registration and refuses conflicting outer-pane markers (commit d5cd33d).
- The daily fleet report shows retained issue-timestamp cohorts, top creators and open P0 stock; the `br` shim flags similar open titles, requires a named P0 displacement at the configured cap (default 15), and pages the project director after a 21st create within an hour. `br create --file` is refused; submit each issue individually so it passes the same checks (commit 21f6282).
- Wire `lessons add` and `checkin` to the existing lesson APIs. `--commit --bead ID` now uses normal hooks, commits only a clean lesson path on shared `main`, and fast-forward publishes `main`; private-index candidate publication is retired. (commit 7ef7bef)
- Preserve peer staged/worktree changes outside the lesson path and refuse existing lesson-path dirt, mode changes, detached checkouts, and detected state changes. Origin contention retains the local lesson commit and requires normal convergence; it never force-pushes.
- Carry bead linkage into normal commit trailers, verify local/remote-main ancestry, and report post-save failures as unverified rather than claiming no mutation. Check-ins without explicit completed items use the existing activity reader and refuse unavailable coverage instead of recording false zeros.
- Use a standalone `[pending]` verification level for generated record commits so the normal verification-level hook can accept transport without falsely certifying the lesson's content. (commit bd9aa74)
- Classify non-fast-forward publication from Git's exact porcelain rejection record before guard diagnostics, so a remote pathname containing `pre-push` does not hide origin contention.
- Finite service runs now own their process group by default on macOS and Linux, drain both output pipes concurrently, and bound descendant termination and descriptor cleanup on timeout or cancellation without changing native PTY or long-lived service launchers.
- Filter doctor scopes before diagnostic work, avoiding unrelated OMP profile probes. Status and bare invocation retain on-disk findings and explicitly report runtime rule activation as NOT_RUN; use `omp-kit doctor --scope rules --json` for live per-profile checks. Health and full doctor retain their requested checks.
- Prevent `fleet flush-pending` from submitting an empty or changed draft after dequeue; ambiguous queues require manual handling.
- Add session-file proof and explicit pending/refused outcomes for Tern delivery; queued Tern submission remains disabled pending qualification.
- Refuse bare goal directives before transport effects; use the explicit `/goal set` form instead.
- Breaking planning-score JSON/config change: rename `bead_self_contained.value.test_share` and the corresponding target/bounds field to `acceptance_present_share`; rename TOML target `bead_self_contained_test_share` to `bead_self_contained_acceptance_present_share`. This is the fraction of mission beads with nonblank acceptance prose, not evidence of named tests, execution, coverage or test quality. (commit 849bd11)
- Reject legacy `test_share` and `bead_self_contained_test_share` target keys in both base and repository TOML before merging, including when the new key is also present. The error names the replacement and file; there is no alias or silently ignored override. Update external readers/configuration to the new names. Planning-convert continues to emit its existing `planning_score_bead_metrics.acceptance_share`, now read from the renamed score field.
- Add `sh scripts/e2e/planning-share-name.sh` for real public score/native-BR dry-run conversion and loud legacy-input refusal. The prose-only score deliberately retains `UNKNOWN` overall/exit 3 without a CI receipt. Base-config cases exercise the real exported entry function because the CLI exposes no base-root override. Optional `stale-convert-guard` and `old-output-key` arguments apply in-memory test-only mutations; neither changes canonical source. No installed-fleet or test-execution claim follows from the presence metric.
- Add preservation-only native BR admission for a complete staged `.beads/issues.jsonl`: require the actual working export, two fresh read-only v2 reconciliation witnesses, exact scalar/relation state and retained original records, acceptance and comments. Reject changed, incomplete, corrupt or noncanonical subjects without exporting, importing or rewriting provenance.
- Extend `scripts/install-commit-msg-bead.sh` with opt-in `--native-preservation --native-br ABS --native-br-sha256 SHA --native-guard-sha256 SHA`. The separate pre-commit member executes digest-verified helper bytes and pins the native executable; existing hook chains remain intact. Installation does not retire a legacy consumer or qualify a production cutover.
- Preserve unknown attribution as `UNKNOWN`; snapshot equality never grants creation or grading authority. This is a point-in-time check, not a cross-process writer lock. Native BR/Git fixtures cover A–D, stale/native changes, forged authority, loss/corruption, actual installed normal commits, concurrent peer bytes and installed-artifact tampering.
- Scratch plan and apply expose row sizes, per-root and per-verdict totals, malformed-owner counts, and the same 72-hour unowned-active rule; apply results include the reaper receipt (commit 094f76f).
- The br shim refuses tracker writes under another agent's exclusive Agent Mail reservation and fails closed when identity or reservation state is unknown (commit f9293a6).
- The flywheel guard blocks finite Bash calls that disable the native deadline, requires readiness for named services, and rejects recognized finite suites disguised as services (commit 6e7d94c).

### Fixed

- An id-less commit can no longer reach a shared `main` through plumbing or `--no-verify`. `scripts/install-commit-msg-bead.sh` now also installs a `reference-transaction` guard. Git runs it for every update of `refs/heads/main`, however the update is made, and it refuses a new non-merge commit that is not already on origin and names no existing bead id. Merges, other refs, commits already on origin and repos without a tracker pass. The installer live-probes the guard and rolls back if it would let `main` move to a planted id-less commit, and `--check` reports the guard when missing or stale. On 2026-10-16 five id-less commits held fourteen others off origin. [test] (commit 6bd6219)
- Installing the bead hooks is now safe in repos whose existing history carries id-less commits. A full install refuses (exit 5) before changing anything when the unpublished range already holds them, because the pushed-range member would block every push; `--no-pushed-beads` installs the forward-only set (commit-msg, the ref guard and the shared-main push member) instead. A rollback now restores any hook it overwrote instead of deleting it. Chain runners replay stdin to every member, so a repo's own `reference-transaction` hook and the guard both see each update. [test]
- `scripts/check-pushed-beads.sh --repo DIR` judges commits against that repo's own tracker. Run from another directory, it used to find no tracker and pass every commit. [test]
- The bead-id check no longer refuses a commit whose real bead id sorts late in a long message. It looks up `Bead:` trailer values first, then ids with the repo's own `issue_prefix` (from the tracker's `config.yaml`), then known fleet prefixes and bead-shaped tokens, so the 20-lookup cap never drops a real id; unknown ids are still refused. Every tracker read is now read-only (`--no-auto-import --no-auto-flush`). [test]
- Run the complete scheduled scratch reaper in an owned, keeper-bound child process group so synchronous inspection cannot defeat its deadline. Timeout and cancellation report the interrupted action, write a terminal receipt, stop the owned child, and release single-flight (commit a43df46).
- Preserve manual scratch-apply BUSY reporting (exit 4 with the scheduled holder PID) and reject invalid quarantine TTL configuration instead of ignoring it; supported TTL values remain 1 to 168 hours, default 24.
- Add pressure-classification helpers for WARN at 25% or less and RECLAIM at 20% or less. Scheduled pressure-trigger wiring, installed execution, and capacity recovery remain unqualified.
- `omp-kit heavy` no longer treats a missing disk observer as disk pressure. When `sbh` cannot run or answers outside its contract, heavy now fails within a second with exit 69 and names sbh, instead of waiting out the queue budget (900 s by default) and deferring with 75. Real pressure still queues and defers with 75, and the disk check is never skipped. CI now installs a pinned, checksum-verified sbh before every job that reaches `heavy` (CLI contracts, the ladder and OMP certification), so the ladder's harness gate runs again. [test] (commit d3dc99d)
- The pre-push fresh gate no longer counts the wait on suites that time out and defer to CI against its 180 s budget, so a large unpublished range can publish; the gate prints `deferred=` and `judged=` seconds (commit 2258e02).
- MCP acceptance checks support Tern's standalone OMP layout and reuse the installed version's verified SDK cache under isolated HOME, without downloading a new SDK for each fixture.
- Scratch failure-reporting checks isolate descriptor and process-census inputs while retaining real filesystem permission failures, so acceptance cannot signal unrelated host processes or depend on host-wide descriptor discovery.
- A commit whose staged TypeScript files import a path that is neither staged nor committed is now refused at commit time, not first at push. `scripts/install-commit-msg-bead.sh` installs a `pre-commit` member (`scripts/check-staged-imports.sh`) that writes the staged index, including the temporary index of `git commit --only`, as an unreferenced probe commit and runs `scripts/check-commit-imports.sh` over it; no ref moves. `--check` reports the member when missing or stale. On 2026-10-16 such commits passed every commit hook twice and forced history repairs.
- A commit that touches shipped paths (`src/`, `rules/`, `scripts/`, `extensions/`, `installer/`) without one `Bead: <id>` trailer whose `changelog.d/<slug>.md` or `changelog.d/<id>.md` fragment is staged or committed, and without one `[no-changelog] <reason>` line, is now refused at commit time, not first at push. `scripts/install-commit-msg-bead.sh` installs a `commit-msg` member (`scripts/check-commit-notes.sh`) applying the push notes gate's rule to the staged tree, including `git commit --only`; `--check` reports it when missing or stale. On 2026-10-16 nine commits naming their bead only in the subject passed every commit hook and were refused hours later at push.
- A commit whose staged `changelog.d` fragments the release train cannot fold (unknown category, more than one category header), or whose staged JS/TS/Python files fail the regexploit gate (including a TS import attribute regexploit cannot parse), is now refused at commit time, not first at push. `scripts/install-commit-msg-bead.sh` installs two `pre-commit` members, `scripts/check-staged-fragments.sh` and `scripts/check-staged-regexploit.sh`, that run the repo's own `scripts/release-notes.sh fold` and `scripts/regexploit-gate.py` over an unreferenced probe commit of the staged tree (including `git commit --only`); a repo without those validators passes. `--check` reports either member when missing or stale. On 2026-10-16 dead2a62b9 passed every commit hook and was refused only at push.
- Keep tool-call corpus parity checks self-contained by comparing against the matching checkout's corpus producer instead of requiring an unrelated or missing global kit installation.
- Keep human-gate, owner-decision and process work out of product-worker pulls even when optional filters are omitted; retain current native refusal evidence while eligible work continues past stale rankings (commit 5a65805).
- Guard native claims against conflicting holders and unreadable lookup state, preserve same-holder claims, and distinguish native actor selection from recorded agent-name attribution.
- Keep readiness and ownership probes read-only, rank the explicit JSONL export, and retain structured Fleet Watch warnings without treating a notice as delivery proof.
- `omp-kit heavy` admits on disk as well as load and slots: when `sbh check --need 10G` reports pressure, jobs queue with a `disk low` reason instead of adding scratch; an unrunnable sbh refuses explicitly. `heavy status` shows the disk reason. (ompkit-fp72.52)
- `omp-kit doctor --scope github` no longer prints the first characters of a GitHub token: the credential fingerprint is now the first 16 hex characters of the token's SHA-256 digest (commit be800ef).
- `scripts/close-guard.sh` now refuses a close or grade by any earlier implementer of the bead, not only the current assignee or the first `Agent:` trailer. Every commit that names the bead id as an exact token is checked, and any `Agent:` trailer equal to the caller (case-insensitive, trimmed) refuses with that commit's sha. The id match is fixed-string and token-bounded, so a commit for `X.112` no longer counts as a commit for `X.1`. [test]
- The guard also re-reads the bead just before deciding and refuses (exit 4) when its `assignee` or `updated_at` changed since the first read, so a claim that moves mid-check is never judged on stale data. [test]
- Land resolves the owner from a native Tern pane via `TERN_PANE` to `tern:<id>` with existing Agent Mail pane resolution when no `TMUX_PANE` is present; tmux keeps precedence, and a Herdr caller (`HERDR_PANE_ID`) is refused instead of borrowing an outer key (ompkit-kdbz.1.2.1). A missing, malformed, or unregistered pane key is refused as `OWNER_UNKNOWN` before any Git effects, with all lease, base, consent, and no-force guards unchanged. (commit cb4fbaf)
- Tern observer parses native OMP v3 tool-result records (`message.role toolResult` with `message.toolCallId` and `message.details.async`) and keeps real metadata records (model_change, custom, thinking_level_change, credential_pin, title_change) in the parent chain instead of refusing the journal. (ompkit-kdbz.2.12)
- Preserve chunked protocol payloads and reject nonfinite decoded JSON; permit native EffectCx calls in lens callbacks.
- Report stale or missing CI cache rows as UNAVAILABLE instead of OK, retain last-check freshness separately from fetched content, and return a nonzero CLI status when current CI status is unavailable (commit 140e3ce).
- Bind scratch cleanup candidates, quarantine moves, and immediate-reap final checks to their repository; retain private runtime-work cleanup only when its owner matches the executing kit's release identity.
- Planning conversion scopes native identities and parent epics to the selected mission, supports preflighted explicit local parents for new items, refuses explicit parents with open native blockers, rejects conflicting amendment identities, and preserves existing target contracts on reapply.
- Applying a plan now requires `--actor ACTOR` for explicit native audit attribution and always disables native auto-import and JSONL auto-export; the actor flag does not verify pane identity or bypass native policy.
- Hosted planning scores now require `ci.required_workflow` (a workflow ID or YAML filename/path) and a successful latest attempt at the exact configured local branch head. Unrelated workflows and historical greens no longer pass; missing identity, unpublished heads and pending runs remain UNKNOWN. JSON evidence includes workflow ID/path, run ID, attempt and head SHA.
- Mission anchors recognize numbered headings such as `## 0. Mission (approved by Joshua, 2026-10-04)` without changing approval, wording, or check-registration requirements.
- `proveSend` refuses a destructive payload addressed to a shell pane at send time (`ADMISSION_REFUSED` naming `send-payload-tmux-kill-server`, `send-payload-pattern-kill` or `send-payload-rmrf-critical`): the target pane's `pane_current_command` is checked only when the cheap local payload match hits, so benign sends cost zero extra tmux calls. The same text to an agent pane is prose and still passes. (ompkit-send-payload-gate-6hk3)
- The live-scenario mock model launches under a real `bun` when one resolves (`BUN_BE_BUN=1`), instead of `process.execPath`, which is the compiled binary in a release and answers `UNKNOWN_COMMAND` instead of serving. (ompkit-ssfx)
- `release-train.sh wait-release-idle` counts in-progress and queued release runs with two separate `gh` queries and sums them (`gh` keeps only the last `--status`); the pre-push gate runs `release-train.test.sh` alongside the checker contracts. (ompkit-v66l.2)
- The publishability scan no longer prints what it finds (ompkit-rc-epic-land-fix-release-dogfood-rz5.106.7). It reported each finding with the whole matching line, so a planted or real token, or a user's home path, went into CI logs (public for this repo) and into the pre-push `gate.log`. It now prints only `class: file:line`. Binary tracked files are scanned instead of skipped, and a missing or unreadable tracked file ends the run incomplete instead of a silent skip.
- A push can no longer move a remote `main` to a commit that is not on the repo's shared local `main`. `scripts/install-commit-msg-bead.sh` now always installs the pre-push member `30-omp-kit-on-main` (`scripts/check-pushed-on-main.sh`). It refuses (exit 4, naming the sha) a push to `refs/heads/main` whose commit is not `main` or an ancestor of it, a deletion of the remote `main`, and any push to it from a repo with no local `main`; pushes to other refs pass. It judges only where the push goes, never old commit messages, so `--no-pushed-beads` (formerly `--no-pre-push`) keeps it. The installer live-probes it and rolls back if it would pass an off-main commit; `--check` reports it when missing or stale. Private-index candidates pushed as `<sha>:refs/heads/main` split fleet repos into two histories: 0 of 149 publishes succeeded in 48 h, and zestroku's origin `1818d71` left out a test helper and turned CI red. [test]
- The session-stop save guard no longer orders a private-index candidate and no longer counts a recorded candidate as saved. A path that also holds another session's hunks counts as saved only once origin's `main` carries this session's patch; until then the prompt says to message that path's holder. Plain paths are told to `git commit --only` on `main` and `git push origin main`, or `git_converge.py --push` when origin moved. The rules `kit-no-shared-merge` and `kit-skill-forbidden-instruction`, `AGENTS.md` and `CONTRIBUTING.md` teach the same single-history save. [test]
- Fleet guard refuses unscoped `git commit --amend` before any refs/index/worktree change in all wrapper forms (`-C`, `-c`, env assignments, compound commands); explicit `--only` is not history-rewrite authority. Ordinary scoped commits, `--no-amend`, quoted prose, and `--` paths still pass. (ompkit-xa5s.25)

## [0.2.39] - 2026-10-15

### Changed

- Recognize declared local candidates for cleanly attributed dirty or unpushed work without requesting another save; undeclared work and edits made after the candidate still require saving.

## [0.2.38] - 2026-10-15

### Added

- Added `omp-kit align --repo DIR (--dry-run | --apply --yes) [--preserve-only]`: aligns a shared checkout's local `main` and index to `origin/main` while holding git's own `.git/index.lock` for the whole operation. Local-only commits are pinned under `refs/preserve/<date>-<sha>` before main moves; every path that differs between HEAD and origin/main is classified ADOPT, UPDATE or STOP, and any STOP, staged change, held lock, or ref/index change since the snapshot refuses with a typed code. The new index is renamed over `.git/index` only after a final re-check, main moves by compare-and-swap (the snapshot index is restored if it fails), child git processes never inherit `GIT_*` selectors, and a receipt is appended to `.git/omp-kit-align.jsonl`. The shared-checkout rule now points at it instead of a hand-run reset.

### Changed

- Reverted the scratch pressure reaping change (RECLAIM1, 2638ee8d) after it failed two Linux CI tests; it returns as a Linux-proven change.
- Drain close-queue and stale-claims accept --project DIR to read the tracker from DIR/.beads/beads.db (refused with --db).

### Fixed

- Fleet restart copies held scratch out of reaper roots and pins each dirty repo on `refs/preserve/fleet-restart/` before any send. A preserve failure refuses the run. The shared index and worktree are not moved. [test]
- Fleet restart never respawns a pane while a git process runs under it: panes with a running git child are deferred with reason to the next pass instead of risking a holder-less index.lock.

## [0.2.37] - 2026-10-13

### Changed

- Fixed heavy CLI test fixtures to pin OMP_KIT_HEAVY_FAKE_LOAD1 so slot-admission assertions remain deterministic under high runner load.

## [0.2.36] - 2026-10-13

### Changed

- `omp-kit heavy` bypasses only machine LOAD1 admission for GitHub Actions jobs; local CI=1 remains load-limited and slot admission is unchanged.
- Regex-budget judges each case by the median of five round-robin samples. Reports pair per-sample timings with runner load1; machine load no longer blocks timing stages.

### Fixed

- The pre-push gate and kit tests no longer inherit GIT_DIR/GIT_WORK_TREE or write fixture identity into the real repo config.

## [0.2.35] - 2026-10-13

### Added

- Added `omp-kit land --paths PATH --message MSG --apply --yes`: owner-bound publication of exactly actively reserved files from fresh `origin/main` through a private Git index and ordinary non-force push, leaving the shared index, local HEAD, and worktree unchanged.

## [0.2.34] - 2026-10-13

### Changed

- Native full-test receipts retain per-stage durations when markers are available; missing or malformed timing telemetry is recorded separately without refusing a passing full proof. Existing receipts remain accepted.

## [0.2.33] - 2026-10-13

### Changed

- `omp-kit update --reconcile` derives the install prefix from the receipt when no explicit prefix is supplied, so a stuck older binary cannot point reconciliation at the wrong install. (ompkit-3isy.1)
- Native certification reports preserve timeout output and identify the in-flight full-test stage and elapsed time when progress markers are available.
- `omp-kit scratch index-lock --repo DIR` reports a stale holder-less empty `.git/index.lock`, or moves it aside with `--apply --yes`; it never touches non-empty, young, held, or unknown locks. (ompkit-rz5.101)
- The flywheel guard now parses shell redirections as redirections, so a close command followed by `2>` no longer mistakes the operator token for a bead id and skips the self-close lookup. (ompkit-xa5s.8)

### Fixed

- A refused push now keeps the reason for every red step, not only the final gate (ompkit-fp72.40). The hook's whole body, from the archive extract through each checker contract, the pushed-bead and import checks, doc-drift and fresh-gate, streams to the terminal and to `gate.log` in its `var/agent-tmp/pre-push-gate.<pid>.*` dir; on any red the hook keeps that log and `.owner` with its exit code, and a green gate leaves nothing.
- Oracle hermetic case root: native worker and harness resolve corpus-relative paths against a synthetic root unless OMP_KIT_CASE_CWD overrides, so archive extracts stop disagreeing with the canonical checkout.
- Cut rule streaming cost for the CI judge: bounded the `omp`-to-`config` word gap in kit-settings-mutation and anchored kit-no-plaintext-secret on its credential noun, cutting the live-stream total by a quarter with no verdict change.
- The release train advances past existing CHANGELOG sections and rejects invalid fragment categories before promotion.
- Release train certifies the bump inline: the train calls CI on the bump SHA in its own run and tags only when every native receipt records that SHA, so a token-pushed bump no longer waits for a push run that never starts.
- Fleet guard drops cached reservation lookups when a release call passes through (MCP tool or `am file_reservations release` parsed source-aware, so quoted mentions never clear), so an edit right after releasing re-queries instead of seeing a stale allow.
- The publishability scan no longer prints what it finds (ompkit-rc-epic-land-fix-release-dogfood-rz5.106.7). It reported each finding with the whole matching line, so a planted or real token, or a user's home path, went into CI logs (public for this repo) and into the pre-push `gate.log`. It now prints only `class: file:line`. Binary tracked files are scanned instead of skipped, and an unreadable tracked file is a finding instead of a silent skip.

## [0.2.32] - 2026-10-12

### Added

- RX1 gate absolute single-check ceiling: a single 16k near-miss check may not exceed 50ms (a tenth of the 500ms stream budget), so flat-catastrophic patterns fail naming the rule even when their growth ratio looks innocent.
- Release train stage 2 (tag-after-green): the bump commit lands untagged with a pending ref, and only its own green push run creates the tag on that exact SHA before the candidate dispatches.

### Changed

- `BUN_BE_BUN` is removed from both the OMP launcher-version probe and nested OMP CLI children, preventing Bun's embedded-kit mode from misrouting `omp ttsr` on macOS. Unexpected policy-plan failures also retain their cause code and a bounded message excerpt.
- Native certification reaps each check's process group (session-scoped spawn with TERM/KILL on timeout and stray cleanup on exit), and `scripts/e2e-live.sh` reaps the omp session group after every scenario: a `test --full` timeout no longer strands writers under the work tree, so teardown reports the true timeout instead of `[Errno 66] Directory not empty`. (ompkit-fp72.48)
- `omp-kit fleet respawn` reports panes running a stale plugin (omp started before the latest applied relink) and, with explicit `--panes` plus `--apply --yes`, respawns named idle panes with `--resume`, strictly serially with same-session verification; busy, frozen, dirty, reservation-holding and sessionless panes are reported, never touched.

### Fixed

- The pre-push gate no longer leaks its archive extracts into `var/agent-tmp` (ompkit-fp72.40). Its last step ran under `exec`, which replaced the shell holding the cleanup trap, so every push left one or two full source extracts behind (196 dirs, 6.1 GiB measured on 2026-10-12); it now runs as a child and exits with its status. Cleanup also removes symlinks and other non-directories, so a fixture link inside an extract no longer keeps its parent tree alive. Each extract sits in a dir named with the gate's pid and an `.owner` file, so a gate killed outright leaves a dir that `omp-kit scratch` reaps as soon as that pid is dead.
- RX1 literal probe no longer demands a content literal for exact vacuous `(?s).+` conditions scoped to tool write/edit: such a pattern matches everything in O(n), so a prefilter literal can never reject anything.
- Fleet-watch `UNKNOWN` (ready rows unreadable) now names the probe cause: `runJson` returns a typed failure (`timeout` after N ms, `maxBuffer` N bytes exceeded, `exit` N with the first stderr line, `signal`, `non-JSON output`, spawn error, each with status/signal/elapsed ms) instead of swallowing it into `undefined`, and the `bv --robot-triage` probe reports elapsed ms, status, signal and stderr head. The UNKNOWN notice and its `fleet-watch.jsonl` record carry the cause. Timeouts, IO priority and fail-closed behavior are unchanged; `br ready` probes use an explicit 16 MiB buffer.
- Fleet-watch never offers parked workflow states for grading: `deferred` and `blocked` are excluded from review statuses even when the policy lets them close, so a deferred bead is not pulled for verification while `in_review` work still is.

## [0.2.31] - 2026-10-12

### Added

- `omp-kit drain close-queue --db PATH --repo DIR [--json]`: lists open beads named by a landing commit with no grader verdict since (landing SHA cited); `drain stale-claims --db PATH [--json]` flags in-progress beads with no worker or no recent evidence, each with its reclaim command. Both read the tracker read-only and are repo-scoped; `doctor --scope beads` gains the stale-claim finding.

### Changed

- `omp-kit send` verifies delivery against the pane it typed into: SESSION+PANE resolves once to a global pane id (already-global or qualified targets pass through; failed resolution falls back to the qualified form) and every capture/Enter uses it, so an index target in another session can no longer report NOT_DELIVERED while its text sits in the real composer.

## [0.2.30] - 2026-10-12

### Changed

- `omp-kit send` empty-composer admission reads only to the next separator line: an idle pane's separator and status footer no longer count as draft text, so admission passes on truly empty composers (previously it waited out the whole bound on every idle pane).

## [0.2.29] - 2026-10-12

### Added

- `omp-kit mission anchor [--project PATH]... [--json]`: per-repo mission-anchor status for a fleet. The live-doc Mission statement (heading plus approval marker in the toml-declared doc, else ROADMAP.md/MISSION.md) is the human source of truth for wording; `.omp/mission.toml` is the machine record. Reports AGREE only when the doc statement, its approval, a VALID record, and the recorded identity wording all line up; any disagreement (missing doc, missing heading/approval, non-VALID record, wording drift) is DRIFT with named reasons (exit 0 all AGREE, 1 otherwise).

### Changed

- `omp-kit send` serializes concurrent sends to one pane (per-destination lock file, stale-holder steal by pid liveness) and refuses to type into a non-empty composer (empty-composer admission with bounded wait, then UNDELIVERED): three concurrent sends plus a human draft arrive as three ordered submissions with independent marker acks, and `sweepUnsentMarkers` reports composer-region markers while ignoring scrollback.

## [0.2.28] - 2026-10-12

### Changed

- Bound plugin apply receipts and operator snapshots to the OMP package link, installed-plugin registry, and lock; undo restores registry bytes and ignores unrelated cache trees.

### Fixed

- Fleet Watch no longer parks idle workers with NO_TRIAGE_PICK when bv's top-N recommendations hold no focus leaf but `br ready` does: it falls through to the first claimable focus ready leaf, naming the reason `bv top-N has no focus leaf` (ompkit-fp72.28).

## [0.2.27] - 2026-10-12

### Changed

- Fix kit updates to relink the OMP plugin across covered profiles with a reversible per-profile receipt, and make doctor fail on stale plugin targets.

## [0.2.26] - 2026-10-12

### Changed

- `omp-kit send` completes busy-pane delivery: with `--until-delivered <seconds>` (default 300 s for dispatches), a message left sitting in a busy composer is submitted once the pane idles while it still holds exactly this message, verified gone afterward; foreign text, never-idling panes, and timeouts report UNDELIVERED with no stray Enter.
- Fleet Watch: a worker `BLOCKED` reply counts only with researched evidence: `cmd=` (exact failing command and output), `tried=` (two or more approaches and their results), `fix=` (the researched unblock with its source) and `next=` (the item pulled meanwhile). The old `BLOCKED <bead> <class> <route>` line no longer parses as a reply, and every pull and grading nudge states the bar and that the director rejects a BLOCKED missing a field (Josh, 2026-10-12; ompkit-fp72.27).

## [0.2.25] - 2026-10-12

### Added

- `skills/fleet-round`: `fleet-round.ts barrier` reports, per project, whether its round report for the phase (INSIGHT, AGREE, SORT) arrived in Agent Mail thread `fleet-round-<N>` and was accepted by the validator (ACCEPTED, REJECTED with reasons, MISSING, LATE), and whether the barrier is OPEN, MET or MISSED against its deadline (exit 0 MET, 1 MISSED, 3 any source unavailable, never MET on unknown, 4 OPEN); it tracks consecutive misses in the private round dir and reports ESCALATE when a project hits the same blocker at two barriers, and ships a launchd template (not installed) that runs it every 10 minutes while a phase is open.
- `skills/fleet-round`: the lock-step fleet round protocol (phases, barriers, timeboxes, roles, lending) and a read-only validator that recomputes each director's round report from br, git, tmux, ps and Agent Mail identity files; rejects reports whose labeled lines and single `fleet-round.report/v1` JSON block disagree or whose claims differ from br; checks the round-0 pass bar (mission, pile, dag, frontier, focus) with UNKNOWN, never PASS, for an unobservable holder; samples 10% of the round's closes reproducibly; and scores predictions per prediction and per author.

### Changed

- The kit-update service relink now covers all profiles including default (`apply plugin --apply --profiles all --include-default`).
- Fleet Watch pull nudges (decisions Q20/Q22): an idle worker is sent one item. The order is the grading queue (a review-status bead or an unanswered `DONE` callback the worker did not author), then the rework queue (the original implementer goes first while its seat is live), then the first `bv --robot-triage` recommendation under the session's `focusEpics` that `br ready` confirms is a claimable leaf. `br ready` order is used only when bv or the DAG is unusable, and the nudge says so. Grading and rework now reach workers even when no execution leaf is ready. The nudge carries mission `file:line`, round/phase, focus epics, the close rule and both grading outcomes (`CLOSED` or `REWORK` with a gap comment). Reports go through `omp-kit send`, not `ntm send`, using the Q22 reply table that also parses bead comments. Empty queues park the seat (NO-WORK, one director notice) until any item becomes eligible. `phase: INSIGHT` or `pullEnabled: false` stops pull nudges. The new config fields `focusEpics`, `mission`, `round`, `phase` and `pullEnabled` are validated. `readyCommand` is now run to list ready rows. Director-notice episodes now persist across service runs.
- Fleet Watch nudges follow decision Q23, one escalation chain from worker to director to chief to Josh. Every worker reply, UNHEALTHY and BLOCKED owner-decision or live-action included, is rendered as an `omp-kit send` to the session's director pane and nowhere else, and the nudge text names no other route. A pane that cannot be captured (DEAD) is reported to the director.
- `resolveOmpIdentity` now resolves Tern-managed omp installs: a `versions/<V>` launcher corroborated by the manager `state.json` naming the same version plus a version-matching `omp-src` package (manifest and matcher source, no npm receipt needed). State/package version mismatches, missing state, and missing matcher source still refuse.
- Recovery honesty: a `PARTIAL` tick no longer claims automatic undo (it notifies the pending receipt id with the `omp-kit undo` command), and `update --reconcile` derives the install prefix when `--prefix` is omitted instead of passing it through as undefined.

### Fixed

- `skills/fleet-round`: the report validator accepts `MISSION: PROPOSED` in round 0 with the drafted text in `mission_proposed`, as the round-0 plan allows, when the repo states no mission; it still rejects a draft after round 0, a draft without text, or a draft where the repo already states a mission.

## [0.2.24] - 2026-10-12

### Fixed

- kit-save-guard stays quiet for session paths whose content is already on origin: a local commit that landed upstream under a different sha, or a branch with no upstream configured (falls back to origin/HEAD, then origin/<branch>), no longer re-prompts "Unsaved session-owned work remains" every turn.
- kit-save-guard binds each `candidate <sha> for <paths>` clause to its own sha and paths, so a combined two-repository receipt clears each repository with its own object, and a candidate holding the path's exact current content counts as saved.

## [0.2.23] - 2026-10-12

### Changed

- OMP certification now reads OMP's release notes for every release since the certified one and lists each Breaking Changes, Removed and Changed entry against what the kit uses (settings keys, TTSR rule loading, the extension API, `omp --mode rpc` and slash commands, mnemopi memory, omp CLI flags; terms derived from the kit's code). A Breaking Changes or Removed entry that hits one blocks the merge until a review is recorded in `scripts/omp-certify-reviews.json`.
- Certification recreates a stale `omp-certify/<version>` branch from `main` instead of force-updating it, so it keeps working after workflow changes on `main`.

## [0.2.22] - 2026-10-11

### Added

- Release train: every green `main` commit is tagged as the next patch and released automatically, and the `kit-update` service installs published releases within minutes (`OMP_KIT_UPDATE_POLL=github`); a manual cut is still available as a fallback.
- New `kit-no-double-quoted-substitution` reminder: warns when a double-quoted argument to `br comments add`, `br create`, `br update` or `git commit -m` contains a backtick or `$(`.
- New `fleet-restart` skill: a repeatable fleet restart that runs as a dry-run plan by default and only sends after operator approval bound to the manifest hash. It refuses busy panes, mismatched launch flags and stale plugin links.
- `fleet-restart` sitrep: a parsed JSON fleet report covering pane state, bead counts, closes today, and a CI verdict over every workflow on `main`'s HEAD.
- `omp-kit doctor --scope secrets` reports Infisical vault values that appear in plaintext in config, rc, LaunchAgent and repo files without ever printing the value. `--staged` checks only the git index.
- `scripts/pre-commit-secret-scan.sh` pre-commit hook blocks a commit that stages a vault value.
- New `kit-no-plaintext-secret` rule interrupts a call that writes a literal credential into an rc, `.env`, config file or command line.
- `scripts/release-notes.sh fold`, `promote` and `notes`: drain fragments into `[Unreleased]`, cut a release section, and print a release body from `CHANGELOG.md`.
- `bun scripts/readme-check.ts` fails the pre-push gate and CI when README.md misses a registry command or doctor scope or pins a release version.

### Changed

- Release workflows reuse green CI and rehearsal evidence for the same commit instead of re-running the full candidate. The non-shipping Intel macOS probe runs in a separate workflow so it no longer delays publication.
- The `kit-update` service's launchd plist is re-rendered after every update, and the polling interval is now 300 s.
- The secret scan skips provider slugs and public client keys (`_ANON_KEY`, `_PUBLISHABLE_KEY`, `NEXT_PUBLIC_`, `EXPO_PUBLIC_`).
- Releases are `chore: bump version to X.Y.Z` commits that fold `changelog.d/` into `CHANGELOG.md` and set the package.json version, so the installed plugin reports the version it was tagged with; a green commit with no release notes is not released.
- Each GitHub release body is that release's `CHANGELOG.md` section; a release whose section is missing or empty is refused.
- `CHANGELOG.md` follows the upstream oh-my-pi format (`## [Unreleased]`, `## [X.Y.Z] - DATE`, Added/Changed/Fixed buckets).
- README.md resolves the latest release at install time instead of pinning a version, and its command reference lists every command and doctor scope.
- The pre-push doc-drift check accepts a README.md change as documentation for a new command or flag.

### Fixed

- `omp-kit update` and `omp-kit apply plugin` now relink a profile whose plugin symlink still points at an older release.
- `service run kit-update` accepts a poll-only config instead of refusing with `KIT_UPDATE_JOB_CONFIG`.
- Tern-managed (compiled) `omp` now works with `omp-kit test` and the pre-push gate: the kit fetches the matching OMP source version into a local cache (disable with `OMP_KIT_OMP_SRC_FETCH=0`).
- `fleet-restart` now detects panes running Tern's compiled `omp` as agents.
- The sitrep CI verdict now covers every workflow run on `main`'s HEAD instead of "the latest run", and its close counts are no longer always zero.
- Running `scripts/fresh-gate.sh` directly no longer reports false scratch-path fires.
- `kit-no-plaintext-secret` stays quiet when `echo` or `printf` only prints double-quoted text.
- `omp-kit doctor --scope memory` and native certification recognize the reviewed OMP 18.9.2 memory sources.
- The release train's wait for an idle release lane authenticates to GitHub.

## [0.2.20] - 2026-10-10

### Changed

- The pre-push gate now matches CI: it checks release-notes coverage for the pushed range and runs live-scenario coverage when rules change.
- `omp-kit send` sends slash commands verbatim with no appended marker, never presses Enter into them, and confirms delivery from the command's effect.

### Fixed

- `omp-kit send` accepts a known-prefix bead id in the D-line slug slot as the dispatch citation (Agent Mail ids never count).

## [0.2.19] - 2026-10-10

### Added

- `omp-kit update --reconcile RECEIPT --yes` rescans an install against a PARTIAL update receipt and marks it RECONCILED on a full match. `--prefix` overrides the install prefix.
- New `kit-ast-parsing-engineering` reminder for hand-written quote-aware scanners and tokenizers.

### Changed

- Fleet Watch nudges are suppressed when the tracker is write-latched, no claimable leaf exists or the state is unknown. Each suppression state (`WRITE_LATCHED`, `NO_FREE_LEAF`, `UNKNOWN`) is reported once per change.
- Tracker recovery acts only on fresh BusyRecovery markers and is rate-limited to one recovery per repo per hour.
- `omp-kit send`, fleet-watch and service runs check pause and custody state at the CLI entrypoint and refuse with no effects.

### Fixed

- `omp-kit send` no longer presses Enter into a busy pane: it waits for the receiver to pick up the message or reports `NOT_DELIVERED` with a recovery copy.
- `claude-save` refuses to commit when a Gitleaks scan times out, fails or produces no valid report, and reports `REFUSED` instead of `OK`.

## [0.2.18] - 2026-10-10

### Added

- Release rehearsal: `gh workflow run release.yml --ref main -f version=X.Y.Z -f rehearsal=true` runs the full pipeline on a throwaway version, with no tag, no release and no signing.
- Actuator admission: `omp-kit send`, fleet-watch, flush and tracker recovery refuse with no effects when the fleet is paused, off, protected, unconfirmed or on a stale generation.
- `omp-kit send --json` reports the resolved `tmux_socket`.

### Changed

- `omp-kit send` uses the only live tmux socket when `TMUX`/`TMUX_TMPDIR` are unset, and refuses with `TMUX_AMBIGUOUS` when several servers are live.
- `omp-kit send` refuses shaped bead ids it cannot trace to a known tracker instead of trusting them.
- Releases certify Intel macOS after the shipping targets are indexed, as a non-gating probe.

### Fixed

- Release attestation runs again: the SBOM step was updated off a retired GitHub artifact API.
- The `omp-kit update` postcheck no longer fails healthy machines when a newer release adds a ladder stage, or when the kit's own scheduled jobs write state during the check.
- Fleet Watch tracker recovery detects live tmux sessions on tmux 3.6.
- Fleet Watch tracker recovery treats a silent `lsof` exit 1 as "no database holder" instead of blocking.
- The scratch reaper recognizes `<label>.<pid>.<suffix>` directories and reaps them when their owning process is gone.

## [0.2.17] - 2026-10-10

### Added

- `omp-kit planning convert --apply --tracker-root DIR` writes a converted plan into an existing tracker after a full preflight.

### Changed

- `kit-save-guard` prescribes a private-index save, not a whole-file commit, when a file holds edits from outside this session.
- `omp-kit send` counts a bead citation only when its prefix belongs to a known tracker, so words like `follow-up` no longer satisfy the dispatch gate.

### Fixed

- `claude-save` no longer refuses every save after a committed `git mv` of an allowlisted gitlink.
- Release archives include the runtime test data and the flywheel-invariants gate, so installed integration tests run.
- `kit-save-guard` no longer asks a session to commit work that already matches the upstream branch.
- Fleet Watch now watches worker panes configured by tmux pane id (`%12`).
- `omp-kit test --full` and the update postcheck accept the `flywheel-invariants` ladder stage.
- The kit and the pre-push gate find OMP's source when `omp` on PATH is a compiled binary, without `OMP_SRC`.

## [0.2.16] - 2026-10-09

### Added

- `omp-kit send` refuses a work dispatch that cites no bead with `BEAD_REQUIRED`. `--no-bead-reason "<why>"` sends a recorded exception.
- `omp-kit doctor --scope fleet` reports `DIRECTOR_DOING_WORK` and `COMMUNICATION_PURGATORY`.
- `omp-kit doctor --scope fleet` reports `STUCK_PENDING`, `STALE_STEER` and `FROZEN_TURN` panes.
- `omp-kit fleet flush-pending [--apply --yes]` submits queued messages, but only in idle panes. A new `fleet-flush` service runs it every 60 s.
- New `kit-flywheel-guard` extension: it reminds agents to reread AGENTS.md and their bead after compaction, and blocks an agent from closing its own bead.
- New `kit-skill-forbidden-instruction` reminder flags skill files that teach worktrees, rebase, stash or a bare-word bead close.
- New `flywheel-invariants` ladder gate: every Flywheel Guide invariant and anti-pattern must map to a shipped mechanism with fire and quiet proof.
- `omp-kit doctor` lists stale tmux sockets without removing them.

### Changed

- Releases require all three shipping targets, and Intel macOS becomes a CI-only probe.

### Fixed

- `omp-kit apply plugin --regex-budget-report` accepts real reports with file-scoped conditions.
- Quoted git command text no longer triggers the shared-merge guard.
- `kit-skill-forbidden-instruction` matches commands continued with a trailing backslash.

## [0.2.15] - 2026-10-09

- Carried stranded companion work onto main (fleet-lessons, lessons, tracker-recovery, watch-actuator, shared-merge rule) with live coverage for kit-no-shared-merge. (PR #77)

- Squash-merged pull requests are covered by their matching PR changelog fragment; direct commits still need explicit coverage. (PR #79)

- Extension apply skips only profiles with existing unresolved imports (and reports the file, line and specifier), while healthy profiles continue; failed postchecks after a new extension name the profile and failing import step after rollback.

- Fleet Watch now persists per-pane idle-check counts, last decisions, and Steering deduplication state in a private atomic state file beside its JSONL log. Busy panes and capture failures reset the persisted idle history.

- x5iv.1: Fleet Watch detects BusyRecovery failure receipts, uses per-flag leases bound to PID/process start and tmux session identity, blocks live or uncertain holders, and logs then recovers stale zero-holder flags. Planted stale-proceeds, live-lease-blocks, and live database-descriptor fixtures run through the Fleet Watch tick.

- Added `omp-kit planning score` for per-mission or fleet scoring from git, beads, and CI evidence; packaged the planning skill and defaults, added repo-level overrides, and made `doctor --scope beads` flag acceptance criteria left in descriptions.
- Corrected health diagnostics to inspect the optional planning-skill row only in kit scope or when the packaged skill file exists; kept N+2 candidate fixtures aligned with packaged `config/` and `skills/` roots.
- Added `omp-kit planning convert --plan PATH --mission M --dry-run --db DIR [--json]` to translate fenced plan items into native beads in an isolated database, with parent/plan dependency edges, native lint and cycle results, WHAT-letter coverage, and planning-score metrics.
- Initialize the isolated native beads workspace with `br init` under its private `.beads/` directory before creating converted beads; this matches pinned br 0.7.4 behavior on Linux.

- SEND1 proven send (part 2): `omp-kit send SESSION PANE MESSAGE` wraps ntm with a marker poll (15 s), one retry and a state-root drop-folder fallback; the exit code is delivery (OK 0, NOT_DELIVERED 1), never the send call.
- SEND1 composer detection: recognize Claude `❯` input boundaries so submitted messages are not misreported as `PENDING_SUBMIT`.

Added 12 non-blocking kit teach rules for false alarms, negative outcomes, check-ins, fleet gaps, verified sends, acceptance criteria, planning protocol, named subagent models, shared skills, test TMPDIR, GitHub auth, and needless approvals. Each has fire/quiet case coverage and a live scenario.

- RT1 Homebrew formula source of truth: `packaging/homebrew/omp-kit.rb` pinned to the published v0.2.5 archives (per-platform URL+sha256 from release-index.json), with `brew test` on `--version`; CONTRIBUTING Releases gains the per-release refresh step (tap publication gated on the recorded owner). Local `brew audit/test` blocked: this machine's brew crashes in its vendored json gem (all commands); verification needs a healthy runner or the second Mac.
- Owner gate satisfied 2026-10-06: tap is `JYeswak/homebrew-tap` (`brew install JYeswak/tap/omp-kit`), recorded on the bead; tap repo creation is Josh's. README install section stages the brew line for that name.

- Add eight executable command-substitution fire cases across the Q3 rules, bringing the matcher corpus to 339 rows.

Added Mission Protocol v0.1 validation with canonical SHA-256 registrations, the `omp-kit mission validate` CLI command, and a learning check routed through `omp-kit heavy`.

## [0.2.14] - 2026-10-09

- Re-release of the 0.2.13 content below: the v0.2.13 tag's release-notes check counted its own release PR (#78) as uncovered, so its release workflow could not pass. (PR #77) (PR #78)

## [0.2.13] - 2026-10-09

- CI now tests OMP `minimum` and `certified` from `scripts/omp-compat.json` (certified 18.7.0) and never npm latest, so an OMP release can no longer turn `main` red. The hourly `omp-certify.yml` (replaces `omp-latest.yml`) certifies each new npm latest through one PR: it hashes and diffs the pinned memory sources, gets a model verdict on each changed file, runs the full `ci.yml` on the candidate commit, and auto-merges only when everything passed and no memory semantics changed. (PR #67)

- Memory readiness and the private memory audit recognize the reviewed OMP 18.8.0-18.8.6 source hashes (two `config/settings.ts` fingerprints, two pi-mnemopi audit tuples), so `doctor memory` on current OMP reports on-disk OFF instead of UNVERIFIED and native certification on OMP latest no longer refuses; any other changed source byte still refuses. (PR #65)

- `planning score` counts `plan(<mission>): review round N [level]` commits: one trailing commit-msg verification-level tag is stripped before matching, so hook-compliant review commits are no longer scored as zero rounds. (PR #64)

- GH3: warn on long-running GitHub Actions run polling; use the shared cached `ci status` path instead. (PR #66)

- Main CI and native certification install OMP 18.8.6, certified by omp-certify. (PR #68)

- COMMIT1's pre-push bead check now validates commits reachable from the pushed tip but not from `origin/*`, so already-landed main commits do not cause false refusals after squash merges; new bead-less commits still refuse. (PR #75)

- OMP certification now requires two independent agent reviews from different model families for changed pinned-source tuples; unqualified or failed candidates receive an `agent-fix` issue. (PR #74)

- Added a session-stop save guard that attributes successful `write`, `edit`, and applied `ast_edit` paths to the current session. It blocks twice for owned dirty paths or session-owned unpushed commits, then emits one warning; foreign dirty, ignored, and `var/agent-tmp/` paths stay silent, with `session_shutdown` retained as a backstop. (PR #76)

- The pre-push fresh gate no longer refuses a push range that deletes a test suite or shell script. Focused selection used `git diff --name-only`, which also lists deleted paths, so it ran `bun test` (or `shellcheck`) on a file that no longer existed and went RED. Deleted suites and shell files are now reported as not run; suites that the range modified still run. (PR #71)

Add scratch-is-not-a-home to keep durable instructions and rerunnable artifacts out of var/agent-tmp; preserve throwaway output there.

RX1 permits the exact `[\s\S]` all-character condition only for literal-discriminated `tool:write`/`tool:edit` scopes below `var/agent-tmp`. It remains measured for near-miss cost, and file-only scopes do not count against the Bash stream budget; broad or unscoped match-any conditions remain rejected.
Bundled TTSR checks preserve the logical workspace root across isolated execution, preventing `var/agent-tmp` release-fixture paths from being mistaken for source scratch paths.

- `omp-kit send` no longer reports OK when the message sits unsubmitted in the recipient's input box: it presses Enter once and reports OK only when the marker appears above the box, otherwise `PENDING_SUBMIT`. (commit b3cda9a)

## [0.2.12] - 2026-10-07

- SBOM attestation separates the platform-specific workflow artifact name from the local SPDX JSON path consumed by attest-sbom; the proof-derived matrix rejects unapproved platform identities while preserving the certified subset.

## [0.2.11] - 2026-10-07

- Release attestation derives its matrix from candidate-proof certified_platforms, validates source/version/index membership, and uses the verified actions/download-artifact v4.3.0 pin. It preserves the existing certified subset and does not enable excluded Intel platforms.
- Publishability fixtures construct planted credential, home-path, private-IP, and LAN-host values at runtime; the shared DSR template omits dispatcher-local absolute local_path and documents its registration requirement.

## [0.2.10] - 2026-10-07

- COMMIT1 bead lookup prioritizes recognized tracker-shaped tokens before the 20 local `br show` lookup cap; a 36-token long-message regression proves a resolvable id past position 20 passes while unknown ids remain refused (14/14 contract cases).
<!-- release coverage: (commit 4401ad2) -->

- COMMIT1 bead-id hook: `scripts/commit-msg-bead.sh` refuses commits naming no tracker-existing bead id (full `ompkit-<id>` or `rz5.<n>`, merge/template exempt, trackerless repos skipped), installed via `scripts/install-commit-msg-bead.sh` into the hooks chain; 7/7 contract tests with stubbed br plus live real-tracker proof.
- COMMIT1 installer takes an optional repo argument, absolutizes relative hooks paths, and refuses non-repos; cfsios installed and verified live per-tracker (foreign ids refused).
- COMMIT1 redesign: pre-push gate refuses id-less pushed commits (commit-tree included), the installer chains beside bespoke hooks, and ids resolve against the repo tracker (cfsios/uds shapes pass, versions don't).
- COMMIT1 chain hardening: the installer moves fail-closed bespoke wrappers with their sibling impls (`<type>-*`), keeps helper copies non-executable (chain runners only execute `NN-*` members, so helpers never run arg-less), and probes the whole chain before declaring success (bespoke-must-match-preflight, bead member must refuse an unresolvable id, pre-push member must pass an empty range), rolling every mutation back on any probe failure. Checker runs via `sh` throughout so non-executable helpers work. Planted: sibling preservation, path-sensitive move regression (refused + rolled back), pre-existing refusal preserved.
- COMMIT1 hook accepts any tracker-resolved id: the digit-shape prefilter is gone, existence comes from br show alone, so digit-less real ids (ompkit-kxdy) pass while made-up tokens are refused (12/12 contract tests, RED proven on the old filter).
- COMMIT1 installer gains `--check [REPO]`: names installed members that differ from the checkout source (exit 3), catching a stale installed hook after the source moves on (the NavyDuck digit-filter incident). Planted: fresh passes, older source names the stale member (22/22 contract tests, RED on the old installer).
<!-- release coverage: (commit 47abe2d) -->

- SAVE1 claude-save service: `src/claude-save-job.ts` commits admitted ~/.claude changes on main hourly and pushes origin main, with baselines snapshotted 2026-10-06 (5 gitlinks, main-only branches per amendment 3). Refuses: HEAD/upstream drift, worktrees, new branches/gitlinks, dirty denied files (left unstaged), gitleaks hits or missing scanner, SKILL.md outside skills/. No merge/rebase/force; non-FF push reported. Registered as `com.omp-kit.claude-save` (3600s) with `service run` wiring. Planted: every refusal on scratch repos only (15/15 `tests/cli/claude-save.test.ts`).
- SAVE1 amendment 3: branch baseline is main-only (all other ~/.claude branches deleted with approval); a re-created archived branch is refused as new (15/15 contract tests).
- SAVE1 staged-audit fix (NO-SHIP verdict): allowlisted gitlinks are never staged, and the index audit reads only gitlinks changed in the staged diff outside the allowlist — the old audit counted every tracked gitlink and could never commit. Planted: admitted edit with all 5 allowlisted gitlinks tracked commits; new gitlink refused; secret refused (16/16).
<!-- release coverage: (commit 2c4384c) -->
<!-- release coverage: (commit a9898c9) -->
<!-- release coverage: (commit aa61e78) -->

- bash-pipe-exit: condition 0 checks the echo/printf quote lookbehinds after the pipe-to-head/tail match, not before it, so near-miss cost stays flat (16K: 1958 ms to 0.14 ms) with fire/quiet cases unchanged (ompkit-ex6l).
<!-- release coverage: (commit 5334e9a) -->

- GH1 github doctor: `src/gh-doctor.ts` probes four read-only capabilities (issue_create_foreign, push_owned, workflow_dispatch, run_read) with GET-only fetches, rows shaped {capability, credential, status, missing_scope?, remedy?}; fine-grained default FAILs foreign issues with the classic-token remedy; `repairGithubHosts` rewrites hosts.yml from the Infisical fine-grained token and refuses classic. Planted: GET-only, workflow FAIL naming, classic remedy, classic refusal (10/10 `tests/cli/gh-doctor.test.ts`). Grammar wired; cli.ts dispatch queued.
- GH1 keyring credential: `resolveCredential` tries explicit token, `GH_TOKEN`/`GITHUB_TOKEN`, then `gh auth token` (source `gh keyring`), then hosts.yml — this machine's token lives in the macOS keyring, so hosts.yml alone resolved nothing. Planted: keyring-style setup passes with the secret never printed.
- GH1 expected failures: rows failing by design carry `expected:true` (fine-grained foreign-issue FAIL) and the overall derives from unexpected rows only, so consumers reading top-level status stop alarming. Planted: by-design FAIL + rest PASS gives OK; unexpected FAIL gives FAIL naming only it.
<!-- release coverage: (commit 82e00ba) -->
<!-- release coverage: (commit 5c7b9c7) -->
<!-- release coverage: (commit 2d2054a) -->
<!-- release coverage: (commit 970b78e) -->

- Regex budget gate wired in (RX1): `ladder.sh` runs `scripts/regex-budget.ts`, and the pre-push gate runs it when `rules/*.md` changes (refuses on RED); mission Proven check already points at it. Live rules currently fail it (near-miss, lint, stream budget) — rule fixes ride in RX2/RX5/RX6.
- RX1 load gate: the budget refuses to judge on a loud box (load1 above 1.5x cores) and reports INCONCLUSIVE (exit 75) instead of failing a correct push; the push gate defers to CI on 75. Planted contention proves the path; budget unit tests 8/8.
- Gate-scope for scratch refs: pushes to `refs/heads/scratch/*` skip ONLY the regex-budget judgment with `regex-budget: NOT JUDGED (scratch measurement ref; main pushes still judged)`; lint, checkers, and main pushes are fully judged (from TurquoiseCrane's brief, landed by PlumRaven under arbitration). Planted: scratch routing exports the skip, main does not, NOT JUDGED vs SKIPPED rendering.
<!-- release coverage: (commit 4654680) -->
<!-- release coverage: (commit 3dfd214) -->

- scratch service test pins quiet load; heaviest multi-spawn test gets an explicit 30s timeout.
- fast-test and integrations suites use a suite-owned TMPDIR they remove, with a planted check that a fixture cycle leaves session-omp-test unchanged in size.
- Flywheel close-verdict and lesson metrics now read br comment `text` with `body` fallback; the verdict proxy notes that it counts a VERDICT from any author.

<!-- release coverage: (commit d37ffb1) -->

- GH2: one shared CI poller (ETag/304, Retry-After, cache with fetched_at+source per row); `ci status` reads only the cache.
- GH2 red-main fix: localhost fixtures bypass the proxy (`NO_PROXY`/`no_proxy` gain 127.0.0.1 + localhost) — ubuntu runners carry proxy vars and Bun routes 127.0.0.1 through them, refusing instantly. Reproduced with a poison proxy (same 3 ERRORs), green with the bypass.
<!-- release coverage: (commit 41662be) -->

- The close guard refuses a close lacking a Lesson line or explicit `none`; tests cover refusal and accepted transitions.

<!-- release coverage: (commit 5d6dbf0) -->

- Memory readiness recognizes the reviewed OMP 18.7.0 config-source fingerprint; the installed-source suite reports the expected backend and store states instead of UNVERIFIED (11/11 tests).
<!-- release coverage: (commit 4401ad2) -->

- FLY2-3 dangling imports: the pre-push chain refuses commits importing files missing from their tree (planted commit refused naming sha+path; suite 3/3).
<!-- release coverage: (commit c80d337) -->

- RES1 hot-path TTL cap: fleet-guard refuses exclusive reservation/renewal over 30 min on paths in per-repo `.omp/hot-paths` (companion seeds `src/cli.ts`, `src/commands.ts`), naming cap and path; renewals capped the same. Planted: 147-min hot refused, 20-min hot passes, 147-min non-hot passes (8/8 `tests/cli/hot-cap.test.ts`).
- RES1 doctor lists hot over-cap holds: `auditReservationAge` takes an optional hot-path filter and `doctor --scope reservations` reads `.omp/hot-paths`, naming the holder (9/9 `tests/cli/hot-cap.test.ts` with the filter case).
- RES1 three bypasses closed (RED verdict): renewals via `extend_seconds`, the `macro_file_reservation_cycle` tool name, and glob paths intersecting hot files are all capped like direct reservations. Planted one negative each (12/12 `tests/cli/hot-cap.test.ts`).
<!-- release coverage: (commit 5c9cee7) -->
<!-- release coverage: (commit becdba5) -->
<!-- release coverage: (commit a3f92c2) -->
<!-- release coverage: (commit 3f2eb04) -->
<!-- release coverage: (commit fceddbe) -->

- `omp-kit doctor --scope work --project <path>` now scans only the selected repository, taking precedence over `--root`.
<!-- release coverage: (commit 4e6a112) -->

- RT1 installer verifies release origin: `verify_attestation()` in `installer/install.py` checks the release-published `<archive>.sigstore.json` bundle via `gh attestation verify --owner` (seams: `GH_BIN`, `OMP_KIT_ATTEST_OWNER`). A failing bundle refuses; a missing bundle warns hash-only so offline installs keep working. Planted: tampered archive refused, bad attestation refused, no-bundle warns and passes (4/4 `tests/cli/install-verify.test.sh`).
- RT1 release workflow attests every candidate: `release.yml` gains an `attest` matrix job (one per platform) that downloads the `candidate-<platform>` artifact, generates an SPDX SBOM (anchore/sbom-action), and records SLSA build-provenance plus SBOM attestations via GitHub OIDC (all actions SHA-pinned). Tag-dispatched only, like the rest of the workflow. The installer check is wired into CI (`install-verify.test.sh` in shellcheck and the ladder). Bundle publication alongside archives at promotion time remains a P25 step.

## [0.2.9] - 2026-10-06

- Commit index for 0.2.9: every shipped-path commit since v0.2.8 that had no fragment of its own, grouped by bead.

- ompkit-rc-epic-land-fix-release-dogfood-rz5.59.3: (commit 4130852)
- ompkit-ex6l: (commit 963b98a)
- ompkit-rc-epic-land-fix-release-dogfood-rz5.113: (commit 43137ba)

- RELEASE BLOCKER A3: the CI-judge signal passes `runIsolatedShell`. `CHILD_ENV_KEYS` in `src/runtime.ts` carries `GITHUB_ACTIONS` so the nested ladder keys `--judge-regardless-of-load` on macOS cert (keying on `CI=true` would break local fail-closed, since cert sets it always). Planted: `sanitizedEnv` contract test proves the signal survives and non-allowlisted keys stay scrubbed (RED on unfixed code).

- RT1 installer verifies release origin: `verify_attestation()` in `installer/install.py` checks the release-published `<archive>.sigstore.json` bundle via `gh attestation verify --owner` (seams: `GH_BIN`, `OMP_KIT_ATTEST_OWNER`). A failing bundle refuses; a missing bundle warns hash-only so offline installs keep working. Planted: tampered archive refused, bad attestation refused, no-bundle warns and passes (4/4 `tests/cli/install-verify.test.sh`).

## [0.2.8] - 2026-10-06

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

## [0.2.7] - 2026-10-06

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

## [0.2.6] - 2026-10-06

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

## [0.2.5] - 2026-10-04

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

## [0.2.3] - 2026-10-03

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

## [0.2.2] - 2026-10-02

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
## [0.2.1] - 2026-10-01

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

## [0.2.0] - 2026-10-01

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

## [0.1.1] - 2026-09-29

- The standalone installer now prevents its Python subprocesses from writing standard-library bytecode into a fresh macOS HOME. Offline and online dry runs, and a failed online archive download, leave the isolated HOME untouched; the real-archive regression also runs on native macOS CI.
- Rebuild and recertify all four native release targets against the exact tagged source. The `v0.1.0` assets remain immutable; upgrade only by explicitly choosing `v0.1.1`'s reviewed local index and archive.

## [0.1.0] - 2026-09-29

- First public source-only root for the compiled `omp-kit` companion. The original working repository and its prior history remain private; this root does not inherit those commits. The [MIT license](LICENSE) and [release assets](https://github.com/JYeswak/omp-kit-companion/releases/tag/v0.1.0) describe the published boundary.
- The CLI inspects OMP, checks 18 rules against 274 fire/quiet cases and streamed prefixes, runs isolated live/mock-model scenarios, previews guarded rule/policy/extension changes, records receipts, and offers read-only profile, LSP and MCP examples. Installed checks do not certify a user's effective profile.
- Versioned macOS and Linux arm64/x64 archives are distributed only for native-certified targets in the release index. The standalone installer checks the archive digest and internal file manifest before atomically selecting a versioned executable. Index hashes give integrity, **not** publisher authentication. OMP, models and profiles are never installed by implication.
- The kit-only updater requires an exact newer version and matching **local** index and archive. At initial publication no newer release existed; OMP updates remain external. A failed post-check leaves a pending recovery receipt rather than claiming rollback or GREEN.
- The README hero was graded on its [exact shipped JPEG](visual/hero-identity-grade.json) with the hash-locked Yuzu anchor and unchanged 70-point numeric formula: ChatGPT OAuth `gpt-5.6-luna` scored 80.9; independent xAI `grok-4.7` scored 79.5. The original `gpt-4o-mini` judge did **not** run; the receipt identifies the substitution.

This is the beginning of the public timeline, not a relabeling of the older private development history. See [NEGATIVE_EVIDENCE.md](NEGATIVE_EVIDENCE.md) for measured limits and refuted claims.
