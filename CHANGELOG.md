# Changelog

## [Unreleased]

<!-- New notes go in changelog.d/<bead>.md (optional first line `### Added|Changed|Fixed|Removed|Breaking Changes`); the release train folds them here. -->

## [0.2.112] - 2026-11-10

### Changed

- Mail wakes and holder liveness read Tern block ids exactly; ids above 2^53 were rounded to a neighbouring pane, so wakes to those seats went nowhere.
- The kit package loads again: the mail wake's exact Tern id reader ships with the extensions instead of reaching into source the package does not include.
- The commit gate now selects the package load gate suite when a staged change touches any extensions/*.ts source or the root package.json, so a shipped extension importing outside the package can no longer land untested.
- New `omp-kit skill-mine` mines every project's agent history (cass sessions and the live Agent Mail store) for recurring procedures worth packaging as skills, drops what an installed skill already covers, and writes a daily evidence pack (`<kit state>/skill-mine/pack-<date>.md`) with verbatim quotes and refs for an agent to judge; read-only unless `--apply` files SKILLCAND beads.
- Only procedures rank: multi-step sequences with distinct steps, shared verbatim text, error->fix arcs, corrections and mail teaching threads. Single commands, kit/tool verbs, dispatch prompts, advisor sidecar transcripts, harness render lines and injected reminders or skill files never do.
- `skill-mine status` reports the last run; a new daily `skill-mine` service job runs it once `skillMine` is set in `fleet-watch.json`.

## [0.2.111] - 2026-11-10

### Changed

- Kit updates no longer roll back a good release when the regex-budget timing gate reports the host was too slow to judge (reference ratio above clamp): the postcheck is recorded as deferred and the release stays active but unverified.
- Retrying a kit update after its postcheck compensated back to the prior release now reuses the undone candidate instead of refusing KIT_TARGET_EXISTS; any other existing release dir still refuses.
- `omp-kit doctor` no longer reports rch FAIL after a reboot or rchd restart: the socket baseline belongs to the daemon pid that bound it and is retaken for a new daemon.
- Scheduled service runs no longer refuse with SKIPPED-ADMISSION when the only other matching launcher belongs to a different HOME; a second launcher under the same HOME still refuses.
- Writing into a `var/agent-tmp/<dir>` that `omp-kit scratch new` did not create is refused with the exact `omp-kit scratch new --label ...` command to run, instead of an UNKNOWN read error.
- A hashline edit that OMP's edit engine itself rejects (for example a stale tag) inside owned scratch is no longer refused by the scratch guard as an unreadable payload; the edit tool reports its own error with the fix.
- Writes inside a private checkout of a repository (`ovnfs new`, or a shared clone with a separate git dir) no longer need an Agent Mail reservation: that copy has one writer. The canonical checkout still requires one.
- A seat can now release the scratch folder a finished task child created (`omp-kit scratch release`), so a dead child's leftover no longer blocks the parent's land publication; a live child's folder and other seats' folders stay refused.
- Build handbacks from repos without `scripts/commit-preflight.sh` (e.g. clutterfreespaces.ios) are no longer refused when they carry the kit's own `omp-kit preflight commit` clean line (`commit: ok (...)`); repos that ship the script still require its evidence, and verify-only handbacks naming no changed paths are admitted without preflight.
- Mined tool errors name six more causes instead of `tool-error:unclassified`: missing working directory, self-restart, Python unittest failures, status-only exits (`silent-exit`), corrupt or malformed patches, and harness argument validation.

## [0.2.110] - 2026-11-10

### Changed

- `omp-kit update --reconcile` now prunes old releases like a completed update: the active release, the five before it, pinned and running releases stay.
- New daily `cc-compress` service job: gzips the command center's sealed spool days (about 10x smaller) from the operator's `ccCompress` command in fleet-watch.json.
- The scratch tracked-source-copy refusal now names the working route: edit tracked source in a separate checkout of the repository (for example `ovnfs new --name <x>`), not a copy under scratch.
- The gate-events ledger names more tool failures instead of `tool-error:unclassified`: multi-line MCP transport failures, JS eval cells that threw, missing packages, aborted commands, a dead eval kernel and diff's exit 1 when inputs differ.
- Seats' send drops (`send-drop/`), write-ledger appends (`write-ledger/`) and upgrade notices (`upgrade-notice-*`) are live fleet state too.
- `omp-kit verify` reuses the open live-readback bead a failed earlier attempt left behind instead of being refused as a duplicate.

## [0.2.109] - 2026-11-10

### Changed

- A handoff also matches when the landed commit's message lost trailing blank lines that git strips at commit time.
- A release install's post-check no longer fails because other agents wrote the kit's live fleet records (gate events, mail wakes, inbox wakes, scratch user locks, update-job records) during the isolated test; those files are reported as live state, and every other file under the state folder is still checked.

## [0.2.108] - 2026-11-09

### Changed

- Release retention now runs after every successful activation (and after an undo restores the previous release), even when the post-check fails, so old releases and their download caches are pruned; the update job no longer writes a record every five minutes when nothing changed, and old upgrade notices and git-lock-rate files expire with the other operational receipts.
- Editing a file in your own scratch with a hashline edit is no longer refused as "content cannot be established": the guard computes the edit's resulting bytes with OMP's own edit engine and judges those.
- A task child whose spawn name Agent Mail does not know no longer gets WRITE_OWN_LOOKUP_UNAVAILABLE for a canonical write: it holds nothing, so the refusal is WRITE_OWN_UNRESERVED naming the seat that can reserve the path on its behalf.
- A `DONE <repo>@<sha>` handoff for a commit landed through `omp-kit land` is no longer refused: the empty pass the gate records after the complete one no longer hides it.
- A release install's post-check no longer fails on a large kit state folder: big state files are compared by size and modification time instead of being read, so an install can pass its post-check and then prune old releases.
- `omp-kit verify` can again close a bead that has a live check: the live-readback child it creates is no longer refused by the bead linter for lacking a planted negative, which the parent's own checks already ran.
- `omp-kit verify BEAD --live-readback` now also reads back an open bead whose every remaining check is a live check, so such beads can be closed; before, verify reported them pending forever.
- The README's install blocks pass the GitHub token only to the install commands instead of exporting it into the shell; the quick start uses the installed binary path throughout and says where `apply rules` writes; removal now includes uninstalling the OMP plugin, without which OMP keeps loading the kit.

## [0.2.107] - 2026-11-09

### Changed

- The scratch reaper deletes expired quarantine first, before scanning every scratch root, so a scan that runs out of time no longer stops quarantined scratch from ever being deleted.
- `omp-kit verify` now exports the commit under the project's own `var/agent-tmp`, so a check that reads git (tags, history) sees the project and gets the same verdict wherever the caller's `TMPDIR` points.
- `doctor --scope hooks` names a missing or stale hook member by its path under the hooks folder even when the repository is reached through a symlinked path (such as macOS `/tmp`).
- A commit that changes shared runtime, and is therefore admitted by its full-suite pass, can now record its `DONE <repo>@<sha>` handoff: the gate's run log marks that run's evidence complete and names the tree the full-suite pass covered.
- A `DONE <repo>@<sha>` handoff for a commit whose gate took longer than a second is no longer refused: the handoff check now ignores the author time as well as the committer time when it matches the landed commit to the commit the gate judged.
- A build child whose finished handback is refused for missing preflight evidence keeps its output: the refusal is placed before the child's result instead of replacing it, so no finished work is lost.
- A stale `index.lock` is no longer reported as held by a `git --no-optional-locks status` or `diff` that is merely reading the repository; saves and commits that were refused on such a reader now proceed.
- A push is no longer refused as "no existing bead id" when the tracker was only busy: the bead check retries a busy tracker once and, if it still cannot answer, says it was a tracker error rather than a missing bead.
- The README says that `RUN_ID` (for `undo` and `why`) is the `id` field of a receipt in `omp-kit audit --json`, and that the attestation check's `~/.cache/gh/.sigstore` cache belongs to `gh`, not omp-kit.

## [0.2.106] - 2026-11-09

### Changed

- The fleet pack no longer injects the 18 KB standing-law file into every turn; the operating contract lives in AGENTS.md and the standing decisions stay in the private decision log.
- Retire the pre-canonical commit-msg stamp pair (`10-commit-msg` plus its stale
  sibling impl) when installing hooks; the canonical `41-omp-kit-commit-msg-vlevel`
  member keeps enforcing the same rule with the same refusal text and code, so a
  stamp-less commit is now refused once instead of twice.
- Record the commit-time bead PASS verdict and reuse it at push and ref-update
  time: the commit-msg member writes a pending record, a new post-commit member
  copies it to a record keyed by the exact commit sha under
  `.git/omp-kit/bead-verdicts/`, and the pre-push and reference-transaction bead
  members admit recorded shas without re-running `br` per commit. Commits with no
  record (e.g. `commit-tree` plumbing that bypassed commit-msg) still take today's
  live `br` check and are refused at push.
- `br create` no longer refuses a bead as a possible duplicate of a bead it explicitly links with `--deps related:<id>`. `omp-kit verify` creates its LIVEREADBACK child with the parent's title and that link, so every verify close that deferred a `[live]` box was refused with ACT_FAILED.
- A FULL-plan refusal now teaches the exact recording command the same gate run accepts: the `full-suite-verdict.sh` under the judge root the run consulted, resolved to an absolute path. When the judge is an ephemeral pre-push/commit-gate archive that is removed after the run, the refusal instead prints the command that recreates it (`git archive` of the judged commit into a fresh dir, then that dir's verdict script). A PASS recorded under any other judge is still refused as before.
- The write-ownership guard no longer treats a fixture repository created inside owned scratch (its own `git init` beneath `var/agent-tmp/`) as a canonical checkout, so writes there are admitted without an Agent Mail reservation lookup.
- Writes to OMP-internal URLs (`out://`, `cfg://`, and kin) are no longer resolved as files under the canonical checkout, so they are admitted without a reservation lookup.
- The process-reap tests now wait for a load-scaled time, so a full test suite on a busy machine no longer fails them; a process that never dies is still caught.
- Kit hook refresh now covers every fleet-watch session repo that already has kit hook members installed, whatever its `pullEnabled`. `pullEnabled` only pauses work supply; it never meant the repo runs no kit hooks, so `pullEnabled: false` repos (omp-kit itself, companion, uds, localbench, zestroku) kept stale members and missed the affected-gate member entirely.
- The hook freshness census no longer keeps a hand-mirrored member list: `doctor --scope hooks` and the activation doctor read the active release's `scripts/install-commit-msg-bead.sh --check` output, so a member the installer gains (like the `42-omp-kit-affected-gate` member) is reported stale or missing with no code change here.
- A process started through the bounded runner can no longer outlive a caller that is killed just after starting it: the runner's parent-death reaper is now running before the child starts.
- `omp-kit doctor` no longer flags fleet-pack rules as unknown: an installed file whose name and bytes match a `MANIFEST.fleet.tsv` row is managed, while a fleet name with changed bytes (or no fleet row) stays DEGRADED naming the file.
- `omp-kit doctor --json` reports overall OK when the only non-OK rows are structural read-only limits (effective profile values, extension loading, policy recognition, the optional router, the mail guard, the unexercised matcher): those rows stay listed with their reasons but no longer set the overall. DEGRADED, DRIFT, FAIL, and UNVERIFIED rows with a remedy still drive the overall. A run in which every row is one of those structural limits proved nothing, so it reports UNVERIFIED, never OK.
- The kit planning skill gains the step 2b verb inventory (plus its coverage-check and what-not-to-do rows), so the kit copy is a superset of the local copy again; copy the release file over the local one after upgrading.
- The scratch-is-not-a-home guard no longer reads UNKNOWN under host load: each git read now gets the shared load-scaled bound (2 s at quiet load, up to 8 s pinned-high), the same factor land uses for its `am` calls, instead of a fixed 2 s deadline. A read that answers inside the scaled bound is judged; a read that never answers still refuses UNKNOWN naming the read.
- The README install blocks now export `GH_TOKEN` from `gh auth token` in the
  same shell before the installer runs: attestation refuses a logged-out `gh`
  as `KIT_ATTESTATION_BUNDLE_UNAVAILABLE` instead of installing.
- `apply mcp` now says the named source must already exist and points at
  `omp-kit doctor --scope mcp --sources` first; `apply plugin` shows a
  fresh-HOME `--store` value and says `--profiles` is required.
- The `repair --scope github` row is marked not supported (refused as
  `UNSUPPORTED_REPAIR_SCOPE`); `lsp setup` notes a stock brew OMP reports
  readiness against defaults only and full readiness needs a source-backed OMP.
- `service install` says it needs the stable launcher `$HOME/.local/bin/omp-kit`
  first and refuses as `LAUNCHER_UNAVAILABLE` without it; `rch lease` and
  `planning convert` name their native `rch`/`br` PATH prerequisites.
- `update` says to download the release index and archive side by side first;
  a missing `--index`/`--archive` file is now refused naming the path
  (`LOCAL_SOURCE_REQUIRED`) instead of as an unverified install.
- `corpus` notes `--sessions` must be an existing directory a fresh HOME does
  not have; `service install --apply` warns it bootstraps the real per-user
  launchd domain whatever `HOME` is; `service` notes it inspects the real
  launchd domain read-only even with a fresh HOME.
- `doctor --scope secrets` documents the `UNVERIFIED` cause when the
  infisical-helpers `lib.sh` is missing, and a new Removal section covers
  undo, service uninstall, prefix removal, and the state root.

## [0.2.105] - 2026-11-09

### Changed

- Test-only: the owned-job reap plants wait up to 1 s for each killed descendant to disappear instead of reading the process table once right after the call returns. Under heavy load the kernel had not yet torn down a process that had already been sent SIGKILL, so the check failed 61 ms later even though the process was being killed. The bound stays under the plant's own 3 s lifetime, so turning off group termination still fails the test.
- A native task child can again write a path its parent seat holds. Since 0.2.103, such a write was refused with WRITE_OWN_LOOKUP_UNAVAILABLE whenever the child's own name was not registered in Agent Mail, because the failed lookup for the child replaced the seat's cover.
- A commit whose selected tests had all already passed on the same tree is now admitted with `VERDICT REUSED`. Before, the commit gate removed the already-green tests, found nothing left to run, and refused with NO_AFFECTED_TESTS ("no test reaches it"), even though the changed code's own tests had just passed.
- CI-only: the full-suite remote-shard fixture now links the real bun into each fixture worker's own `.bun/bin`, the same place a real suite worker carries it. Before, a worker shell rebuilt `PATH` from its fixture `HOME`, so on a stock Linux runner `bun` was not on `PATH` and every remote shard ended without a verdict while this Mac's Homebrew `bun` masked the gap.
- CI-only: the no-adapter fallback case links bun into its own fixture `HOME` too, so a stock Linux runner finds `bun` there while `rch` stays absent.
- Repositories can declare affected Python selftests in `.omp-kit/affected-tests.json`. Installed push hooks run those tests on the exact pushed commit at reduced priority, including sibling `*_selftest.py` suites, and reuse the existing complete GREEN ledger for author handoff. Failed or untested code is refused; documentation-only pushes create no GREEN.
- The legacy-judge fixture patch tracks the declared ledger file, and the affected gate no longer mistakes the harness's exported `BEADS_DB` for caller authority, so reviewed pushes land instead of being refused.
- A seat with an active goal that goes idle now gets one wake every 30 minutes, so a lost mail, job result or verdict can no longer leave it idle until someone types. A paused goal, a seat without an agent name, a busy seat or a new turn gets no wake.
- A build task that lacks its repo's gate contract is no longer refused with BRIEF_CONTRACT_REFUSED: the fleet guard appends the current contract to the task's context and reports AUTO_COMPLETED. Only the 1 MB inspection limits still refuse.
- A task call whose shared context declares READ-ONLY (or analysis-only) at the start of a line needs no contract, unless the task itself has a Change section or reserves paths.
- `omp-kit brief` prints one row per topic (reservations, commit message, release notes, safety primitives, tests, ...) instead of one row per hook member: the companion's contract drops from 48 rows to 13, with no empty or "read and satisfy" rows.
- `omp-kit scratch apply` now restores owner write permission on its own expired quarantine entries before the idle proof, so entries holding unreadable test-fixture directories (000 modes) drain instead of being kept forever behind idle-proof-unavailable. Young, held and live entries are untouched.
- `omp-kit update --apply` now prunes old kit releases and poll directories the same way the update job does: the active release, the last five before it, any release pinned in `releases/.pinned` and the still-running release survive; older `releases/<v>` and `poll-<v>` directories are removed. A failed pruning reports FINDINGS, never a silent skip.
- A refused act now writes one gate-events row: the block is recorded under its gate name and the derived guard-friction class lives in the miners' outputs instead of a second row. Tool failures that used to land in tool-error:unclassified are now named (agent input mistakes, timeouts, validation and check answers, gate-shaped error text), so false refusals stay measurable.
- `omp-kit land --patch` now commits the reconstructed hunks on local main and publishes main itself, exactly like `land --paths`, so the installed shared-main pre-push member admits the push instead of refusing every patch publication.
- `omp-kit verify BEAD --export SHA` now admits `open` and `in_progress` beads as well as `in_review`: the non-author replay of every box on the exact export is the proof the handoff gate stands in for, so `in_review` stays a queue, never a precondition. Unticked boxes are ticked on `PASS`; the author's own run is still refused before replay and a failing box still leaves the bead unclosed with the `REWORK` comment.

## [0.2.104] - 2026-11-09

### Changed

- The fleet standing law (`kit-fleet-standing-law`) is back in the opt-in fleet rule pack, which `omp-kit apply rules --fleet` installs. It was removed in 0.2.99 before the contract that replaces it existed, and it stays until that contract lands. Every rule was first checked against the later decisions and the current code: 4 superseded rules were dropped (50 remain), outdated wording was updated, and each `mechanism=` now names the code that actually enforces the rule, or says `unenforced`.
- The fleet safety rules were replayed against 57,896 real tool calls before they went back on. The changes:
  - `kit-no-force-push` and `kit-scratch-tmp` are dropped. dcg and the fleet guard already block those actions.
  - `kit-no-pattern-kill` now also fires when a call names its intent before the command.
  - `kit-no-plaintext-secret` no longer fires on Infisical reference mappings such as `KEY:e.OTHER_KEY`, and it names `cf-secret run` as the fix.
  - `kit-no-shared-merge` no longer fires on a rebase inside a builder worktree.
  - `kit-no-live-tracker-sqlite` now covers eval, write and edit. Bash belongs to dcg.
  - The rmrf, skill-instruction and send-verify rules now describe the current scratch, worktree and Agent Mail paths.
- Every agent now wakes on its Agent Mail. A paused project (`fleet-watch` `pullEnabled: false`), a paused goal or unreadable fleet state no longer stores mail without waking its recipient: that rule had left 192 messages to the lead unwoken since 2026-11-04 behind the paused omp-test worker session. The `STOPPED_NOT_WOKEN` status and `arm_seat --override-pause` as a wake exception are gone.
- A repo listed in `fleet-watch.json` now gets the in-process mail wake without its own `.omp/fleet.json`; a repo whose `.omp/fleet.json` says `"enabled": false` stays off.
- The release notice now tells every seat to upgrade, including a seat whose goal is paused or whose project is stopped. Before, such a seat, the lead included, was told to stay paused and wait for a fleet restart, so it stayed on the old release. The self-restart keeps a paused goal paused, so upgrading never resumes paused work.

## [0.2.103] - 2026-11-09

### Changed

- A background task agent can now write files it reserved under its own Agent Mail name; a reservation its parent seat holds still covers it, so parallel builders no longer fail with WRITE_OWN_UNRESERVED.
- `commit-preflight --tests` exports now link each test's ancestor `node_modules` directories that exist in the checkout, as well as the root one, so a workspace package's test resolves that package's own dependencies the way it does in the checkout; a dependency the checkout lacks still fails the export test.
- `omp-kit slice-verify` no longer reports CLEAN when a selected test file fails without naming the failure. A run that exits non-zero or counts failures, but whose named `(fail)` lines do not cover its fail count, is reported as UNATTRIBUTED and introduced, because an unnamed failure cannot be proven pre-existing.
- The fleet upgrade notice matches the native restart helper: the helper holds its own tool call while omp's `/restart` replaces the process in place, even on a busy seat, so the seat no longer ends its turn; `RESTART_NOT_OBSERVED` means nothing restarted. On omp 18.18.1 or later, running background task agents keep working across the restart (J-2026-11-08-02); on older omp the seat still collects them first.
- On Linux, scratch directories made by processes with 7-digit pids are no longer rejected as having an invalid owner record, and the stale-worktree commit check reads file times correctly with GNU `stat`.
- A push that changes code under `src/` or `tests/` but no gate script now runs its affected tests once instead of twice. The pre-push gate still runs its first pass with the previous commit's gate scripts. When the pushed commit's gate scripts hash to the same judge on the same tree, the second pass reuses the first pass's passing files instead of running them again. A change to any gate script still runs both passes in full.
- Run the daily real-HOME install and upgrade regression on the latest stable published release and its greatest stable predecessor, authenticating both release indexes and fetching genuine archive provenance instead of building unsigned journey inputs.
- A seat that Tern restores without `AGENT_NAME` (for example after a Tern daemon restart) now takes its name from its own pane's Agent Mail identity file when the plugin loads, so its writes are no longer refused with WRITE_OWN_NO_IDENTITY and no respawn is needed. A name that is already set is never replaced, and a pane bound to two names gets none.
- The ambient ee session-start extension runs `ee` with `GIT_OPTIONAL_LOCKS=0`, so the `git status` inside `ee orient --fast` no longer takes the optional index lock; when the runner killed ee at its deadline, git never removed that lock, which left orphan empty `.git/index.lock` files that blocked commits in large checkouts.
- Memory doctor and the opt-in memory audit now use the already-resolved, exact-version OMP source package for compiled and Tern-managed launchers. Mismatched package versions remain unverified, and memory inspection never downloads source packages.
- A push no longer starts the complete test suite in the background. The full suite runs once per release, when the release is cut; each commit and push still runs the tests its change affects. Set `OMP_KIT_RELEASE_VERDICT=1` on a push to start it there as before.
- A red release verdict on main no longer refuses unrelated commits. The commit gate reports it (first red commit, failing tests, bead) and the commit lands; the red verdict still stops the release it judged.
- Scratch cleanup no longer mistakes a live owner for a reused process id on machines east of UTC. `ps` prints a process's start in local time and the reaper read it as UTC, so on a host such as Europe/Berlin a live owner's start looked an hour later than its scratch directory's creation, and its scratch could be reaped as abandoned. The start is now read as local time.
- Remote full-suite workers now match the CI runners: `suite-worker-setup.sh` sets their system time zone to UTC and makes `/sys/kernel/debug` traversable, so `lsof` answers without the tracefs warning that the kit's open-file checks treat as unavailable.
- The full-suite verdict can run on Linux suite workers. When `rch workers list` names enabled Linux workers that `scripts/suite-worker-setup.sh` brought to CI parity, every declared file except the macOS-only ones runs there, sharded longest-first from the exact `git archive` of the commit, while this Mac runs the macOS-only files. The result is one main-role verdict that `release-local` reads as before. A failing test on a worker makes the verdict FAIL; a worker that drops out leaves no verdict. With no worker configured, ready or reachable, or with `FULL_SUITE_REMOTE=0`, the complete suite runs locally and the run says why.
- When one worker's shard does not finish, the shards that did still record their files' run times, so the next run splits the work by measured times instead of repeating the uneven split.
- Shared CI polling now uses your `gh auth login` credential when token environment variables are absent. Without credentials it reports UNAVAILABLE with a login remedy instead of making anonymous requests or consuming rate-limit backoff.
- Release archives now use `.tar.gz` (gzip level 6), reducing upload and update download sizes; checksums, signing verification, SBOMs and provenance attest the compressed bytes actually published.
- Installations on 0.2.101 or older must update through 0.2.102 or 0.2.103 before consuming gzip-only releases; the managed fleet already shares the 0.2.102 installation.

## [0.2.102] - 2026-11-08

### Changed

- Accept metadata-less provider abort messages only when their call identity and exact text match an authenticated native synthetic abort; retain execution rejection and print call-scoped interruption diagnostics.
- Include bounded mock transcript and OMP output tails in live-scenario failure logs, preserving runtime error details when private CI captures are not uploaded.
- The fleet upgrade notice now describes the native restart: the helper waits for the seat to go idle, restarts omp in place with `/restart` (same session and launch flags), and resumes the goal once if it was active; it no longer claims to press Esc.
- Author handoff now accepts ~/.claude's own exact storegate GREEN marker, bound to the current hook and runtime; missing or pruned observations name its native verdict producer instead of a nonexistent companion command. Other repositories cannot borrow companion evidence.
- Restored author handoff for repositories with their own complete GREEN fresh-gate observation for the exact source commit, even without a committed companion gate script; ~/.claude still requires its native storegate marker and rejects fresh-gate-only evidence.
- The ~/.claude storegate handoff fixture gives its private HOME a `.bun/bin/bun` entry, because the storegate key's runtime check rebuilds PATH from `scripts/fixed-env.sh` under that HOME; on Linux CI bun lives under the runner's real HOME, so the fixture failed there.
- Add `omp-kit ci wait --repo OWNER/REPO --sha SHA` to await completed workflow runs using shared-cache filesystem events, without GitHub requests or polling; supports workflow, since and deadline filters and reports cache age and the last matching run on timeout.
- Reconcile the CI cache once after watcher startup so macOS cannot strand a wait when its first rename event is lost; this one-shot read is not a polling loop.
- Published-release updates now fetch the release index first and download its platform archive, supporting both `.tar` and `.tar.gz` while refusing archives whose bytes do not match the indexed digest. Release packaging continues to emit `.tar` during the compatibility rollout.
- Interrupted published-release polls reuse a verified index/archive pair without downloading it again, refresh its provenance bundle, and replace incomplete downloads using GitHub's overwrite flag.
- Restore the cold-server configured check required by native LSP certification while preserving elapsed-bounded readiness checks; test the real probe against certification's required checks.

## [0.2.101] - 2026-11-08

### Changed

- Add retirement regression plants for incompatible consumer acceptance, foreign-reservation write denial, and failed, timed-out or cancelled child process cleanup; each plant detects a process-local disabled enforcement mechanism. Human-only secret, spend and legal authority remains uncovered by these tests; no new authorization enforcement is claimed.
- Skip the optional live-checkout brief integration test in source archives without Git metadata; checkout runs retain the existing admission assertion and fixture coverage remains enabled.
- CI stock-extensions has no `ps` on PATH; the reaping plants call /bin/ps (macOS and Ubuntu 24.04 both ship it).
- Keep descendant-cleanup regression plants effective under stock CI's minimal PATH by invoking /bin/sleep directly and exercising the plants without PATH tools; missing sleep no longer short-circuits the deadline or hides disabled cleanup.
- Remove the obsolete pregrade module and test paths while retaining native close authorship and reservation checks under native-close. Cover refusal of a non-author close without a verification record and admission with its independent PASS record.
- Live interruption verdicts recognize call-bound native synthetic TTSR abort results without mistaking them for execution; real execution and unclassified results still fail.
- `br update --status in_review --append-notes 'DONE /absolute/source/repo@commit: evidence'` now checks the named source repository's complete GREEN fresh-gate observation instead of losing the source and checking the tracker checkout. Both `--append-notes TEXT` and `--append-notes=TEXT` work; missing, RED, incomplete, or wrong-commit observations still refuse the transition.
- Prepare release metadata and the next development version through commit preflight before committing, preserving commit-gate admission and the existing advance-only recovery command. (ompkit-d8qic)

## [0.2.100] - 2026-11-08

### Changed

- Update the installed schema-1 baseline regression pin for six removed fleet-restart raw-spawn allowances (17 sites); preserve the single-rule schema and all remaining allowance limits.
- Retire timed goal re-arming, the kit seat-lifecycle daemon and fleet respawn/composer reconstruction. Tern owns session persistence and OMP owns goal continuation, pause, resume and drop; an owner pause is never implicitly resumed.
- Keep release-verdict event subscriptions and read-only release profile alignment without starting turns or restarting seats. Applied service installation unloads retired installed lifecycle definitions, verifies they stopped, and backs them up; a still-loaded job refuses migration.
- Run the external-app restart canary with `OMP_KIT_TERN_LIVE=1 bun test extensions/kit-goal-keepalive.test.ts -t NATIVESESSION1`. Its working directory must fit Darwin's 104-byte Unix socket path limit; it does not run from long export roots. Default/hermetic tests cover the owner decision and timer mutant, not native restart proof.
- Remove the release minimum-run qualification and retired-test ledger; historical verdicts remain readable.
- Remove automatic per-failure culprit reruns and bisection from release qualification.
- Replace the release-card grammar gate with a one-paragraph human release card.
- Run every deferred manifest suite inside the one main-role qualification; release readiness and cuts no longer require a separate CI-only verdict.
- Remove obsolete pregrade-admission tests after pregrade retirement; retain handoff refusal, unchanged native state, exact source check, and GREEN-ledger coverage.
- Remove the separate pregrade record and opt-in requirement for review admission (Joshua J-2026-11-07-08). Acceptance ticks and native non-author close checks remain; native child reservations keep their own identities.
- Run the mission doctor contract against the candidate CLI instead of requiring an unrelated installed omp-kit executable.
- Exercise the current failure-capture stdin/stderr contract so successful journal writes retain duplicate suppression in extension tests.
- Discover the optional DCG adapter on the caller's PATH instead of requiring a machine-local executable path; retain fail-closed decisions when the adapter is present.
- Discover the optional failure-capture adapter on PATH and keep command details on stdin, without requiring a particular user's home directory.
- Run the pre-push regex checker with the gate's existing python3 interpreter instead of requiring an unrelated Python minor version.
- Keep capability contracts hermetic by exposing only explicitly supplied fixture tools, without assuming every fleet binary is installed on the host.
- Give concurrent gate-load fixtures their own real Bun executable under the synthetic HOME so fixed environment reconstruction works on Linux.
- Give history-transform fixture repositories their own Git author identity so commit-tree controls cannot inherit or require operator configuration.
- Verify restored hook permissions with the portable filesystem API rather than mixing incompatible BSD and GNU stat output.
- Preserve the stock OS Python in the isolated extension-test PATH so portable process cleanup works while fleet tools remain absent.
- Run parallel live-test cases from a caller-owned workspace scratch root instead of the runner's system temporary directory.
- Include native low-filesystem refusal output in failing CI assertions without changing their required exit codes or disk-floor checks.
- Make the live Git lock-holder fixture preserve Git's exact PID across Linux shell execution.
- Use a job-control-capable shell for detached seat fixtures on Linux while keeping scratch ownership and capability checks intact.
- Preserve shared land/save fixture templates until their Bun process exits, even when another test suite cleans its own temporary registry.
- Keep the resolved OMP source-cache location available to packaged-runtime fixtures after they replace HOME with protected canaries.
- Build and execute the host-native official release artifact in the runtime replay smoke instead of attempting a macOS executable on Linux.
- Check the same OMP package watch path in each platform's native fleet service definition, including Linux systemd path units.
- Scope fleet-guard scratch-write quiet controls to their own owned TMPDIR rather than the runner's ambient temporary directory.
- Configure task/smol model roles through OMP's supported fixture configuration so the native spawn smoke reaches its real child without unsupported per-call model arguments.
- Allow the matching advisory commit-preflight reminder in the no-verify live scenario while still requiring its blocking rule and the absence of the forbidden marker.
- Execute the selected OMP launcher directly through the bounded 30-second runner in custom live checks, supporting compiled Tern releases without treating their binary bytes as JavaScript or inheriting Bun's interpreter override.
- Preserve exact hook-member permissions on rollback on Linux as well as macOS, without mixing failed BSD-stat stdout into the saved mode.
- Preserve early focused-gate refusal codes and record zero executed tests by initializing the fixture's counters exactly like the production gate.
- Keep the actual Bun executable available in the package fixture's private HOME so pinned runtime identity works on Linux without relying on a system-wide Bun.
- Include the blocked-service child's typed stdout, stderr and signal identity when its unchanged exit-code assertion fails in CI, without treating diagnostics as a fix.
- Make the live runtime's private Bun command enter interpreter mode only when invoked, supporting native, shell-to-Bun and Bun-shebang OMP launchers without leaking that override to native executables.
- Validate daemon install plans against the native scheduler artifact: launchd KeepAlive on macOS and systemd Restart=on-failure on Linux.
- Keep the physical disk-floor test aligned with its immediate typed refusal: exit 1, no command run and no queue waiting or retryable deferral.
- Make the blocked-worker concurrency fixture's initial admission deterministic without changing its real lock exclusion, timeout, cleanup or deadline assertions.
- Keep export-layout parity tests independent of a cached ShellCheck image while retaining real repository-root, source-stamp, overlay and wrong-stamp refusal checks.
- Keep daemon single-instance locks held on Linux: SQLite now owns existing lock-file descriptors, so validation and rejected local contenders cannot silently release the kernel reservation. Preserve private-file, no-symlink and inode-identity checks, and verify overlap without racing the scheduled worker's deadline.
- CPU-limited TypeScript and Python commands now receive SIGXCPU at their requested soft limit before the hard limit can send SIGKILL on Linux. Runner memory checks sample current resident memory while queues are retained, rather than subtracting inherited process high-water marks.
- Atomic file replacement keeps the staged inode open through validation, final identity checks, and refusal cleanup, preventing Linux inode reuse from admitting a swapped file or deleting the attacker's replacement.

## [0.2.99] - 2026-11-07

### Added

- `ovnfs-land` lands committed Worktrunk linked worktrees or independent worker checkouts through one repository lock, replays each worker commit with normal hooks, preserves unrelated shared edits, and refuses dirty or historically overlapping main paths before writing.
- `omp-kit tools verify NAME [--artifact PATH] [--platform OS_ARCH]` checks pinned archive and binary SHA-256 without installing or executing artifact code; seeds ovnfs darwin_arm64 and reports the mismatched field on refusal. No execution authority or SLB policy changes.
- Release readiness reports one READY or NOT-READY line with every failing cut prerequisite, using exact origin/main source and stored runtime-bound verdicts; inspect it with `doctor --scope release --project PATH` or in the push qualification log.

### Changed

- Release measurements retain every reading with its load instead of voiding high-load pairs. Heavy-work admission now reports process owners, elapsed times, zombie parents and stale-session MCP candidates before deferring, and stops expired incarnation-checked kit jobs; load-watch retains the diagnosis.
- Restore save-path and checker-contract regression tests by including heavy's load-census dependencies in both Git and exported-source fixtures; retain pressure warnings, statfs execution, incomplete-suite refusal and missing-checker rejection.
- Child model policy now runs only in OMP's native `before_subagent_spawn` hook: fleet chief/director Sol children are admitted and Opus-class children are denied before provider requests. Removed private OMP settings-source imports and obsolete task-call model refusals; brief-contract and prior-art checks remain unchanged. (ompkit-1ra0d.35, NATIVESPAWN1)
- Send Tern seat messages through the native agent prompt queue instead of composer paste and Enter, including busy seats; require target identity and journal consumption before reporting success.
- Busy native sends report QUEUED then DELIVERED on journal consumption, or EXPIRED when proof times out; expired submissions remain pending and are never automatically resent.
- Native br owns dependency-type and template validation, and bv owns ranking; bead lint no longer duplicates these checks. Retired the unsupported-br-flag and todo-phase reminder rules in favor of native tool validation. Usage statistics remain available through `omp stats`.
- Native verifier children can record export-bound pregrades with `kit_record_pregrade`; authors, stale acceptance digests and missing export commits are refused. Child reservation calls cannot borrow the parent's identity and require their own registered Agent Mail name.
- Native verifiers that ran untracked source-repository shell commands or any eval are refused, even when the lead committed their edits. Single read/setup commands remain allowed; run verification from an independent export and use `git -C` for source reads.
- Minimum full-run qualification now honors a reviewed per-suite retirement ledger only after verifying exact Git deletion and ancestry, retaining each applied or already-accounted-for retirement in the verdict. Unlisted deletions still fail; count-drop allowances remain zero.
- Restore the full-suite disk-pressure regression test by including the release-readiness README checker required to start its real CLI fixture; keep auto/sbh refusal and inherited-statfs admission assertions unchanged.

### Fixed

- Commit preflight now judges the same candidate outside Git's index lock; commits verify the prepared tree and refuse changed paths or parents instead of blocking other writers for the gate run. `save` and `land` prepare automatically; direct commits use `scripts/commit-preflight.sh --message FILE --files PATH...` first.
- ompkit-1ra0d.29: the near-budget REGEXREF1 test now asserts the gate's documented contract on any host, FAIL at reference ratio 1 and never PASS when slower, instead of requiring FAIL on a loaded host where the gate correctly reports INCONCLUSIVE.
- Require a real native build spawn with the verbatim kit brief in a fresh non-kit tracker before a local release; catch the retired cross-tracker prior-art refusal. Portable tests explicitly skip when OMP or native br is absent, while the release smoke refuses missing prerequisites.
- Release and verdict gates use one kit-owned PATH and locale instead of the invoking shell; verdict records retain the judged environment, and genuine runtime mismatches still refuse reuse.
- Prefer Tern's native OMP launcher when installed, preventing user trust wrappers from hiding launcher versions in fixture homes.
- Qualification constructs an explicit allowlisted child environment for release, verdict, focused-suite and Python-only storegate checks. Caller profile, Git, tracker and arbitrary variables cannot poison execution or cached PASS reuse; candidate-authored identity conflicts still fail.
- Release archives carry the pinned environment policy, and suites with a private HOME still find OMP's exact-version source through the operator's read-only cache.
- Fleet guard permits builders to work on non-main branches in linked worktrees, keeps branch switching and creation out of the canonical checkout, directs raw worktree creation to Worktrunk, and explains that only the lead lands commits.
- ompkit-1ra0d.42 (WORKTREEKEY1): a `git commit` in a linked worktree now reads the seat's Agent Mail reservations under the canonical repo key (the parent of git's common dir) instead of the worktree path, so paths reserved for a builder worktree are no longer refused as PATH_UNRESERVED; unreserved paths still are.
- Rules doctor follows OMP's profile YAML precedence (`config.yml`, then `config.yaml`), so ignored legacy settings no longer make healthy profiles unverified. Invalid selected YAML and missing rules still report their causes; inspection never migrates profile settings.
- Isolated rule probes now run inside their private HOME, preventing the inspected HOME's default plugin from shadowing named-profile plugins or receiving probe writes.

### Removed

- Bead lint no longer blocks work for missing labels, prose-letter citations, blanket dependency size/depth limits, legacy plan citations, historical mentions without edges, or mandatory goal-path placement. Native dependency/cycle/claim checks and acceptance replay remain unchanged; backlog migration preserves clean label-free records.
- Remove role-based question vetoes, milestone-cut claim vetoes, prose-gap scanning, prior-art citation passwords and seat-specific wait refusals. Native claim custody, human gates, independent acceptance replay, finite-job deadlines and script dependency validation remain enforced.
- Retire commit-message gap-prose and staged citation-registry blockers; tested repairs can commit on the first attempt. Hook refresh removes unchanged legacy members and preserves owner-modified hooks for review. Explicit fetched-source verification remains available.
- Remove duplicated standing-law injection, starter-checker reminders, prescribed retry-ledger prose, and the discovery canary from the rule packs; retain checker selftests, explicit discovery diagnostics, and unverified-completion protection.

## [0.2.98] - 2026-11-07

### Added

- Repositories can configure `.omp/gate-wiring.json` to refuse pushes exceeding their unwired-gate, statically unreachable shell-gate, or expired-quarantine maxima. The audit uses committed candidate bytes and incumbent policy, names offending gates, and requires no hosted-CI API. Repositories without a policy are explicitly not judged.

### Changed

- Allow never-claimed, unimplemented work to close with an owner decision ID and commit citation; bare close reasons and unreadable history remain refused.
- Commit and push gates skip unrelated manifest, budget-policy, CLI compile/boot, harness and README phases; notes provenance and affected-test checks still run, and failing changed inputs still block.
- `apply extensions` now installs only tool-independent observers by default; use `--fleet` to opt into external guard, memory, search, topology and RCH integrations. Existing profile entries are preserved.
- Document the default profile extension selection from `policy/extensions.json`; the README checker now rejects missing or stale entries.
- Keep personal fleet decisions out of the default standing rule; preserve them unchanged in the opt-in fleet rule pack.
- Make shipped skill instructions resolve installed kit resources instead of private checkouts, document `scratch mine`, and reject machine-specific user paths in shipped skill files.
- bead-lint tests: `br create` is now pinned to the in_review handoff's own checks. A create whose box's first backticked span is prose is refused with the handoff's exact replay text, and one that mentions another bead with no edge is refused i-mention-edges. A clean create, or a mention joined by a `--deps`/`--parent` edge, is admitted. A mutant that strips the shared checks makes the planted creates pass. (ompkit-fp72.120.16.238)
- Local-release attestation verifies the three platform archives concurrently with the existing bounded consumer verifier; any archive or index verification failure still prevents publication.

### Fixed

- The commit-imports gate finds the host TypeScript library past a launcher shim: it tries every `tsc` on `PATH` in order and loads the first whose real path has a sibling `lib/typescript.js`. Before, a pnpm global `~/.local/bin/tsc` first on `PATH` (as on headless builders) made every TypeScript commit fail `PARSER_UNAVAILABLE`. A candidate compiler inside the repository is still refused. (ompkit-1ra0d.1, TSCSHIM1)
- Tern send, inspection, and seat binding preserve exact decimal pane IDs above JavaScript's safe-integer limit, keeping neighbouring 64-bit blocks distinct.
- The release's next-version advance commits through the commit hooks again: its subject carries a proof level (`[pending]`), and the commit gate's README release-line check reads tags from the canonical repository instead of the gate's archive copy, where an initialized `.git` hid the published tag and reported it absent. (ompkit-1ra0d.19, RELADVANCE1; diagnosis by builder TopazGate)
- Goal keepalive no longer wakes a seat whose fleet-watch session is paused (`pullEnabled: false`); a paused project spends no keepalive turns. The timer stays armed while paused (a config read, no model turn), so the idle seat wakes on its next interval once the session is unpaused. An unreadable config or a seat outside every session keeps the wake. (ompkit-1ra0d.3, KEEPALIVEPAUSE1)
- Release SBOMs now list versioned Bun native libraries, the pinned Tern SDK and runtime lockfile dependencies instead of scanning an opaque archive directory. Attestation uses each archive's build-time inventory, including after Darwin signing; invalid lockfile inputs refuse generation.
- Doctor checks installed rules in per-profile plugin packages instead of requiring legacy rule copies, names missing rule files, distinguishes failed activation probes from confirmed missing rules, and gives an explicit planning-skill repair command.
- bead-lint's goal-path check treats a parent-child descendant of an open `kind:goal` bead as on that goal's path. Before, every child of a goal epic with other children was unplaceable: the only other edge (goal blocks child) is refused because it hides all children from `br ready`. A child of a closed goal is still refused. (ompkit-1ra0d, GOALCHILD1)
- The update service now automatically restores a failed kit-only activation only when its receipt is still pending and READY, both recorded binaries verify, and the current tick reports a revert-safe postcheck failure. Successful recovery clears the pending receipt as compensated while retaining the failure; unsafe or restarted recovery requires inspection.
- Full-suite qualification allocates launcher staging per worker instead of per test file, while retaining fresh private scratch, native timing evidence, and execution for every declared file.
- Resume a published release's next-version advance with `scripts/release-local.sh --advance-only --version X.Y.Z`, without rebuilding, signing, publishing or installing. Unpublished or unattested releases refuse before checkout writes; completed advances are idempotent. Commit refusals retain the actual hook diagnostic and retry command instead of a manual recipe.
- Allow empty completion sentinels in owned scratch even when tracked files are empty; continue refusing canonical source paths and nonempty source copies.
- Keep commit and push release-note checks bound to the pushing repository after the base judge initializes the candidate archive for tests.
- Wake configured chiefs for mail sent under another project key, using their canonical seat identity, launch directory and session journal while preserving identity and pause checks.
- On native OMP hosts (18.17 and later), the spawn-model policy is enforced only by the `before_subagent_spawn` check on the patterns OMP resolves; the task-call path, whose settings-source import a compiled host cannot resolve and which refused every background agent, now runs on legacy hosts only. Opus-class children of chief/director seats are still refused. (ompkit-xa5s.45, SPAWNNATIVE1)

## [0.2.97] - 2026-11-06

### Changed

- Set CLI and OMP plugin version metadata to 0.2.96. The release is qualified on this prepare commit's exact exported tree before signing.
- Set CLI and OMP plugin version metadata to 0.2.97. The release is qualified on this prepare commit's exact exported tree before signing.
- A kit runner killed mid-run no longer leaves its child sessions running. Every process that calls `pysafe.run_bounded` (and the TypeScript `kitlib run`) now starts one parent-death reaper (`pysafe.py reaper`, in its own session) and registers each child session with it over a pipe. When the caller dies, even by SIGKILL or by SIGTERM without `run_main`, the pipe closes and the reaper kills every registered session whose leader still has its recorded start time; an unrelated session is never touched. Timeouts and cancellation now sweep the child's whole session by `os.getsid`, so a descendant that moved to its own process group (`setpgid`) no longer survives them; a normal leader exit still kills only the leader's process group. This is the 2026-11-04 CFS publish, where git's pre-push hook and node outlived a killed `git_converge.py` for about 50 minutes.
- `kitlib run` accepts `outlive_parent: true` for a caller that must leave a process behind on purpose (the scratch orphan-reap test fixture): that one group is not registered with the parent-death reaper. No product code passes it.
- `installer/install.py` is regenerated from the new `scripts/pysafe.py` (`python3 -I installer/embed-bootstrap.py`), so the installer's embedded bootstrap matches the shipped runner again.
- `kitlib run` carries the parent-death reaper's code inside itself (`src/kitlib/pysafe-source.ts`, generated from `scripts/pysafe.py` by `python3 -I installer/embed-bootstrap.py`, whose `--check` now covers it), so a binary compiled outside a release (no `scripts/` beside it) runs commands again instead of refusing every `run()` with "parent-death reaper script not found".
- One full suite runs at a time on a machine, whatever launched it (SUITESERIAL1). `scripts/full-suite-verdict.sh`, the judge that the pre-push gate, `omp-kit land`, `release-verdict.sh` and ad-hoc runs all call, now takes a machine-wide suite lease (`scripts/suite-lease.sh`, a `kitlib_lock` flock) after a cache miss. A request for the exact tree and role of the running suite joins it: no second suite starts, and the caller prints `FULL-SUITE: JOINED ...` and reads that run's verdict. Any other request waits in a bounded FIFO queue and says `suite-lease: QUEUED ...`; a fourth waiter (`FULL_SUITE_LEASE_QUEUE_MAX`, default 3) or a wait past `FULL_SUITE_LEASE_WAIT_SECS` (default 3600) exits 75 with `SUITE_LEASE_QUEUE_FULL` or `SUITE_LEASE_WAIT_TIMEOUT`, and runs nothing. Cache hits take no lease. The basis is omp-kit's capacity plan (recommendation 2): each extra concurrent suite cost 0.15 of the clean-pass rate.
- `release-verdict.sh` holds the lease around its runner, the CI-only judge beside it and the culprit step, and its requests go first in the queue, so release-local's verdict stage waits at most for the suite already running. The runner inside it finds the lease held by its enclosing run and takes none.
- The lease is released on every exit path. A normal exit, HUP, INT or TERM releases it from kitlib's exit registry, and the holder is signalled only after its pid is proven to still run with its recorded start time. A SIGKILLed launcher is released by its holder once the launcher is identity-proven dead. Queue tickets are reaped only on the same proof. The lease state lives in `$XDG_STATE_HOME/omp-kit/suite-lease`, or `FULL_SUITE_LEASE_DIR`, or beside an explicit test verdict store.
- The full suite never uses more than 6 inner workers, even when `FULL_SUITE_JOBS` asks for more (at 28 workers, 0 of 9 runs passed).
- `scripts/suite-lease.sh`, `kitlib_lock.py` and `kitlib_proc.py` are in the judging closure (`suite-metrics.py` `JUDGING_FILES`), so land's archived judge carries the lease, and the lease script ships in the release. A judge whose closure lists the lease refuses `SUITE_LEASE_MISSING` without it. Only a judge whose closure predates the lease prints `SUITE_LEASE_ABSENT` and runs unserialized.
- Fix shared-runtime pushes refusing an exact-tree full-suite PASS when pre-push supplies an archive and its candidate repository; caller-owned archives without a repository remain isolated from the verdict store.
- Name Git read failures in the scratch durability guard with their killed flag, signal, exit code and bounded first stderr line, so UNKNOWN distinguishes a deadline kill from a missing repository or other failure; keep the existing deadlines and fail-closed verdicts unchanged.
- Rerun failing CI-only verdict files once in fresh exact-head exports, recording validated flake attribution so unreproducible failures no longer block unrelated commits while reproducing failures stay red.
- From the pending release card v0.2.95, classify deterministic single pairs and fixture/mutant arms as MECHANISM: accept MECHANISM VERIFIED, refuse SHIPPED/applied field-effect claims, and preserve published card verdicts through v0.2.94. The pending DIRECTORREACH1 card now names its mechanism proof without claiming the unmeasured live effect; the rubric also records the limits of autocorrelated sequential tests and the unproven reviewer panel.
- The release judge (`full-suite-verdict.sh`, `release-verdict.sh`) now drops an inherited `BEADS_DIR` as well as `BEADS_DB`. A push carrying `BEADS_DIR` had made 111 native `br` fixture tests fail on `br init` (exit 2) and turned a good tree red. (ompkit-fp72.120.16.302)
- A refused task spawn that could not read its model inputs now prints the underlying error (`cause: ...`) after `SPAWN_INPUTS_UNOBSERVABLE`, so an unresolvable OMP import names itself. (ompkit-fp72.120.16.45)
- Release installation reuses a completed reconciliation's plugin relink only while its durable receipt covers every current profile and live links target the verified release; final alignment and version checks remain mandatory, with relinking if profile coverage changes during readback.
- Public release verification runs up to three independent attestation-fetch and installer-verifier chains concurrently, preserving all byte, checksum, authority and Gatekeeper checks and refusing on any failed, timed-out or truncated chain.
- Local release verdict logs report wall-clock starts, ends and elapsed seconds for source export, stored-verdict lookup, producer invocation, observed per-repo holder wait, polling, exact-tree readback and signing preflight without changing qualification or release decisions.
- Verdict runner logs separate exact-commit and CI-only exports, canonical-store lookup, suite-lease wait and main/CI-only dispatch-to-observed-completion intervals, including refusals, without changing qualification or cancellation behavior.

### Fixed

- `omp-kit send <session> tern:<block>` reaches a fleet-watch director seat again. On macOS `ps eww` prints no environment for the target process, so its `AGENT_NAME` was never readable, and a caller without `AGENT_MAIL_PROJECT` had no project; every such send refused `PLANE_SEAT_UNBOUND` ("Tern target AGENT_NAME or caller Agent Mail project is unavailable") with zero sends. The send now uses the seat's configured repo (fleet-watch `repo`, or the Tern-inspected cwd) as the Agent Mail project when the caller sets none, and binds the seat to the Agent Mail `resolve-pane` row for that exact pane and project. A readable `AGENT_NAME` must still agree with that row (else `SEAT_REBOUND`), an unreadable one never upgrades a `legacy-unverified` binding, and a pane Agent Mail cannot resolve still refuses `PLANE_SEAT_UNBOUND` with zero sends.
- A partial update with no verified active version now reports KIT_ACTIVATION_UNVERIFIED in the CLI and directs repair through a known-good release binary, without advertising undo or reconciliation against an unverified activation.
- LANDRESVTIMEOUT1 (ompkit-fp72.120.16.282): land's `am robot reservations` read now runs through the same
  load-scaled bounded runner as `am agents resolve-pane` (30 s base scaled by the 1-minute load per core, factor
  1..4; `OMP_KIT_LAND_RESOLVE_BASE_S` overrides the base for both), instead of a fixed 10 s spawnSync timeout. A
  reservation read that does not answer in time is refused `RESERVATION_TIMEOUT` with the deadline and a command
  to check; only a failed or absent `am` stays `RESERVATION_UNAVAILABLE`. The private-index-land 2b and 3b retry
  helpers now re-run land on `OWNER_RESOLVE_TIMEOUT` and `RESERVATION_TIMEOUT` as well as `OWNER_UNKNOWN`. The
  planted, control and mutant cases live in tests/cli/land-reservations.test.ts, because tests/cli/land.test.ts
  is at its per-file time budget.
- STAGE0WAKE2 (ompkit-fp72.120.16.284): a director armed under the chiefs' pause with `arm_seat.py --set --apply
  --override-pause` is woken by mail again. STAGE0WAKE1 reads the seat's latest dated receipt row in
  `goal-replacements.jsonl` for `override_pause`, but the live `--set` arm wrote only an undated `managed_goal` row and
  printed the reason to stdout, so mail 78766 to RusticPine read `PROJECT_STOPPED`. arm_seat.py (in the
  omp-kit-orchestration skill) is the one producer: every apply path now writes a dated row that carries the reason
  (`--set`'s `managed_goal` and mode rows, each `--replace-goal` step row, and a new row for the plain arm), and an arm
  without the override writes a dated row without it, which disarms an earlier exception. The planted, control and
  mutant cases in `extensions/kit-mail-wake.test.ts` run arm_seat.py's real `main()` with its seat I/O intercepted;
  they are skipped where arm_seat.py or python3 is absent.
- GOALBREATHE1 (ompkit-fp72.120.16.286): kit-goal-keepalive no longer wakes a goal seat that is only waiting.
  When the seat's latest todos have no in_progress or pending item and at least one blocked item, and the seat waits
  on a live background job, a job result queued for delivery, or an event that a blocked item names in its
  `blocker`, the seat now gets no wake. The awaited event delivers its own turn, and the end of that turn re-reads
  the state. While the seat is in this idle state it gets at most one heartbeat per 30 minutes, so a lost event
  cannot strand it. The extension reads the todos from the session branch the way omp restores them, and the jobs
  from `ctx.getAsyncJobSnapshot()`. An actionable item, an empty list, an item of unknown status or an unreadable
  source keeps the ordinary wake. omp core sends the 'Continue active goal' turns, not this extension. Core already
  stops them when every todo is blocked, but no extension hook can veto one. The planted, control and mutant cases
  are the GOALBREATHE1 tests in `extensions/kit-goal-keepalive.test.ts`.
- MINRUNANCESTOR1 (ompkit-fp72.120.16.292): full-suite minimum-run checks now compare against the newest validated PASS whose tree belongs to the judged commit's bounded ancestry, rather than allowing an unlanded candidate or sibling branch to falsely mark main RED. The 1,024-commit walk covers over twenty times the largest measured gap (50 commits across 67 successful release verdict commits). Missing commits or ancestor references explicitly retain first-run behavior: no baseline, with absolute wall floors still enforced. Version-1 minimum-run reports gain optional selection metadata; historical reports remain readable.
- Include matching release-verdict results and recorded return codes in blocked goal seats' next existing keepalive check. This timer-only fallback adds no polling loop: results arriving after the initial two-minute check can wait until the 30-minute heartbeat; it does not provide immediate event-driven waking.
- Register release-verdict mail subscriptions and atomic-write temps with their agent/project owner, cancellation and crash lifecycle so ownership validation admits the release without weakening its checks.
- Release qualification reads validated exact-tree main and CI-only PASS records before waiting for the suite lease, and runs only missing qualification; changed trees, checkers, runtimes and invalid evidence still require the original gate.
- Kit updates run the target release's own full postcheck once, preserving its stage expectations, harness environment, service-state policy and watched state root instead of using the previous version's test runtime. Invalid or exit-inconsistent candidate reports cannot certify an update.
- Update ticks now surface pending receipts before polling instead of reporting CURRENT or retrying activation. Receipts lacking restart-safe recovery evidence remain pending with audit/reconcile guidance; an OMP-changed or unverified active installation never triggers automatic reconciliation or a doomed undo suggestion.
- Reconcile-then-undo remains supported once while the recorded candidate and prior binaries are intact; a changed postimage still refuses rollback.
- Scratch durability admission retries its first Git read once only when the two-second execution deadline terminates it, tolerating cold executable startup while keeping persistent hangs and other read failures fail-closed.
- `verify` scrubs caller tracker selectors and agent-bin PATH entries before acceptance replay. Failed boxes retain raw stdout followed by stderr in private, owned `var/verify-evidence/verify-output.*` files, referenced in REWORK and JSON with byte counts and completeness; the display stays excerpted. Evidence is bounded by the existing 4 MiB per-stream capture (8 MiB per box); exceeding it fails with `OUTPUT_LIMIT` and an explicitly incomplete artifact. Retain these files for review, then remove their owned directory after transferring the evidence. Tracker reads inside acceptance must bind their database explicitly.
- Release verdicts notify blocked goal seats through Agent Mail after both judges finish, including the exact head and both exit codes. SHA-scoped subscriptions ignore other heads, deduplicate delivery, and leave verdict status unchanged when mail is unavailable; the existing keepalive timer remains the fallback. Notifications use the existing Agent Mail HTTP client and the publisher's `AGENT_NAME` / `AGENT_MAIL_SENDER_TOKEN` credentials. Flake admission is unchanged.
- Tern sends reconcile rewritten journals by exact typed message identity; unproven replacements remain blocked until explicitly acknowledged with `send --ack-pending RECORD`, which never resends the old message.
- `deliverToTernSeat` accepts a test-only `testOnlyPendingSettlement: "v0.2.95"` seam so the release measure can compare the old settlement; production behavior is unchanged. (ompkit-fp72.120.16.310)
- Bound full release qualification to five concurrent macOS runners without removing any suite or certification track; retain existing parallelism outside versioned qualification. The default local-attest release path is unchanged.
- Pre-push runs the committed base's fresh gate when judging code or its executable inputs change, preventing gate deletion or `exit 0` bypasses without adding a second fresh-gate run to ordinary pushes.
- Release-train idle waits now refuse with `missing-github-token` before querying the release lane when neither an environment token nor an authenticated GitHub CLI account is available.
- Chiefs and directors now receive `SPAWN_MODEL_REFUSED` before a task child starts when its native OMP model selection is Opus-class or cannot be resolved. The task-call guard checks per-call selectors, exact-agent settings overrides, agent definitions and parent inheritance, reads OMP's global/project settings plus observable session overrides, and teaches the restart-safe Sol override. A native `before_subagent_spawn` check also checks core's final patterns, including session-only overrides that a compiled OMP's disk reader cannot observe. Builder/grader seats are unchanged. Credential failure after admission can still trigger OMP's upstream parent fallback; this does not close AGENTMODEL1's upstream fallback acceptance box. (ompkit-xa5s.45; J-2026-10-18-33, J-2026-11-05-15, J-2026-11-05-16)
- Configure the flywheel guard's role roster with `OMP_KIT_FLEET_ROSTER`; the default is `$XDG_CONFIG_HOME/omp-kit/fleet-roster.json` or `~/.config/omp-kit/fleet-roster.json`. A stock install with no configured roster and no default roster remains unaffected, even with `AGENT_NAME` set. An explicitly configured missing roster or an existing unreadable/corrupt default receives `SPAWN_ROSTER_UNREADABLE`; the existing ask guard still warns and allows. Existing fleets whose roster lives inside an operator skill directory must set the override or provision the default before activation.
- Withdrawn: the spawn guard's host-settings fix from 367057d683 is reverted because its bare OMP imports broke the release bundle; spawns keep the 0.2.95 behavior until a bundle-safe fix lands. (ompkit-xa5s.45)

## [0.2.94] - 2026-11-05

### Added

- PINORDER1 (ompkit-fp72.120.16.275): `omp-kit milestone pin SESSION BEAD... --first --reason TEXT` moves the
  named pins to the front of the cut in argument order, through the same tracker validation, lock, atomic write
  and one pinLog row (`first: [...]`) as plain pin. Every other pin keeps its relative order; plain pin still
  appends. A constraint change now reorders the cut in one audited call instead of unpinning and repinning every
  pin ahead of the clearing bead, so launch_check SUBORDINATE reads GO.
- MSDATE1 (ompkit-fp72.120.16.278): `omp-kit milestone date SESSION YYYY-MM-DD[THH:MMZ] --reason TEXT [--by NAME]`
  sets `milestone.due` in fleet-watch.json under the same lock and atomic writer as pin/unpin, appending one
  `pinLog` row with actor, time, old/new due and reason. A date before today (UTC) refuses `PAST_DUE`; a malformed
  or impossible date refuses `MILESTONE_USAGE`. Directors can now re-date their own milestone without hand-editing
  the config.

### Changed

- RELPREREG1 (ompkit-fp72.120.16.258, Joshua J-2026-11-05-05): from card version 0.2.94,
  `scripts/release-card-check.py` treats every applied optimization idea as a preregistered paired experiment. Section 2
  of the card must hold a `### Prereg <id>` block (endpoint, direction, producer, unit, mde and its source, sigma_d and
  its source, alpha, power, n_pairs, stopping, control) and a `### Result <id>` block of paired readings with load1.
  The checker recomputes the required n, drops VOID pairs (load1 delta > 2.0 or load1 > 0.75 × ncpu), computes the
  paired-t CI with the standard library, and accepts only SHIPPED (CI above 0 and mean ≥ mde/2; a deterministic count
  with sigma_d 0 ships when its difference reaches mde). New one-line refusals: `RELEASE_PREREG_MISSING`,
  `RELEASE_UNDERPOWERED`, `RELEASE_INCONCLUSIVE`, `RELEASE_NO_EFFECT`, `RELEASE_REGRESSED`. The v0.2.92 and v0.2.93
  cards keep their RELCARD1 verdicts and are not migrated. Grammar: `docs/release-rubric.md` ("Preregistration
  grammar").
- DEADLINETESTS1 (ompkit-fp72.120.16.265): per-test fixture deadlines in the deadline-ranked test files were re-measured
  against the full-suite verdict logs written after each file's last change (per-test durations joined to the
  file's load_1m, normalized by the `fixtureDeadlineS` load factor). Only bounds below 3× their p95 at load1 ≥ 18 moved:
  the `br-shim.test.ts` CUTCLAIM1 claim run goes from `fixtureDeadlineS(15)` to `fixtureDeadlineS(25)`, and its case
  budget from `fixtureDeadlineS(40)` to `fixtureDeadlineS(60)`; the `verify.test.ts` "LESSONPAYLOAD1 newest author
  lesson" case goes from the file default `fixtureDeadlineS(15)` to `fixtureDeadlineS(25)`; and the land fixtures'
  `git()` helper (`private-index-land.helpers.ts`) goes from the default 10 s floor to 20 s. All other bounds in
  br-shim, verify, portable-paths, heavy*, installer-bootstrap and private-index-land* already sit above 3× p95 and
  are unchanged. Planted hung-child refusals keep their bounded deadlines.
- RELREMEDY2 (ompkit-fp72.120.16.274): release-local's kit live-writer reconcile class no longer requires `.commands` to list `omp-kit update --reconcile <id> --yes`; the real updater lists only `omp-kit undo <id> --yes`, so the 0.2.93 install PARTIAL refused and needed a hand reconcile. The receipt still comes from `.data.receipt_id` and every other condition stays. Tests replay the recorded 0.2.93 updater JSON verbatim (planted reconciles, foreign-path control refuses, commands-condition mutant refuses).

### Fixed

- VERIFYABSPATH1 (ompkit-fp72.120.16.267): `omp-kit verify` no longer replays an acceptance command that names
  the verified repo by an absolute, `~`, `$HOME` or `${HOME}` path against the live working tree while the close
  reads "on export <sha>". Before each replay, `mapRepoPaths` resolves every such path token (following
  symlinks) and, when it lands inside the verified repo, rewrites it to the same relative path under the export;
  the log records `REPO_PATH_MAPPED <token> -> <export path>`. Paths outside the repo (system tools, other repos,
  sibling directories sharing a prefix) are left as written, as is the repo's own `.beads` tracker, which is
  live state read through the read-only br (REPLAYBR1), not committed code. A token whose export path would not be shell-safe is
  not executed: the box is UNJUDGED `REPO_PATH_UNMAPPED` naming the token, and verify returns ENVIRONMENT, never
  PASS. New VERIFYABSPATH1 cases: a live-pass/export-fail fixture with an absolute-path box reports REWORK; the
  relative-path control on the same commit reports the export's FAIL, and a committed passing script named
  absolutely still closes; the mutant (unmapped command in the export cwd) passes on the live tree.
- STAGE0WAKE1 (ompkit-fp72.120.16.276): kit-mail-wake now wakes the one seat a chief armed with
  `arm_seat --override-pause` under a paused project. The exception is read from the seat's latest arm_seat receipt
  (`goal-replacements.jsonl`, `override_pause`) and counts only when it is stamped at or after the current pause
  (the last `pauseHistory` row with `pullEnabled` false). Every other seat of the session stays `STOPPED_NOT_WOKEN`;
  a later receipt without the override, a receipt older than the pause, or a pause with no recorded start is no
  exception. The ledger row records `pause_override`.
- VERIFYTESTENV1 (ompkit-fp72.120.16.277): `tests/cli/verify.test.ts` no longer inherits the caller's identity.
  From a seat, its real-br fixtures reached the pane br shim and failed with `BR_SHIM_ACTOR_MISMATCH`
  (AGENT_NAME=PeachLeopard), `BR_SHIM_IDENTITY_REQUIRED` (AGENT_NAME unset) or `BR_SHIM_RESERVATION_UNKNOWN`. The
  file now drops every policy-script br from PATH, puts a fixture bin whose br is the official native br first, and
  binds AGENT_NAME to a fixture identity, restoring the caller's env afterwards. A mutant case shows that an
  inherited seat identity through `scripts/br-shim.sh` still reproduces the mismatch.
- VERIFYTESTENV1 rework: the file also drops the caller's tracker selectors (BEADS_DIR, BEADS_DB, BEADS_JSONL,
  BEADS_CACHE_DIR, BD_DB, BD_DATABASE, BR_REAL, BR_BIN, BR_ACTOR, BR_AGENT_NAME, BR_OUTPUT_FORMAT) for its run.
  Under `omp-kit verify` the replay inherits BEADS_DIR, and native br resolved every fixture `br init` to the
  caller's tracker ("Already initialized"), failing 16 cases. A second mutant shows that an inherited BEADS_DIR
  still sends the fixture's init to the caller's tracker.
- LANDPANETIMEOUT1 (ompkit-fp72.120.16.280): land's `am agents resolve-pane` now runs through kitlib's bounded
  synchronous runner under a 30 s base deadline scaled by the 1-minute load per core (factor 1..4, at most 120 s),
  instead of a fixed 10 s spawnSync timeout. A resolve-pane that does not answer in time is refused
  `OWNER_RESOLVE_TIMEOUT` with the deadline and a command to check; only a real "not registered" answer stays
  `OWNER_UNKNOWN`. Under load the old bound turned land tests (and real lands) into false `OWNER_UNKNOWN`
  refusals: 45 verdict-log cases, 33 of them at 10.09-10.35 s. `OMP_KIT_LAND_RESOLVE_BASE_S` overrides the 30 s
  base (integer seconds, clamped to 1..600) only when set.
- MINEPIDCOLLIDE1 (ompkit-fp72.120.16.283): the scratch-mine "one listing" test no longer fails when the OS gives
  the bun runner a pid of 60000..60039. Its 40 fixture owner pids were 60000+index, and `ownedScratch` charges a
  dir whose owner pid equals the caller's own pid, so a colliding runner counted 1 owned dir where 0 were expected
  (reproduced with process.pid pinned to 60005: 1 owned, `d5`). The fixture pids now start at 60000 and skip the
  caller's pid and its parent. New MINEPIDCOLLIDE1 cases pin the caller pid: at 60005 the listing still reads 0;
  at 59999 the original pids still read 40 then 0; with no exclusion, 60005 reads 1 (`d5`).

## [0.2.93] - 2026-11-05

### Changed

- RELCARD1 (ompkit-fp72.120.16.254, Joshua J-2026-11-05-03): `scripts/release-local.sh` now refuses a cut without a
  complete two-lane release card. `scripts/release-card-check.py` reads `docs/releases/v<version>.md` from the exact
  commit with git (never the working tree), before a prepare push and again on the source before the signing keychain
  opens. It refuses `RELEASE_CARD_MISSING`, `RELEASE_WAVE` (no closed or landed gap and no applied idea), or
  `RELEASE_CARD_INCOMPLETE section N` naming the rubric section: no shipped gap row (1), not 1-3 ideas or no idea
  applied with a measured `X → Y` (2), an empty Before for a DORA row (3), or no error-budget section (4). The grammar
  is documented in `docs/release-rubric.md` ("Card grammar"); the v0.2.92 card passes unchanged.

### Fixed

- PUSHADMIT2 (ompkit-fp72.120.14.4): `scripts/ref-txn-witness.py push-admit` now decides every writable ref a
  reviewed history plan rewrites, not only `refs/heads/main`. A backup ref's reviewed new root is the mapped
  counterpart of its public root and must agree with the plan's `new_roots`; pre-push members 40 and 41 admit exactly
  that push and still refuse an unmapped extra commit, a wrong new oid and a stale lease. A plan stops claiming a ref
  once origin holds its new root, so ordinary later pushes (main after the jev scrub) are judged ordinarily instead of
  refused. Reinstall the hooks in a repo with a reviewed plan copy (`install-commit-msg-bead.sh <repo>`).
- RUNTIMEMISS1 (ompkit-fp72.120.16.242): `full-suite-verdict-store.py require-pass` and `require-ci-only-pass` no
  longer read a verdict stored under another runtime id as a bare MISS. When the exact key misses but a valid record
  for the same tree and checks exists under another runtime, they print `RUNTIME_MISMATCH` with both env digests and
  the differing fields (version fields, and the PATH entry added when one entry explains the digest). It is never a
  PASS. When both verdicts read PASS or `RUNTIME_MISMATCH`, `scripts/release-local.sh` refuses with the mismatch
  instead of `VERDICT_STARVED` and starts no verdict run; a genuine MISS still starts one. `suite-metrics.py` exposes
  `runtime_parts()` and `environment_digest()`; `runtime_identity()` is unchanged.
- RELREMEDY1 (ompkit-fp72.120.16.246): when a kit update ends PARTIAL and every postcheck failure belongs to the
  kit's own live writers, release-local now reconciles the receipt itself. The live writers are `gate-events.jsonl`
  and `inbox-wake/*.json` under the state root, plus the state root overflowing the snapshot budget (20000 entries
  or 512 MiB per root). It also prints why each read failed: a live-writer race, or size. Any other PARTIAL still
  refuses, and the refusal now names the receipt in `omp-kit update --reconcile <id> --yes` and gives a runnable
  `update --apply --yes --version V --index <abs> --archive <abs>`. Both paths point at kept copies that outlive
  the work dir. 0.2.91 took 66 min from push to installed because the old remedy failed with
  LOCAL_SOURCE_REQUIRED.
- ROOTSHERMETIC1 (ompkit-fp72.120.16.271): `tests/cli/scratch-roots.test.ts` `fixtureHome()` now points
  `XDG_STATE_HOME` at an empty fixture state dir, so the earlier-list case no longer reads the machine's scratch-root
  registry. A root that `omp-kit scratch new` registered outside ~/Developer (~/.claude/var/agent-tmp) had turned the
  full suite red and blocked the v0.2.93 release train. A planted case proves an ambient registered root stays out
  under the fixture state and leaks in without the override.

## [0.2.92] - 2026-11-05

### Changed

- commit-gap-mention: sentences now split only on a period or semicolon followed by a space (or the end of the text). A sentence that names a dotted bead id such as ompkit-fp72.120.16.249, or holds a decimal such as 50.2 s, stays whole, so the gate no longer refuses a gap sentence that already names its bead. (ompkit-fp72.120.16.250)
- full-suite verdict: a red verdict now takes its failing suites only from the suite runner's own status rows. A passing test whose nested fixture printed `RED script-suite long.test.sh` into the combined log had put that phantom into every red verdict's failing list since 2026-11-04, hiding that the real reds were load timeouts. The list is built by `full-suite-verdict-store.py failing-tests`. (ompkit-fp72.120.16.252)

### Fixed

- `omp-kit verify` and `planning convert --dry-run` now resolve the official `br` as the first native `br` executable on PATH. Any `#!` script named `br` counts as a policy wrapper and is skipped. That covers the omp-kit pane shim and also grade_wave's grader dispatcher, which hands every call to the pane shim. The previous fix skipped only the pane shim, so inside a grader the REPLAYBR1 fixture `br create` still reached the shim and was refused with `BR_SHIM_RESERVATION_UNKNOWN` (SHIMRESOLVE1). A PATH whose only `br` is a wrapper still reports `BR_REAL_SHIM_ONLY`.
- `scripts/install-commit-msg-bead.sh --check` now exits 3 naming any kit chain runner (`pre-commit`, `commit-msg`, `pre-push`, `reference-transaction`) that the installer itself would upgrade, and a generated `hooks.d/pre-push/40-omp-kit-pushed-beads` wrapper whose bytes differ from what install writes. Before, a repo with fresh members but a pre-gate-events (v5) runner read fresh while every gate-event row was dropped. The runner generation marker is read from the runner's own bytes (`runner_body`), and install and `--check` share one predicate (`runner_stale`) and one wrapper generator (`pushed_beads_wrapper`). Bespoke runners are still never judged.
- The installer reads the runner generation and judges runners with shell builtins only, so `--check` under a restricted `PATH` (no `cat`, `sed` or `grep`) still exits 3 naming what is stale instead of dying with 127. A missing `grep` no longer reads every runner as fresh.
- The `omp-kit brief` scratch line and the `scratch new` help no longer teach `TMPDIR=$(omp-kit scratch new --label X --print-dir)` as the safe idiom. `--print-dir` prints no release capability. A dir made that way outside a seat could therefore be released by nobody and was left for the reaper (`caller-not-owner: no capability was presented`). They now teach a fail-closed form that keeps the capability: `S=$(omp-kit scratch new --label X --json) || { printf '%s\n' "$S" >&2; exit 1; }; TMPDIR=$(printf '%s' "$S" | jq -er .data.dir) || exit 1; CAP=$(printf '%s' "$S" | jq -er .data.capability) || exit 1; export TMPDIR`. Release with `omp-kit scratch release "$TMPDIR" --capability "$CAP" --bin throwaway --now`. Release authority is unchanged: another session without that capability is still refused `caller-not-owner`. A refused create still sets no TMPDIR, and its reason now reaches stderr (PRINTDIRCAP1).
- `scratch new` run from the top of a git repository that already holds `var/agent-tmp`, such as `~/.claude`, is no longer refused `scratch-root-unrecognized`. That applies even when the default root set does not name the repository. It records that root under `$XDG_STATE_HOME/omp-kit/scratch-roots`, so `scratch release` and the reaper find it from any working directory. Only the repository the caller is inside is recorded, and nothing is recorded while `OMP_KIT_SCRATCH_ROOTS` is set. A repository without `var/agent-tmp` and a directory outside any repository are still refused. A refused create now removes the empty `var/agent-tmp` or `var` it made.
- The fleet `UPGRADE_NOTICE` now tells a seat to restart only after every background task agent has returned and its result is collected (or the agent was told to wrap up and its report arrived). Before, it ordered a restart at the next turn boundary, and on 2026-11-05 the CFS director's restart aborted two running agents mid-work. The self-restart helper now refuses such a restart with `REFUSED_LIVE_AGENTS`, which the notice names.
- A grader's `br` reads no longer fail when a seat's PATH puts the pane `br` shim ahead of grade_wave's grader dispatcher. Before, the outer shim appended its own `--actor`, the dispatcher switched to the grader's identity, and the inner shim refused the call with `BR_SHIM_ACTOR_MISMATCH`, so `omp-kit verify` graded correct beads NOT_IN_REVIEW. Now, when the next `br` is a dispatcher that hands calls back to a pane shim, the outer shim passes the call through untouched. The inner shim then judges it once, under the dispatcher's identity. Any other next hop keeps the outer shim's full checks, so writes are still judged under exactly one identity (SHIMCHAIN1).
- The live suite's Python eval scenarios no longer fail at random on a loaded macOS host. OMP checks each `python`/`python3` on PATH under one shared 10 s budget. The first one found, `/usr/bin/python3`, is an xcrun shim that took up to 9.9 s to start cold, while the interpreter it launches took 0.03 s. When the check timed out, eval replied "Python backend is unavailable in this session" and never ran the cell, so near-miss scenarios reported `marker .ran_<id> absent: the command did not run (omp exit 0)` and ci-only failed. `scripts/e2e-live.sh` now resolves once, with a time limit, the interpreter `python3` launches, and sets it as each scenario's `python.interpreter`. A scenario still passes only when the cell writes its marker. (LIVEEVAL1)
- A failing live scenario's transcript now survives its run. With `OMP_KIT_E2E_EVIDENCE_DIR` set to an existing directory, `e2e-live.sh` copies each failing full-mode scenario's `log-<id>.jsonl`, `out-<id>.txt` and `mock-<id>.txt` into a fresh `e2e-live.<pid>` child, and the FAIL line names the copy. `run-ci-only` sets the variable, `test --full` passes it into its isolated run, and the copies are kept as `<record>.evidence` beside the ci-only verdict record, which the run's output names. A passing run keeps no evidence directory. (LIVEEVAL1)
- Test fixtures no longer make every `python3` child recompile its imports. Apple's `/usr/bin/python3` keeps bytecode under `$HOME`, and each hermetic fixture runs with a fresh `HOME`. So every fixture `python3` rewrote its `.pyc` files: 34 for the br create guard and 28 for the fixture-scope check, per call. Under load those writes took up to 18.5 s of one 23.2 s create. Fixture processes now share one bytecode cache per checkout, `<checkout>/var/pycache` (gitignored), through `PYTHONPYCACHEPREFIX`. It is set by the bun test preload, by `runFixture` for explicit fixture environments, by the br-shim hermetic fixture, and by `scripts/suite-hermetic-env.sh` in both of its modes. A caller's own `PYTHONPYCACHEPREFIX` is kept. A paired run of `tests/cli/br-shim.test.ts` used about 22% less CPU (PYCACHE1).
- The staged br-init check (`scripts/br_init_check.py`, pre-commit member 53-omp-kit-staged-br-init) can now read a command substitution that spans lines, such as `x=$(` followed on later lines by a `python3 -c '...'` body containing `"`, `%`, `)` or `#`, or a multi-line `jq` program. Before, it reported "unclosed command substitution" and refused every edit to the file, even a one-line documentation fix. On the shell files of both repos this clears all 44 such parse errors and adds no new findings. A substitution that still cannot be closed remains a parse error, and every line inside it is still checked on its own, so an unpinned `br init` there is still refused (BRINITSCAN1).

## [0.2.91] - 2026-11-05

### Added

- New `close-pass` service job (every 300 s, not at load) runs the unattended close pass from the fleet-watch.json `closePass` `{argv, cwd}`, never a kit path. Without the key, `omp-kit service install close-pass` refuses `CLOSE_PASS_UNCONFIGURED`, naming the key and the config path; `--plan` shows the configured argv and cwd. Each tick runs `omp-kit service run close-pass`, which holds the job's run lock for the whole pass. A tick that finds a pass still running starts no second pass, leaves the running one alone, and logs `close-pass SKIPPED-OVERLAP holder_pid=<pid>`, so a bead is never closed or commented twice.

### Changed

- The goal keepalive wake and the kit-flywheel-guard wait refusals (`NO_WAIT_REFUSED`, `WAIT_REFUSED`) now share one text (`constraintGuidance` in `extensions/kit-goal-keepalive.ts`). It leads with the seat's `CONSTRAINT` line read from fleet-watch: name, value/budget, clearing bead and its holder, or `CONSTRAINT none declarer=<lead>`, `INVALID` or `UNKNOWN`, and never an invented one. The next sentence lets a seat off the constraint with no pinned work send one NO-WORK line and end the turn. J-2026-10-29-18's "never idles" and "comment on the nearest bead" sentences follow. The never-wait downtime list, reality-check and "as a bead" are gone from every one of these texts, and from `GOAL_END_REFUSED`. In a refusal the constraint line is line 1 and the `kit-flywheel-guard <CODE>:` header is line 2. `gateFromReason` (`extensions/gate-events.ts`) now finds the header in the first three lines, so the gate-events ledger still records `WAIT_REFUSED`/`NO_WAIT_REFUSED`, not `CONSTRAINT`. (ompkit-774u.50.1)
- br-update-lint: an in_review `DONE <repo>@<sha>` handoff now accepts a fresh-gate GREEN recorded for the commit gate's candidate when `git cat-file -p` of the candidate and the landed commit are identical except for the committer's `<epoch> <tz>` (tree, parents, author line, committer name/email, signatures and message must match byte for byte). Version 2, rc 0 and complete evidence are still required; unresolvable rows and rows that differ in parent, tree, message or author/committer identity are refused. (ompkit-fp72.120.16.237)
- readme-check test: the load-bearing version-mutant case now plants into a README whose release line equals package.json, and checks that the real gate on the same file reports exactly the one version finding. The full suite's exported tree (`git init`, no tags) had judged the live README's published-release line as a missing tag and failed the case for a rule it never mutated. README size played no part. (ompkit-fp72.120.16.239)

### Fixed

- `release-notes.sh catch-up` now treats an entry as released only when an older section holds its exact text, every line included. Before, it compared only an entry's first line, so a fragment whose continuation line was rewritten after its cut (fp72.120.16.214) was listed for deletion, its new text was in no section, and the 0.2.90 notes check refused the commit. Such a fragment is now kept for the next release. (ompkit-fp72.120.16.231)
- The next-version advance in `scripts/release-local.sh` now promotes the released section from the fragments' bytes at the tagged source, not main's later copies. A fragment changed after the cut keeps its category line and only the entries the shipped copy lacks (whole entries compared exactly, every line included), so those notes ship in the next release; only fragments unchanged since the cut are deleted. The new `release-notes.sh residual --released FILE --current FILE` prints that remainder. (ompkit-fp72.120.16.235)
- The next-version advance no longer writes a literal commit sha into `package.json`'s `source_revision`. It read package.json through `git archive`, which applies `.gitattributes` export-subst and expands `$Format:%H$`; the manual 0.2.91 advance committed one and turned main red. It now reads package.json, README.md, CHANGELOG.md and the fragments as raw blobs, so the placeholder stays. (ompkit-fp72.120.16.235)

## [0.2.90] - 2026-11-04

### Changed

- On macOS, a kit update's isolated test (fast stage and ladder) now runs under a `sandbox-exec` write fence. The fence denies writes to `<state root>/composer`, `<state root>/full-suite-verdicts` and `<state root>/disk-stage/receipts.jsonl`, and denies renaming any directory above them. The postcheck reports a change there as `skipped-live-writer` only on that proof, and the report carries the fence profile and its sha256. A file's own content (a composer pid, a `.running.<pid>` path, a row pid) no longer counts as proof of who wrote it, so a leaking test that rewrites a seat's record fails. A test write the fence refuses fails with EPERM as the test's own failure. Without `sandbox-exec` (Linux), every change there fails. A requested fence never runs unfenced.
- The goal keepalive wake and the kit-flywheel-guard wait refusals (`NO_WAIT_REFUSED`, `WAIT_REFUSED`) now share one text (`constraintGuidance` in `extensions/kit-goal-keepalive.ts`). It leads with the seat's `CONSTRAINT` line read from fleet-watch: name, value/budget, clearing bead and its holder, or `CONSTRAINT none declarer=<lead>`, `INVALID` or `UNKNOWN`, and never an invented one. The next sentence lets a seat off the constraint with no pinned work send one NO-WORK line and end the turn. J-2026-10-29-18's "never idles" and "comment on the nearest bead" sentences follow. The never-wait downtime list, reality-check and "as a bead" are gone from every one of these texts. A refusal keeps its guard header as line 1, so gate-events still attributes the gate; the shared text starts on line 2. (ompkit-774u.50.1)
- The keepalive no longer wakes a seat whose last goal continuation omp suppressed as a repeat of the previous one. It records one `GOAL_REPEAT_SUPPRESSED` entry for the director instead.
- `MAX_QUIET_WAKES` now counts wakes whose turn made no state transition: a commit, a br status change, an ACCEPTED or REWORK comment, or an `omp-kit preflight`/`verify` run. A turn that only ran tool calls no longer resets the count.
- When the installed kit carries `omp-kit preflight blocked`, the wake names it for a held in_progress bead whose newest gate-events row is a refusal. Without the act, the line is omitted.
- Set CLI and OMP plugin version metadata to 0.2.90. The release is qualified on this prepare commit's exact exported tree before signing.
- A pasted brief now stays valid for 30 minutes after a landing supersedes it: the spawn check accepts the digest of HEAD or of a first-parent commit replaced within that window (at most 16 commits back), so a landing between `omp-kit brief` and the spawn no longer refuses the task. The window comes from 2026-11-04 data: the HEAD-bound digest lived a median 33 min, and 20 of 22 measured paste ages were inside 30 min.
- The brief digest now includes the kit release, so a brief from another release, or one taken before a gate member was reinstalled, is refused; the refusal names the current digest and states the window.
- When the close's checkout has no commit naming the bead, the prior-art check now looks in sibling checkouts that share the tracker: the git checkouts next to the close's cwd and next to the tracker's repo whose `.beads/beads.db` realpath equals the tracker db's. It scans at most 16 repos, each `git log` under the guard's exec timeout, caches the list per process, and uses the earliest commit found. A bead built in the companion but tracked in omp-kit now closes from either checkout. (ompkit-fp72.120.16.220)
- `ref-txn-witness.py review` now requires `--approval-message-id ID --approval-file PATH`, the Agent Mail APPROVE message the review relies on, exported as JSON (`id`, `from`, `subject`, `body_md`). The review is refused unless the id matches, the sender is the reviewer, and the subject or body names `APPROVE` and the plan's `plan_sha256`. The exact message bytes are stored read-only at `<git-common-dir>/omp-kit/history-review/<plan_sha256>.approval.json`. The self-digested review record (schema `omp-kit.history-review.v2`) binds `approval_message_id` and `approval_sha256`. The reference-transaction guard (`admit`) and the pre-push route (`push-admit`) share one check that re-verifies the stored message offline: an absent copy is refused as `REVIEW_APPROVAL_ABSENT`, a copy whose sha256 differs as `REVIEW_APPROVAL_DIGEST_MISMATCH`, and a copy from another sender as `APPROVAL_SENDER_MISMATCH`. No hook calls Agent Mail. Every plan requires an approval, so a v1 review record from before this change is refused as `REVIEW_APPROVAL_ABSENT`; run `review` again to recover. (ompkit-fp72.120.16.222)

### Fixed

- A lead whose pane is registered in another project can now mail under that project's key: kit-agent-mail-guard binds the caller's own Tern block by the one name its Agent Mail pane identity files give it once `am agents show` proves that name is registered in the target project, even when `register_agent` wrote no identity file there. A project where the name is not registered is still refused `IDENTITY_UNBOUND`, and the refusal now names the project and the exact `register_agent` remedy (project_key, name, pane_id). (ompkit-8bybq)
- `scripts/release-local.sh`'s verdict stage no longer waits up to two hours for a verdict nobody will run: each poll prints which commit the `release-verdict.sh` lock holder judges and what it queues next, and once the holder judges another commit while its latest-wins queue no longer holds the prepare commit (or no holder remains) the stage stops with `VERDICT_STARVED` and the command that produces the prepare commit's verdict, within one poll (at most 73 s). (ompkit-fp72.120.16.198)
- Kit fleet restarts no longer relaunch seats at omp's debug file-log level, which wrote every TTSR match (about 5 GB a day). `skills/fleet-restart/scripts/fleet_restart.py` `respawn_cmd` now launches `cd <cwd> && OMP_LOG_LEVEL=${OMP_LOG_LEVEL:-info} omp <flags>`; the pane shell expands it, so an operator's explicit level is kept. `check_cmd_flags` and the selftest fake respawn skip exactly that one assignment, so any other env token before `omp` is still refused. `tests/cli/fleet-restart.test.ts -t TTSRLOG1` proves unset -> info, `debug` -> debug, and that the line without the prefix leaves the level unset. (ompkit-fp72.120.16.203)
- kit-flywheel-guard (SCRATCH_OWED) and kit-save-guard (the session-stop disposal demand) now ask the scratch census as the calling session through a new `scratch mine|gate --session ID` flag. The flag overrides `PI_SESSION_ID` for attribution only, and a malformed id is refused with `SCRATCH_SESSION_INVALID`. An earlier build wrapped the call as `env PI_SESSION_ID=… omp-kit`; test stubs that matched `omp-kit` missed that form, so kit-write-ledger's AC3 read the runner's real scratch.
- `omp-kit land --patch` no longer reports `LAND_PUBLICATION_UNVERIFIED` for a push whose pre-push hook chain runs longer than 30 s: the publication push now has its own deadline, 2400 s by default (measured fresh-gate wall time n=510: p50 38 s, p95 257 s, max 1544 s), set with `OMP_KIT_LAND_PUSH_DEADLINE_S` (1..7200). A push still running at the deadline has its whole hook process group stopped, and the refusal names the deadline, the variable and the hook log saved under `.git/omp-kit/land-push/`. (ompkit-fp72.120.16.224)
- The commit and push fresh gate no longer refuses a correct tree because the seat's PATH starts with the omp-kit agent-bin br shim: `scripts/fresh-gate.sh` now drops that dir (and any dir whose `br` resolves to `scripts/br-shim.sh`) before any step or test child, printing `fresh-gate: PATH sanitized (removed …)`, through the new shared `scripts/kitlib-shimpath.sh` helper that `release-verdict.sh` also uses; the helper is part of the judged-file closure. (ompkit-fp72.120.16.226)
- Release archives now ship `scripts/kitlib-shimpath.sh`. `fresh-gate.sh` and `release-verdict.sh` source it, so a release without it refused every installed gate, and the ci-only `package-release` check failed on main. (ompkit-fp72.120.16.226)
- `scripts/release-local.sh` now refuses at preflight (exit 4, before any build, signing or publishing) when a previous kit update left a pending recovery receipt (`kit-update.pending.json` in the state root `omp-kit update` reads); the refusal names the receipt id and `omp-kit update --reconcile <id> --yes`, warns that reconcile is only for a false PARTIAL whose postimages verify, and never reconciles or writes anything itself. (ompkit-fp72.120.16.227)
- The installer now installs the paired commit-msg verification-level member (`hooks.d/commit-msg/41-omp-kit-commit-msg-vlevel`, new canonical source `scripts/commit-msg-verification-level.sh`, shipped in release archives). The installed pre-push member `41-omp-kit-pushed-vlevel` refuses every push while that paired member is missing or differs from its pinned bytes, and `--check` (both the member's and the installer's) reports either member missing or stale. A kit release reinstalling the pre-push member no longer drops the commit-time half of the rule that projects such as CFS already ran. The member also carries the GATE1-B selftest (a gate-deleting push is still judged by the installed member).
- Behavior change: installed projects now refuse commits whose subject carries no verification level at commit time. Before, the pre-push member refused them only at push, so this moves an existing rule earlier rather than adding one. (ompkit-fp72.120.16.228)
- A commit killed mid-hook no longer leaves `.git/index.lock` blocking every later commit. The stale-worktree commit-msg member now reaps its own commit's orphan lock on exit or on a fatal signal (STALELOCK1, taken in from CFS cfs-y4jwx so kit installs stop overwriting it). It clears a lock only when the git that started the hook is dead, the lock was not modified after the hook started, `lsof` shows no holder, no live git has its working directory in the tree, and the lock's identity is unchanged. Like `omp-kit scratch index-lock --reap`, it renames the lock aside to `index.lock.stale-<utc>` instead of deleting it, prints the evidence and appends a ledger row to `~/.local/state/omp-kit/index-lock-ledger.jsonl`. A lock held by a live process is left alone. (ompkit-fp72.120.16.229)
- The stale-worktree test no longer leaks its lock-holder fixture. Its holder was a `sh` that ran `sleep 60`; signalling the `sh` orphaned the `sleep` with its working directory in the test scratch, so `omp-kit scratch release` refused the scratch as held until the sleep exited. Each holder now execs down to one process that is reaped on every exit path, and a planted check proves no process with its working directory in the test scratch survives the STALELOCK1 cases. (ompkit-fp72.120.16.229)
- A release whose install stage refuses (as 0.2.88's and 0.2.89's PARTIAL installs did) no longer skips the next-version advance: once the public verify stage has proven the release published, `scripts/release-local.sh` still moves main to the next patch with that release's notes promoted, then exits 4 naming the install command; `release-notes.sh catch-up --base-tag vA --through-tag vB [--output DIR] [--next-version X.Y.Z]` rebuilds the missing `CHANGELOG.md` sections, one per tag, from each tag's own fragment bytes, reading only git objects and writing only to DIR; and the prepare stage starts `changelog.d/774u.md` again when an advance has folded it. (ompkit-fp72.120.16.231)
- The flywheel guard refuses copying a repository into scratch (CLONEGUARD1). A `git clone` with any flags (including `--shared`, `--reference`, `--local` and `--mirror`), or a `git fetch`/`git pull` of a local path, whose destination is inside a `<repo>/var/agent-tmp/<dir>` scratch is refused unless its source is in that same scratch. Forms wrapped in `cd`, `env`, `git -C` or `sh -c` are refused too, and so is a clone whose shell-expanded destination may land in scratch. The refusal names the alternatives: `omp-kit scratch new --export <sha>` for read-only work, a synthetic `git init` fixture for tests that need commits, or UNVERIFIED plus the command. `git init` fixtures and clones of a same-scratch fixture stay allowed. (ompkit-fp72.120.16.232)
- Network clones of external code into scratch (for prior-art reading) stay allowed. A clone is refused only when its URL matches the `origin` of a fleet checkout: the current repo or a git checkout next to it. `git@host:o/r`, `ssh://` and `https://` forms count as the same URL, ignoring `.git`, the user, the port and the host's letter case.
- A mail sent under one project's key to a live seat in another repo now wakes that seat when the seat's own project and session are enabled. kit-mail-wake judged every recipient by the mail's project key, so a lead mail to the CFS director sent under the omp-kit key matched the paused omp-test row and was persisted as `STOPPED_NOT_WOKEN` although CFS was enabled. A resolved seat is now judged by its canonical project (its configured chief row's repo, else its launch cwd), its launch cwd and its session; the mail key judges only recipients with no live seat. A seat whose own session row is paused, including a chief launched above its project, still stays `STOPPED_NOT_WOKEN`. (ompkit-fp72.120.16.234)
- In a repo whose hooks dir lies inside the work tree (`core.hooksPath=.githooks`), the hook installer now lists every path it writes (members, helper copies, kit chain runners) in one marked `info/exclude` block. It writes the block only after its probes pass and removes it on rollback, and `--check` verifies it. A refresh no longer leaves dozens of kit copies that the project's own staged gates refused as new code. No staged gate skips anything: tracked repo-owned members, adaptations and force-added copies are still judged. `kit-update` reports `PENDING_COMMIT` only for refreshed members that are still tracked. (ompkit-v66l.22.3)
- The staged-README commit check no longer crashes in a repo that has a README but no omp-kit command registry (`Cannot find module …/src/commands.ts`, which refused CFS commits). Each README rule now runs only where the tree declares its inputs; each undeclared rule prints one `NOT_APPLICABLE` line. A repo that ships its own `scripts/readme-check.ts` keeps every rule and input required, and the worklog, checkbox and readme-update checks still judge every README. (ompkit-v66l.22.3)
- `save`'s moved-origin and failing-hook cases re-run `omp-kit save` only on the 10 s `am` owner lookup's pre-mutation `OWNER_UNKNOWN` refusal within a load-scaled budget, and assert each refused run's save-log row; every other answer is asserted as before. (WALLCLOCKFIX1)
- `heavy-observers`' stalled-sbh case re-runs the observation only when its freshly written stub never recorded its process group before the observer deadline, within a load-scaled budget; every observation must still time out within twice the deadline, in its own process group. (WALLCLOCKFIX1)

## [0.2.89] - 2026-11-04

### Added

- bead-lint check p-pitfalls (BEADPITFALL1): the create and update gates refuse a kind:fix or kind:feature bead created at or after `PITFALLS_CUTOVER` when its description has neither a Pitfalls section with at least one concrete item nor the owning repo's `omp-kit-brief: <repo> <sha256>` line. The refusal names the missing section and the fix. Build beads created before the cutover get a PITFALLS_LEGACY warning from the update gate and are never refused.
- `omp-kit scratch new --label X --print-dir` follows mktemp's contract: it prints only the absolute owned dir and exits 0, or prints nothing on stdout, the reason on stderr, and exits nonzero. Set TMPDIR fail-closed with `TMPDIR=$(omp-kit scratch new --label X --print-dir) || exit 1; export TMPDIR`. The old idiom `export TMPDIR=$(omp-kit scratch new --label X --json | jq -r .data.dir)` turned a refusal into the path `null` (135 MB and 39 MB written to /Users/josh/Developer/null on 2026-11-04), and `export TMPDIR=$(...) || exit 1` is not fail-closed either, because export's own status is 0. The capability is not printed; release by the owning seat, or use `--json` to keep it. `--print-dir` and `--json` are exclusive. The `--json` shape and its refusal exit code (2, already nonzero) are unchanged. The brief contract and `omp-kit help scratch new` teach the new form. (ompkit-fp72.120.16.194)

### Changed

- Set CLI and OMP plugin version metadata to 0.2.89. The release is qualified on this prepare commit's exact exported tree before signing.
- The task brief guard no longer refuses a task because of words inside a pasted `omp-kit brief` block. Text such as `THIS REPO: - the ...` or `per-repo: any` in hook descriptions is no longer read as a checkout path, which had caused `LOOKUP_REFUSED ... lstat '<repo>/-'`.
- A `Repo:` or `--repo` label now names a target only when it is an absolute path or an existing relative directory, and trailing commas or periods are trimmed. Words such as `the`, `its` or `fails` are ignored.
- If a named target cannot be resolved, the guard checks the session checkout as it does when no target is named. A real checkout named without its brief marker is still refused with `BRIEF_CONTRACT_REFUSED`.
- The prior-art close check (PRIORFORMAT1) accepts a `prior=` line whose first URL or path:line citation is followed by more sources or notes before `did=`, and its "timestamp unavailable" refusal names the fix when the work landed in another checkout that shares the tracker.

### Fixed

- `omp-kit mine` (OBSHOOK1) no longer reports the agent's own failed bash commands as guard failures. The observational hook records each non-zero bash exit as `bash_failure`, and the CC collector stores it as an `observational-hook` decision `failure`. The miner charged each one 1 minute as "Guard engine failed to observe" (6142 October rows, 5632 of them in omp-kit), although the call's failed tool span already counts the same command failure. These rows now rank in no class. They are counted in `excluded_inputs.duplicate_events` under `observational-hook-bash-exit`, with citations, and shown in the quarantined-telemetry section. Rows sharing one `tool_call_sha` (the same call re-ingested from a resumed or forked session file) count once, in ephemeral and resumable runs alike.
- A hook that itself errors is reported as `guard-failure:<engine>:<hook>` with its first error, and its enforcement is to demote the hook under the guard lifecycle (R49). This covers the observational hook and the collector's new `guard-rule`/`harm-rule` failure rows, whose `rule` carries the error's class name. Failures from other guard engines are classified as before.
- `omp-kit verify` and the tests that need the official `br` no longer pick the omp-kit pane shim from a seat's PATH. The resolver skips a `br` whose directory is the kit's agent-bin dir or whose realpath is `scripts/br-shim.sh`, and when the shim is the only `br` it reports `BR_REAL_SHIM_ONLY` instead of returning the shim. Before this, verify replays through the shim hung or were refused (SHIMRESOLVE1).
- A background `task` agent could no longer tell its own scratch from the lead's or a sibling's. Every agent runs inside the lead's omp process and shares its agent name, session leases and process ancestry, so each one's `scratch mine`, SCRATCH_OWED advice and seat-authority release reached every live dir of the seat. On 2026-11-04 this destroyed five live dirs, including the lead's kernel TMPDIR, which broke a push (SCRATCHSIBLING1, ompkit-fp72.120.16.214). The kit now tells the incarnations apart:
  - `scratch new` records the creator's own omp session as `creator_session`. omp passes it to tool shells as `PI_SESSION_ID`; eval kernels carry it in `PI_SESSION_FILE`.
  - `scratch mine` and `scratch gate` list such a dir only to its creator. The seat's main session also sees the dirs of an agent whose lease is no longer held.
  - A seat release of a dir that another incarnation made, while that incarnation's lease is held or cannot be proven free, exits `SCRATCH_RELEASE_SIBLING_LIVE` unless that dir's `--capability` is given. Once the creator's lease is free, the seat releases it as before.
  - kit-flywheel-guard (SCRATCH_OWED) and kit-save-guard (the session-stop disposal demand) ask the census as the calling session.
  - A dir with no `creator_session` keeps today's seat authority unchanged.
  - The open-file and `.users` checks are unchanged.
  - `scripts/br-fixture-scope.py` accepts the new key.
- A seat restart no longer leaves `/goal resume` or another typed line unsubmitted in the composer. `respawn_seat.py` waits after each paste until the composer reads back the pasted line, and only then presses Enter. It proves the line was submitted from the session file and an empty composer. If the first Enter is lost and the composer still holds exactly that line, it presses Enter once more. A composer holding anything else gets no more input. Every unproven end mails the lead and raises a desktop notification. The `kit-composer-state` record gains additive `sha256` and `chars` fields that let the helper check the composer holds its own line. The record still never carries the composer text.
- Releasing a dir earlier without a bin, then running `omp-kit scratch release DIR --bin X --now`, used to answer ok with `deleted: false` and keep the dir. The bytes then waited out the quarantine TTL. On 2026-11-04 those bytes were an 824 MB clone holding raw private objects (RELNOW2, ompkit-fp72.120.16.216). Now that later `--now` records the bin in the marker, together with its reference once verified, and retires the dir through the same rechecks as a first `--now`. Anything that blocks it exits `SCRATCH_RELEASE_HELD` with the reason. A bin or reference that conflicts with the recorded one is held as `now-held-bin-mismatch`, naming the recorded bin. A dir that no longer exists is refused as `directory-gone`. `--now` never reports success without deleting.
- The pre-push members 40 (pushed-beads) and 41 (pushed-vlevel) now admit the push of an applied, independently reviewed history rewrite of main instead of judging every rewritten counterpart of already-public history as new. `ref-txn-witness.py review` also stores the reviewed plan read-only at `<git-common-dir>/omp-kit/history-review/<plan_sha256>.plan.json`. A member finds the plan from the pushed tip alone, never from an environment variable or caller map, and asks the new `ref-txn-witness.py push-admit`, which reuses the witness's own plan, review and transform checks. The push is admitted only when the tip is the plan's new main, the remote sha is the reviewed public main (a moved origin is refused as `STALE_LEASE`), local main already equals the new root, every preservation ref holds its original, the review record verifies with its unchanged binding, and the reviewer is not the pusher (`AGENT_NAME` is required). The member then judges its own range minus the mapped counterparts with its ordinary check. A repository with no reviewed plan copy runs no witness, so ordinary pushes behave exactly as before.
- Three more suite cases no longer fail on a loaded Mac. `kit-commit`'s TERM-killed GITLOCK1 case waits for the hook's `index.lock` within a load-scaled bound instead of a fixed 10 s, and its hook holds the lock three times that long. `preflight`'s portable BR_REAL claim case and five `private-index-land-2b` land cases re-run only the answer that a fixed product deadline produced (the 3 s claim tracker read's `failed (timeout)`, the 10 s `am` owner lookup's pre-mutation `OWNER_UNKNOWN`) within a load-scaled budget; every other answer is asserted as before. (WALLCLOCKFIX1)
- Four more suite cases no longer fail on a loaded Mac. `private-index-land-3b`'s lost-publication case re-runs land only on the 10 s owner lookup's pre-mutation `OWNER_UNKNOWN` within a load-scaled budget; `scratch-incarnation`'s large-tree SCRATCHLSOF1 case gives real `lsof +D` a load-scaled deadline; `commit-preflight.test.sh`'s six-finding timing bound scales with the load factor; and `ergo1-r-006`'s exit-42 case pins `heavy`'s admission load through `OMP_KIT_HEAVY_FAKE_LOAD1`, with a planted overload proving `--no-wait` still refuses 75. (WALLCLOCKFIX1)

## [0.2.88] - 2026-11-04

### Added

- `commit-preflight --tests FILE...` runs the named test files in the verdict's shape: an exact `git archive` of HEAD with the `--files` overlay, no `.git`, a long TMPDIR under the export's `var/agent-tmp`, each file through `heavy`. A failing file is `REFUSED EXPORT_TEST_FAILED FILE`; without `--tests` behavior is unchanged. (ompkit-fp72.120.16.157)
- `tests/cli/fixture-long-path.test.ts` runs the literal `commit-preflight --files tests/cli/fixture-long-path.test.ts --tests tests/cli/fixture-long-path.test.ts` in a fixture repository: a planted test that passes in the checkout but overflows a long-TMPDIR bound in the export is refused (rc 1, `EXPORT_TEST_FAILED`); the same file without the bound is clean (rc 0). (ompkit-fp72.120.16.157)

### Changed

- Set CLI and OMP plugin version metadata to 0.2.88. The release is qualified on this prepare commit's exact exported tree before signing.
- `scripts/e2e/planning-share-name.sh` allocates its scratch through `kitlib_tmp.owned_tmp`, which removes it at exit; it no longer writes its own bare-pid `.owner` or leaves a directory behind each run, and its totals line no longer prints a scratch path.
- release-local now cuts `origin/main` as is when it already states the release version, and after a release is public it commits the next patch version and the release's changelog section to main, so a green main commit can be released with no bump commit. A run that fails before publishing commits nothing. (NEXTVERSION1)
- README's `Current release:` line always names the latest published release. Between releases, when `package.json` already states the next patch, the README check accepts the line only while that release's tag exists, and fails closed when tags can't be read. The release's next-version commit stamps README to the version it just published. (NEXTVERSION1)
- release-local makes the next-version commit after installing the release, so the hooks it just installed judge it. With `--no-install`, a refusal from the older installed hooks names the install command to run first; hooks are never bypassed. (NEXTVERSION1)
- The next-version commit is made on the shared main in the checkout with `git commit --only`, never in a worktree. It refuses with `NEXT_VERSION_PATHS_DIRTY` when a path it would write has uncommitted changes, and publishes through git_converge.py when origin moved during the release. (NEXTVERSION1)
- QRELEASED1 (ompkit-fp72.120.16.103): an expired quarantine entry the policy deletes first gets owner rwx on its own dirs (lstat only, symlinks never followed), so an unreadable 000 subdir no longer fails the `lsof +D` proof closed; every kept or skipped expired entry now logs one `quarantine-keep` reap-log line with its reason.
- TOOLPIN1 (ompkit-fp72.120.16.148): add `omp-kit infra upgrade-plan --tool NAME [--pin-plan TEXT]`, which lists every fleet repo pin of a tool (`.bun-version`, `.node-version`/`.nvmrc`, `.tool-versions`, `package.json` engines and packageManager, RCH `--require-tool`, rust-toolchain) and its installed Homebrew dependents, and refuses naming each pin the bump plan does not cover; and `omp-kit infra upgrade-verify --tool NAME`, which starts every dependent keg binary after the upgrade and names each that no longer starts.
- Fix stale index-lock reaping blocked by git network helpers or read-only commands: HELD now identifies a live open-file holder or index writer by pid and command. The report also lists orphaned network helpers older than 30 minutes with their start time, without killing them.
- `omp-kit brief` fingerprints source checks (`scripts/check-staged-*.sh`, `fresh-gate.sh` and their helpers) from HEAD instead of the working tree, so peers' uncommitted edits no longer change the digest and refuse spawns; installed hooks are still read as installed.
- Build-task brief checks admit tasks that declare no change (`Change: None` line or a `# Change` heading followed by `None`) without a contract marker.
- Brief `Comply:` lines now come from each member's own `Fix:`/`Comply:`/remedy text or the `(use ...)`/`; rerun ...` clause of its `REFUSED:` messages; the generic "read and satisfy" line remains only for members with no remedy text.
- The brief's preflight rule names `--tests <changed test files>`, and a DONE handback that lists changed `src/`, `tests/`, `extensions/` or `*.test.*` files must show a 0 refused/unjudged preflight line reporting at least one export test file run.
- Command-center `action.result` rows for a verb that fails with no `errors[]` now carry the verb's declared exit class (`FINDING` for exit 1, `USAGE_OR_BLOCKED`, `UNAVAILABLE`, `RETRYABLE`, `NOT_RUN`, else `EXIT_<n>`) instead of `HANDLER_FAILED`, so a doctor that answers FAIL (for example `doctor --scope stale-worktree` on a dirty tracker export) is no longer recorded as a handler crash. `HANDLER_FAILED` remains the code of a thrown handler. `heavy` records its child's status as `EXIT_<n>`.
- `omp-kit mine` names a failed record by its own contract code: a `FINDING` row is class `finding:<surface>` (with a route-and-resolve enforcement line), any other code is `tool-error:<surface>:<CODE>`. Only failures with no code stay `tool-error:unclassified`.
- `omp-kit mine` no longer aborts a whole `--all` run when one project/day/source cell's result exceeds the 8 MiB ledger file bound (`MINE_LEDGER_RESULT_LIMIT_OR_INVALID`). The cell keeps its summary in part 0 and stores its findings in bounded sub-cells committed with one manifest write; resume reassembles them, and a missing or stale part rescans only that cell. A finding or summary too large for any sub-cell is omitted and the cell is recorded PARTIAL with the reason, and the run continues to later cells and projects. The per-file bound is unchanged, and cells that fit are written with the same receipt bytes and manifest keys as before.
- `kit-no-force-push` (fleet pack) fires only on `--force` inside a `git push` command; global options such as `-C` may come before `push`. The October 2026 friction sample labeled all 10 fires false: each was `br close`/`br update --claim` with `--force`, or `--force` inside an Agent Mail or bead comment body. Those 10 labeled inputs now stay quiet. Plain, tab-separated, line-continued, `-C` and `-f` force pushes still fire, and so does a `git push --force` or `git push -f` that follows a JSON-escaped newline or tab (`pwd\n\tgit push --force`), the RX2 shape the first narrowing missed. New corpus rows in `cases/cases-fleet.tsv` and new live scenarios `force-push-global-option-fire` and `force-push-br-force-near` pin both sides. Shipped rule text sha256 `80b9069fcf4bf9700f91418b51fe9042ac23a19f7ff7b6c50ad5b23464df00f9`; rollback to the pre-narrowing text, sha256 `103d683ec251f0493e0e0bd90258729eb5b4b161137ba39d1e4f1540c0adf102`. (ompkit-fp72.120.16.169)
- `kit-tool-result-is-not-json` is retired to `retired/`, with its reason in `retired/REASONS.tsv`. The friction sample labeled 13 of 13 fires false. Each was `JSON.parse` on a file, an environment variable, stdin, subprocess stdout or an HTTP response, which is the form the rule itself recommended, and the `JSON.parse` token cannot tell those inputs apart from tool-result text. The runtime loop guard still covers the measured 2-hour loop. Rollback: rule text sha256 `e89a5c5f54e34a8f81d7b07e541a62135ab275d346552f5a1366994dcdeb6c8b`. (ompkit-fp72.120.16.169)
- The Agent Mail guard now admits a Tern seat sending under another project's key when that project's own pane identity file binds the seat's live block (`<sha1(project)[:12]>/tern-<block>`, the file `resolve_pane_identity` reads), even if the seat's cwd is outside that repo. Before this, a lead running in `~/Developer` was refused `IDENTITY_UNBOUND` for every send under an opted-in recipient repo's key, even after registering there. The block must still be the caller's own live session. A binding on another block, or a block whose session has ended, is still refused `IDENTITY_UNBOUND`, and a configured chief row for the project still pins the name.
- GROUPREAP1 is withdrawn from this release. Its companion runner change (2b7a914010, with repairs c52e0a58f9 and 2c4cc2bc10) broke three suites on main: the stale embedded installer, the reaped orphan-process fixtures, and private-index-land-3c, where a compiled binary's `run()` could not find `scripts/pysafe.py`. `scripts/pysafe.py`, `src/kitlib/run.ts`, their tests, the orphan-reap helper and `installer/install.py` return to their a1e73e0840 bytes. The publisher side, which has `git_converge.py` and `publish_tracker.py` run under `pysafe.run_main`, is in omp-kit and stays. The reaper relands as one commit after a full run of every affected suite.
- Require a close lesson before verification replays: use `--lesson TEXT` or the implementing author's newest `Lesson:` comment, and carry it into ordinary and live-readback close transitions. Report refused tracker acts as `ACT_FAILED`, preserving captured stderr and distinguishing guarded acceptance restoration from refused or unproven restoration; genuinely failing replays remain `REWORK`. Tracker acts remain non-atomic: a failed restoration does not guarantee unchanged acceptance boxes.
- `br` close and in-review transitions validate each cited commit against a freshly fetched `origin/main` in its source repository; citation-free transitions continue to the existing guards. `omp-kit verify` and DONE callbacks remain fail-closed for unresolved cited commits; callbacks check plain SHA citations in the recipient project and absolute `repository-path@SHA` citations in the named source repository.

### Fixed

- The reference-transaction bead guard can now admit one exact, independently reviewed history scrub instead of judging every rewritten commit as new. Before, it read thousands of rewritten id-less commits until the history helper's 30 s prepare deadline ran out (GIT_REF_TRANSACTION_TIMEOUT, 2026-10-17). When a history operation's owner record holds the index, the new reader `ref-txn-witness.py`, installed beside the guard, admits the update only if four things match exactly. The first is the operation's own context: its owner lock, its prepare intent, and the Git child the hook runs under. The second is the digest-bound plan. The third is a read-only review record written by a reviewer who is not the applier (`ref-txn-witness.py review --plan P --reviewer NAME`). The fourth is the transform re-derived from the Git objects: the complete map, consistent parents, unchanged messages and metadata, only the allowed paths removed, and no borrowed signature. Commits gained outside the map still get the unchanged bead-id check. No environment variable, caller map or origin ref grants admission. A missing reader refuses only that operation, and ordinary commits behave as before. (ompkit-2w7h.3)
- The full-suite verdict now refuses up front (exit 2, `FULL_SUITE_SHIM_PATH`) when the omp-kit agent-bin `br` shim is first on PATH, instead of recording a false red verdict; `release-verdict.sh` removes the shim dir from PATH before judging, so the publisher's automatic verdict keeps working from a seat.
- A seat that only filed a bead can now record its close when a different seat is assigned and a non-author verification record exists: an `omp-kit verify` comment, or a PASS/VERIFIED comment by someone other than the assignee and DONE authors that names `export <sha>` and every acceptance box. The newest verification comment decides: a later FAIL, REWORK or PENDING comment, a current rework status, or a move to rework after the record withdraws it. A record the closer posted itself must name a distinct verifier as `by <Name>` (not the closer, the assignee or a DONE author), and the close reason must cite that verifier and disclose the verifier family. The assignee, DONE authors, and the filer of an unassigned bead are still refused under SELF_CLOSE_REFUSED (AGENTCLOSE1, standing law C3).
- TMPCANON1 (ompkit-fp72.120.16.142): `tests/cli/brief.test.ts` compares the `omp-kit brief` marker with the canonical repo path, so the suite passes with the macOS default TMPDIR (`/var` → `/private/var`); its fixtures now live under a symlinked parent so a missed canonicalization fails on every host.
- Releases now ship every file their hook installers copy or run. The package list is derived from each shipped installer's manifest rows and kit-root paths, and packing refuses an installer reference to an unshipped file (`INSTALLER_REFERENCE_UNSHIPPED`). 0.2.86 and 0.2.87 omitted `check-deploy-step.sh`, `check-red-main.py`, `pre-commit-storage-root-gate.sh` and the gate-event data files, so installing hooks from those releases stopped partway.
- A Tern-managed OMP launcher now resolves to the kit's verified exact-version source cache even when a same-version `@oh-my-pi/pi-coding-agent` is installed bun-globally. The resolver and `verifyTernOmpSource` share one selection, so the source the resolver picks is the one verification accepts. Before, a bun-global upgrade to the Tern version made native-matcher tests fail with `OMP_IDENTITY_MISMATCH` and turned release verdicts red.
- `scripts/release-local.sh` now installs the release it publishes when its work dir sits under a symlinked parent (macOS TMPDIR is below `/var` -> `/private/var`): the install stage hands `omp-kit update --apply` the physical (`pwd -P`) index and archive paths, which the updater requires (`UNSAFE_KIT_SOURCE`). The preflight heavy admission probe now asks with `OMP_KIT_DISK_OBSERVER=statfs`, the observer the ci-only stage it predicts uses, so an sbh pressure reading no longer refuses a release that stage would admit; heavy's 10 GiB floor still refuses (ompkit-fp72.120.16.155, ompkit-fp72.120.16.154).
- fleet-guard now refuses system-temp writes (`fleet-guard system-temp`) in every session, seat or subagent, whether or not the calling directory has the `.omp/fleet.json` opt-in. Before, a session outside an opted-in repository (a background subagent in `~/Developer`, or one whose cwd was `/tmp`) got only the plutil check, so `mktemp -d /tmp/x` and `git clone <repo> /tmp/x` passed. Refused targets resolve under `/tmp`, `/private/tmp`, `/var/tmp`, `/private/var/tmp`, `/var/folders` or `/private/var/folders`: write/edit paths, redirects, `tee`/`mkdir`/`cp`/`mv`, `git clone` and `git worktree add` destinations, `rsync` destinations, `tar -C` extraction roots and created archives, `$TMPDIR/…` targets, and the directory an executed `mktemp` allocates under. The refusal names the remedy, `omp-kit scratch new --label <x> --json`. Reads of system temp, writes to repository `var/agent-tmp` and `omp-kit scratch new` stay allowed.
- The kit-update journey tests no longer turn main red on host load (KITUPDATELOAD1). Their candidate now carries a minimal real corpus: four rules with one fire and one near-miss row each, the admission guard pair and the e2e plant. Every ladder stage still runs. A candidate that carries the full tree is refused by a row-count bound before any timing. The full corpus stays judged in package-release-live, the full suite's e2e and native certification.
- `run-ci-only` runs its files one at a time instead of side by side, so its ladders no longer overload the host.
- A failed update postcheck now lists the failing stage's `FAIL  <id> :: <verdict>` lines and the regex-budget stream summaries in `postcheck_detail.failures`, so it names the failing scenario.
- CONTENTION1 (ompkit-fp72.120.16.172): fleet-guard now refuses, in every session, a bash call that starts an unbounded busy loop (`while :; do :; done`, `while true; do :; done`, `yes > /dev/null`, `cat /dev/zero > /dev/null`) unless it runs as `omp-kit heavy --label <x> -- timeout <s> nice -n 19 <cmd>`, and refuses any fan-out of more than ncpu/2 busy-loop copies even inside heavy. The refusal names that form and that heavy admits only while load1 < ncpu. Ordinary `while read`/`for f in *` loops are unaffected.
- The full-suite verdict store no longer refuses true work under load (STOREDEADLINE1). `checked_run` scales every deadline by the test fixtures' load factor (`clamp(load1 / ncpu * 4, 1, 4)`, as `fixtureLoad()` computes it), and its refusal now names the kind: `TIMEOUT after Ns (load L)`, `EXIT rc` or `OUTPUT_OVERFLOW`. A 16 s subcommand at a simulated factor of 3 completes; a hung one is still killed at its scaled deadline and named TIMEOUT.
- The regex-budget stream gate no longer turns red on a slow host alone (REGEXREF1). Each sample times a frozen reference (the `kit-no-gh-poll` conditions over a pinned wire, `scripts/fixtures/rx-reference-*`) beside the rules and scales both 500 ms stream budgets by `clamp(ref_now / ref_calibrated, 1, 8)`; the live and write/edit summary lines print `ref_now`, the ratio, `budget_ms` and a tracking check. A pass that only the scaled budget allows also needs the unchanged rules' own slowdown to agree with the reference within 1.6x, else it reports `INCONCLUSIVE`. A missing, NaN or 0 ms reference fails with a named reason, a ratio above 8 exits 75 as `INCONCLUSIVE` instead of passing, and a planted slow rule still fails on any host. `sh scripts/regex-budget-slowhost-evidence.sh` reruns the slow-host cases under `taskpolicy -c background` on demand. The stream total is now the sum of the per-rule medians, so `by_rule` sums to `total_ms` as `apply plugin --regex-budget-report` requires. `ladder.sh` no longer passes the two arguments the script ignored.
- `full-suite-verdict.sh --repo .` (a relative repository) now runs the suite instead of ending RED with no evidence after its chdir (VERDICTREPOABS1). The repository argument is resolved to an absolute physical path right after argument parsing, and a missing one is refused with `--repo PATH is not a directory` (exit 2) before any suite runs.
- `tests/cli/installer-bootstrap.test.ts` no longer fails all nine tests at random with `git: unknown option: -I` (rc 129) (HERMPATH1). On macOS, `/usr/bin/python3` and `/usr/bin/git` are one inode: about 78 hard links to an xcode-select stub that chooses its tool from argv[0]. `realpathSync` of a hard link can return the name of any sibling link. A probe primed with git saw `realpathSync('/usr/bin/python3')` return `/usr/bin/git` in 5 to 11 of every 200 calls. The test now asks the `python3` found on PATH for its own `sys.executable` and requires that exact path to run as Python 3. Anything else stops the file at load with `INSTALLER_TEST_PYTHON3_UNRESOLVED`. The full-suite runner gives each bun file its own process, so no other test file could leak PATH into this one.
- A build task can no longer start on a bead that has no prior-art comment. When a `task` spawn's brief has a Change section or reserves paths and names a bead id (dotted ids included), kit-flywheel-guard reads the bead through the same bounded tracker read the close check uses and refuses with `PRIOR_ART_SPAWN_REFUSED` unless a comment passes `validPriorArtLine`; the refusal names the fix, `br comment add <id> "prior=... did=... applied=..."`. A tracker that cannot answer refuses. Verification, diagnosis and replay briefs mark themselves `no-edit: verify|diagnose` and are admitted; `omp-kit brief` now teaches this step. Before, the citation was only checked at close, so verified work with no earlier citation could never close. (ompkit-fp72.120.16.192)
- `commit-preflight --tests` now uses the verdict's export layout, so it no longer refuses tests the gate admits. The export is a `git archive` of the HEAD commit with `package.json` `source_revision` stamped, the judged bytes overlaid, and a fresh `git init -q`. It lives under the repository's `var/agent-tmp` and records HEAD plus the overlay in `.git/omp-kit-export.json`. Each file runs through the gate's own runner (`suite-metrics.py stage`, bun `--timeout=120000`) under `heavy`. The long TMPDIR stays. (ompkit-fp72.120.16.195)
- A change to a shared runtime (`scripts/pysafe.py`, `scripts/kitlib_run.py`, `src/kitlib/run.ts`) is now a FULL plan. `scripts/affected-tests.ts` selects every test file and writes `FULL <trigger>` to `--status-out`. The push and commit gate (`scripts/fresh-gate.sh`) prints `FRESH-GATE: PLAN FULL` and admits only an exact-tree main-role full-suite PASS; without one it refuses with `reason=FULL_SUITE_REQUIRED` and names `sh scripts/full-suite-verdict.sh --repo ROOT --commit SHA --judge-role main`. It never budgets or defers a FULL plan. The GROUPREAP1 push ran 4 files and deferred the rest of its selection to CI, which was paused, so three suites broke on main. (ompkit-fp72.120.16.197)
- When the wall budget defers selected tests and `.github/workflows/ci.yml` is not active (its state is read through `gh api`), the gate prints `FRESH-GATE: DEFERRED_TO_PAUSED_CI: N files (ci.yml state=...)` under the PARTIAL verdict, and the GREEN line carries the count and the list. A deferral is no longer read as tested. (ompkit-fp72.120.16.197)
- Generated embeds are dependencies. `installer/embed-bootstrap.py` declares `EMBEDS` (output to inputs) as JSON data and generates from that same map; `--list` prints it. The selector counts a change to an input as a change to its outputs, so a `scripts/pysafe.py` change reaches every test of `installer/install.py`. The new pre-commit member `scripts/check-staged-embed.sh` (`56-omp-kit-staged-embed`) runs the staged producer's `--check` on the index and refuses a stale output, naming `python3 -I installer/embed-bootstrap.py`. (ompkit-fp72.120.16.197)
- A rule file change selects the suites that load that rule: tests that call an exported `loadRule*` loader and name the rule id (rx2-rules, echo-literal-rules), and the sources that load the whole pack directory together with the tests that run them (ttsr-harness). A path given as quoted segments, such as `join(root, "scripts", "ttsr-harness.ts")`, now counts as naming that path. (ompkit-fp72.120.16.197)
- The br shim no longer treats help as a tracker write. `scripts/br-shim.sh` now runs the real br before any identity, Agent Mail or reservation check when the argument list is exactly help or version output: `--help`, `-h`, `--version` or `-V` alone, `help` or `help <sub>`, and `<sub> --help` or `<sub> -h`. Before, `br update --help` exited 4 (`BR_SHIM_RESERVATION_UNKNOWN`) in any clone Agent Mail had never seen, so prompt_lint T1 in the `~/.claude` storegate refused every orchestration commit made from an export. Lists that also carry a subcommand's real arguments, such as `br update X --status open --help`, keep the ordinary refusals; `br list --json` without `AGENT_NAME` still exits 4 `BR_SHIM_IDENTITY_REQUIRED`. (ompkit-kup44.9)
- Three test files no longer fail at random under machine load (32 cores at load 25-160). Child deadlines and case timeouts in `service`, `fresh-gate-admission` and `installer-bootstrap` tests now come from the kit's `fixtureDeadlineS` load factor instead of fixed seconds. The supervisor test that asserts the 500 ms scratch cap itself keeps its 2 s bound with a measured `wallclock:` annotation. (WALLCLOCKFIX1)
- The scratch reaper no longer reads a live seat as UNKNOWN on a loaded Mac. The seat probe's `lsof` deadline is 10 s (measured p99 3.72 s at load 18-21 on 32 cores; the old 3 s deadline expired on 5 of 30 calls). The real-seat tests in `scratch-seat-owner` re-observe an UNKNOWN answer until a definite one arrives within a load-scaled budget, and a planted case proves a 4 s `lsof` still answers held or unheld. (WALLCLOCKFIX1)
- `private-index-land`'s exact-candidate case no longer runs the kit's own shell suites inside its fixture: the eleven copied checker-contract suites are passing stubs that keep their names, so the case went from 231 s to 32 s of CPU and the file from 187.5 s to 44-56 s. Its case timeouts scale with load, and the candidate archive is written to a file instead of a 1 MiB-capped pipe. (WALLCLOCKFIX1)
- `heavy-observers`' stalled-sbh case no longer races its own stub: the observer deadline it sets comes from the load factor instead of a fixed 4 s, so the freshly written stub records its process group before the timeout, and the case still proves the timeout kills only the observer's group. The file's case timeouts scale with load too. (WALLCLOCKFIX1)

## [0.2.87] - 2026-11-04

### Added

- `heavy --lane NAME` queues commands on a named, single-slot lane (configurable with `load.json` `lane_slots.NAME`) while retaining global admission limits, showing holders and elapsed lease time, and reclaiming dead child leases.
- Lane leases track the foreground child, not its process group: commands must wait for descendants instead of backgrounding work and exiting.
- Preserve the existing always-loaded standing guardrails and append 54 grouped Joshua decision rules, checked decision citations, source-observed partial mechanism references, explicit unenforced gaps, ten pending conflict defaults, same-day deltas and dated monthly/quarterly/yearly review cadence.
- Add portable native OMP parser, bounded-context, original-law byte-preservation and repository mechanism checks, with fixture-backed planted negatives. Check private J-id authority when present; otherwise report its named case as NOT_RUN/skipped. `OMP_KIT_JOSHUA_DECISIONS` selects an authoritative checkout. Keep landing blocked pending Joshua's ten conflict choices.
- Gate events now retain repository, member, UTC start and elapsed seconds alongside existing verdict fields; `doctor --scope push-latency` reports per-repository median/max pre-push hook spans and the slowest members without counting untimed legacy rows as zero.

### Changed

- 0.2.87: the fix release for the 2026-11-03 red main and its hardening wave: a commit gate that refuses landing on a red main (REDMAINLAND1), commit-preflight runs the installed gate checks (GATEBOOTSTRAP1), the fleet guard refuses index-changing git that would leak from a scratch export into the shared checkout (EXPORTINDEX1), mail never wakes a stopped seat (MAILSTOP1), paused seats are told to stay paused on upgrade (PAUSEDRESTART1), kitlib refuses unknown options (STDINDROP1), the standing law carries the 54 distilled decisions, the miner keeps every occurrence with stable ids, and the native TTSR observer no longer reinstalls its runtime per call.
- `release-local.sh --version X.Y.Z` (or `--next`) prepares both package versions, README stamp and fragment, commits exactly those clean paths, publishes and waits for both exact-export verdicts before cutting. Real cuts default to `--install`: update the certified public bytes, reconcile only the updater-classified live-browser-state false PARTIAL, relink every profile and prove alignment plus CLI version before stamping installed. Timings cover push through installed readback; receipts persist in a kitlib-owned directory. Dry-run commits locally but never pushes or installs; `--source` preserves immutable resume/preview and `--no-install` explicitly stops at released.
- Mining now checkpoints project × UTC day × source coverage beneath the checkout's `var/mine/`: unchanged completed receipts resume without rescanning, PARTIAL cells retry with their citations/reasons, and atomic evidence caches survive interruption. Source records remain query-only; mining writes its coverage ledger and may recreate absent SQLite WAL side files for an existing database, never create the database or update its rows. A fully decoded event-time index skips irrelevant transcript files without using filenames or mtimes to select events. Missing retention and absent stores remain explicit rather than certified quiet.
- Mining follows command-center's CCWALREAD1 opening policy when a writer has removed WAL side files. If CC still cannot be read, named PARTIAL CC cells preserve the incomplete project census while configured projects' primary findings remain available. Hook fingerprints cover only the admitted top-level logs, never unrelated nested agent homes or their repository symlinks.
- Quarantining unbound CLI telemetry no longer falsely marks a completed CC scan PARTIAL; genuine resource, class/project-limit and deadline truncations remain PARTIAL with named reasons.
- Mining now retains bounded, credential-scrubbed call arguments and gate replay context, joins duplicate observations by their original call/event ID, and keeps distinct command-center incidents instead of suppressing whole project/day sources. Missing historical inputs remain explicit; observation citations never count as executable firing proof.
- Failure classes follow structured status and named validation/assertion/identity/MCP causes rather than tool names or quoted keywords. Successful retained `rc=0` and explicit `timed_out:false` do not become refusals or timeouts.
- Native and installed shell gate capture share the existing secret-output and full-test generic-assignment redaction policies through a packaged canonical JSON artifact; an unavailable or invalid policy refuses replay capture rather than passing raw inputs.
- Hook installation, installed-byte checks, and the inert installer fixture now derive copied dependencies and modes from one installer manifest; newly added portable-path, wallclock, replay, and policy files cannot silently fall outside the checked fixture closure.
- Replay redaction now reads secret-bearing flags from the shared policy, hides split flag/value pairs and attached long/short values before retaining argv, and refuses a missing or invalid flag list in both TypeScript and Python; ordinary flag values and trailing valueless flags remain intact.
- Mining JSON now exposes every counted incident in `occurrences`, including its retained replay context and related source citations. Each occurrence has a stable `event_id` (the retained producer ID, or a SHA-256-derived source identity) for joins across reclassification, project attribution and citation changes; human-readable class examples remain capped at five.
- Commit preflight and installed hooks now refuse new literal JavaScript/TypeScript fixture deadlines, including Bun case timeouts, at any size; use load-scaled fixture budgets or an explicit reasoned product-deadline comment. Existing sites remain grandfathered, but cannot grow.
- A new TTSR guard interrupts capped git-status inventories in bash pipelines and same-cell Python eval captures followed by printed slices, before missing output can be mistaken for proof that restoring or removing paths preserves all work.
- Added a narrow TTSR reminder for the unsupported `br --readonly` command and argv shape observed in DAILYCLASSES row 33, with fire/quiet cases and live scenario declarations. The actual event was exit 2 plus an assertion, not an eval timeout. This is advisory correction, not a runtime refusal or proof that arbitrary invalid tool calls are prevented.
- DAILYCLASSES also refuses top-level grouping of individual tracker JSONL objects in read queries, with native read argument serialization, planted fire/quiet corpus controls and live scenario declarations. Native-verb guidance routes exact exports away from version-specific Python extraction and task subagents away from seat restarts. Culprit attribution now confirms both sides of a bisected boundary twice before naming a commit; unstable failures stay unattributed (at most four additional exports, six files per export, stopping early).
- Two advisory rules from today's mined failures: `kit-grep-root-ignored` (a grep over the whole repo that includes ignored files, which timed out at 30 s) and `kit-todo-append-phase` (a todo append with no phase). Each fires on the real retained input and stays quiet on two real correct calls; the case corpus now admits grep and todo as tool scopes.
- Live coverage can assert `tool_executed` for non-writing tools using native exact-argument call capture and same-call execution/result events, without accepting a TTSR abort. Both advisory rules have live fire/near-miss pairs; planted missing execution, missing result, wrong tool, wrong arguments and wrong call IDs fail the verdict.
- Refuse git index/ref mutations from scratch exports that would reach an enclosing checkout; native `scratch new --export` now creates an independent empty git repository without changing exported source files. Read-only git and correctly isolated exports remain allowed.
- Upgrade notices keep stopped projects and paused goals paused for the lead's next approved fleet restart; the self-restart helper supports `--preserve-mode` without resuming an already paused goal.
- Fixed silently dropped process options: TypeScript kitlib `run` and `runSync` reject unknown option keys before spawning. Synchronous `runFixture` refuses supplied stdin and directs callers to `runFixtureAsync`; its sync forwarding now contains only supported options. Added real-child stdin controls and planted unknown-option regression tests (STDINDROP1).
- Commit preflight now runs the repository’s installed staged hook members alongside source checks and names installed-gate refusals before commit, without touching the caller’s index or object store. No installation reports UNKNOWN without changing the result; an incomplete installation remains a finding. (ompkit-fp72.120.16.134)
- Resolve the native observer's OMP source before isolating its HOME, avoiding repeated source installs that exhausted its deadline; check every authored SDK rule row through bounded native observation, including a planted timeout rejection.
- Fix false scratch-consumer and diagnostics test failures when macOS temporary paths resolve through `/var` to `/private/var`, retaining exact physical-path mismatch checks.
- Mining now ranks the top ten waste classes with recorded minutes, tokens, revision rounds and counterfactual prevention: refused commits joined to their landing, repeated bead rework rounds with causes, agent-brief corrections deduplicated across mail wake retries, owner corrections and recorded wait spans. Missing cost and incomplete history remain explicit; overlapping diagnostic and episode costs are not additive.
- Set `OMP_KIT_OWNER_CORRECTIONS_PATH` to an existing owner-decision JSONL file (`id`, `at`, `said`, `rule`, optional `repo`/`project_path`) to include owner corrections. Its recorded timestamp, never a display date or file mtime, places each correction in the UTC report window; unbound project scope remains unattributed.
- `OMP_KIT_MINE_SESSION_ROOTS` accepts platform-path-delimited absolute session files/directories for coordinator history outside mapped project session roots. Explicit roots are scanned before large project archives, deduplicated against default discovery, and retain unknown workspace ownership as `@unattributed` rather than charging an arbitrary repository.
- Resumable mining persists finding evidence once and rebuilds class and waste rankings, keeping class-limited scans explicitly PARTIAL on long exported-tree paths without overflowing ledger receipts. Existing receipts with cached rankings still resume from their findings; repaired or quiet sources recover normally.
- Add `omp-kit brief --repo PATH [--paths PATH...]` to derive gate contracts and review landed-line deletion candidates without authorizing rewrites; build task spawns require the current contract digest, and task-result DONE handbacks require clean changed-path preflight evidence.
- TOOLPIN1 (ompkit-fp72.120.16.148): pin source validation, CI and release builds to Bun 1.4.4 through `.bun-version`, matching the upgraded host runtime and the minimum required by OMP 18.16.0. Update the optional RCH runtime-attestation guidance to the same exact version; CI workflows continue reading the single source pin.
- CI-only release checks now use the same physical disk admission as the full suite, retaining the 10 GiB floor without deferring on SBH percentage pressure.
- RELEASE4MIN: local releases download public assets concurrently in one bounded curl, identify failed transfers by asset, poll runner completion every three seconds, and log network/verification sub-step times without changing published assets or consumer trust.

### Fixed

- Isolated update postchecks reuse cache retention's canonical browser-profile roots and report them as excluded live state without hashing Chrome's changing SQLite/LevelDB files. Operator rules and other kit state remain watched. Pending updates with only excluded live browser state name `omp-kit update --reconcile` as recovery rather than offering only undo.
- PIDGUARD1: destructive signal targets read from pid files or process listings now pass shared integer guards before the live E2E harness signals a process group or the full-suite harness walks a process tree. Empty values, pid 0/1, negative sentinels and out-of-range values are refused without signalling.
- The existing kitlib commit/push ratchet now rejects new or edited unguarded destructive `process.kill`, `os.kill`/`os.killpg` and shell `kill` calls. Signal-0 probes remain quiet; existing sites are grandfathered by source fingerprint and a shrink-only per-path inventory. TypeScript and Python callers validate inline with `safePid`/`safe_pid`; shell callers use `kitlib_signal SIGNAL PID [group]`.
- The signal grandfather list ships separately as `scripts/kitlib-ratchet-signal-baseline.json`; the schema-1 raw-spawn inventory remains byte-identical so already-installed commit gates can admit the upgrade.
- The release package no longer ships a `src/` directory. The redaction policy and credential-shape catalog ship under `scripts/`; a shipped `src/` had switched the packaged ladder to source-mode flywheel invariants, which then failed for want of unshipped source-test proofs. The shipped secret-output extension's policy import is rewritten to the packaged location only if the original import occurs exactly once; any drift refuses staging.
- Fixed release-gate regressions where environment-prefixed capped `git status` commands and environment-prefixed or continued `br --readonly` commands escaped their rules; the packaged metamorphic check keeps its strict zero-break gate.
- The live tripwire scenario for `kit-jsonl-aggregate` now proves the interrupted read never ran: an opt-in native event capture records the read call, the matching TTSR abort and no execution or result, so live coverage accepts it without trusting transcript prose.
- The kitlib ratchet admits a staged file that is byte-identical to published `origin/main` for the unsafe-signal rule as it already did for raw spawns, so an exact withdrawal to a published commit is no longer refused for restoring a grandfathered signal site; any file that differs from origin is judged in full, and a signal-only admission still requires the reversal validator.
- `land`'s archived full-suite judge copies the judged-file closure read from the base commit's own `suite-metrics.py` (parsed, never executed) instead of a hardcoded list, so a newly judged helper no longer makes every landing report the suite as unrun.
- Main-branch commits now surface recorded red release verdicts and refuse unrelated changes, naming the first recorded red commit, failing test files and bead. Repairs can change a failing file or carry `Fixes-Red: <bead-id>`; missing/pending evidence is reported as UNKNOWN and recorded flake clearances are honored.
- Mail to stopped projects (`fleet-watch` `pullEnabled:false`) or seats with a proven paused goal now persists without an external send or in-process follow-up, recording `STOPPED_NOT_WOKEN` and its reason. Unreadable fleet state also prevents wakes; active seats still wake, with `pause_state:UNKNOWN` recorded when the bounded 256 KiB recipient journal tail cannot prove a goal mode.

## [0.2.86] - 2026-11-03

### Changed

- The goal keepalive wake now follows J-2026-10-29-18: a seat on the declared constraint resumes its held bead or verifies another worker's review, and a seat with no pinned work reports NO-WORK and ends its turn. The old "a seat never waits" downtime list, which sent idle seats into self-chosen profiling and audit work, is gone.
- CUTREADBULK1 (ompkit-774u.55.2): claim-cut admission reads the active graph in bulk (`br list` of active beads, `br blocked` for edges, one batched `br show` for in_progress beads) instead of one `br show`/`br dep list` per bead. On the live tracker an unpinned claim now decides in about 1.1 s with 4 reads; before it made 128 serial reads and ended `CLAIM_CUT_UNKNOWN` at the 20 s deadline. Partial pages, malformed rows and read failures still read `CLAIM_CUT_UNKNOWN`.
- Admission confirms each screened path with typed `blocks` edges: `br blocked` also lists waits-for and conditional-blocks blockers and a blocked parent, which are not cut paths. `br list` reads `--status all`, so a stock tracker without rework/in_review statuses still answers.
- Set CLI and OMP plugin version metadata to 0.2.86. It is a fix release cut from the main-role full-suite PASS on 596ade933b plus bead-lint EPICWAIT1: keepalive follows J-2026-10-29-18 (NO-WORK and stop), br shim and flywheel guard refuse an unexpanded `$` tracker path, `service install` rolls back to the previous plist when bootstrap fails, the config-facts rule ignores the edit header, gate phase timing boundaries with the legacy fixture carried forward.
- RELEASE4MIN: `sh scripts/commit-preflight.sh [--files P...]` runs every staged-file commit check at once (seconds) and reports all findings, so a commit is not refused one finding per multi-minute retry.
- LEGACYEMPTY1 (ompkit-fp72.120.16.100): `scratch release --legacy-owner` of a directory whose `.owner` is empty records and reads back its release; the marker reader rejected the empty `legacy_owner_b64` it wrote and reported a false directory-changed-during-release.
- VERDICTSIZE1 (ompkit-fp72.120.16.101): the full-suite verdict store reads records up to 8 MiB (was 1 MiB); main-role records reached 1.07 MB on 2026-11-02, so every PASS since then read back as MISS and release-local could not cut.
- QRELEASED1 (ompkit-fp72.120.16.103): an owner-released scratch quarantine entry is deleted once its hold expires, even while the owner seat lives; long-lived seats had kept every dir they released.
- RELFAILFAST1 (ompkit-fp72.120.16.104): `release-local` asks the heavy-work gate (`omp-kit heavy --no-wait`) in preflight and refuses in seconds when disk, load or slots would hold the ci-only ladder; the ci-only stage reports every failing file before refusing.
- ADMITFLAKE1 (ompkit-fp72.120.16.106): a slow or failed live read in the durability admission check is an explicit UNKNOWN naming the read, never a block verdict, so two dispatches on one fixture no longer report false NONDETERMINISM under load; the harness selftest reports NONDETERMINISM and UNKNOWN as named FAIL lines instead of throwing.
- POOLTRAP1: full-suite-verdict-incomplete proves a pool worker's exit never removes a live sibling suite's scratch (planted in-worker kitlib temp fails).
- PRIORGATE1: closing a bug/feature or kind:fix bead needs a `prior=` comment posted before its first `Bead:` commit (or its claim), or `prior=none searched=<queries>`; beads begun before 2026-11-03T08:00Z close with a grandfathered note. `sitrep.sh --prior-art` prints `prior_cited_first_share`.
- CFSLOCK1: the save guard's git observations no longer take the index lock (`--no-optional-locks`), so a timed-out session-start status cannot strand `.git/index.lock`.
- CCLEAK1: every test suite runs with `OMP_KIT_CC=0` (both suite-wrapper branches; allow-env cannot override it), so tests no longer write into the real command-center telemetry store.
- CCLEAK1: tests that check CC spool rows opt in with `OMP_KIT_CC=1` alongside their own `CC_STATE`; every other suite stays silent.
- CCLEAK1: the watcher pull, flywheel-guard receipt and spool-adapter tests opt in to CC emission explicitly and restore the environment after.
- Add `milestone pin|unpin|show SESSION`: validate pins in the session's own tracker, serialize atomic config updates, and record who changed the cut and why. `show` prints the declared milestone and recent pin history, refusing stale unknown pins.
- CUTWRITE1: milestone help examples use SESSION/BEAD placeholders instead of an internal bead id.
- SUBAGENTWAIT1: the background-wait guard (BGWAIT1) no longer refuses `wait` in subagent sessions (`ctx.agent.kind === "sub"`); fleet seats are still refused.
- MINE1: `bun scripts/mine.ts --since DATE --until DATE [--project P|--all] [--json]` mines primary omp transcripts across profiles, native tracker snapshots, git Revert/Supersedes history, per-repo hook logs and the command-center producers into a deterministic, read-only ranked report: every class carries citations, its existing-bead candidates and the cheapest enforcement; every project shows its source counts; unbound CLI telemetry and scratch events are quarantined, not ranked; unmeasured minutes stay null.
- Configured checkout aliases resolve to their trusted canonical identity before temporary-path quarantine; unconfigured temporary descendants remain excluded. Mining fixtures use canonical kitlib-owned temp roots and need no installed omp-kit or agent identity.
- MINE1/CUTWRITE1: `omp-kit mine` and `omp-kit milestone pin|unpin|show` dispatch from the CLI and have command-reference rows.
- Mining now checkpoints project × UTC day × source coverage beneath the checkout's `var/mine/`: unchanged completed receipts resume without rescanning, PARTIAL cells retry with their citations/reasons, and atomic evidence caches survive interruption. Source stores remain read-only; only the mining ledger is written. A fully decoded event-time index skips irrelevant transcript files without using filenames or mtimes to select events. Missing retention and absent stores remain explicit rather than certified quiet.
- MINE1: mining is resumable: a project x UTC-day x source ledger skips unchanged completed cells and retries only partial ones.
- The fresh commit/push gate now refuses added or changed test files exceeding 90 seconds in its own individually timed run, names the file and elapsed time, and recommends splitting it like `private-index-land-2/-3` or `kit-update-*` without dropping assertions. The two slow files in the latest complete measured verdict have explicit measured ceilings in `.github/test-budget.json`; grandfather entries and ceilings may only shrink against the Git predecessor, including docs-only changes. Existing aggregate/distribution estimates remain report-only and do not supply exemptions.
- FILEBUDGET1: fresh-gate manifest fixtures commit a budget baseline, so the fail-closed predecessor read has one.
- FILEBUDGET1 v2 distinguishes busy-machine observations from test growth: wall ceilings apply only when start/end load is within the declared envelope and actual worker widths equal the gate's own defaults. Otherwise the budget item is `NOT_CALIBRATED`, with no budget PASS credit; other commit gates continue. Reusable focused records retain that per-file status. Frozen, evidence-bound CPU references still enforce equivalent-wall ceilings at any load; predecessor checks prohibit changing references or widening the load envelope. No host-load divisor or automatic upward recalibration is used.
- FILEBUDGET1 v2: the legacy suite-metrics patch keeps end-load sampling, so the helperless legacy judge rebuilds again.
- Heavy work defers with exit 75 when its disk observer times out, retaining exit 69 for missing/erroring observers and never admitting without a positive reading; observer refusals now persist locked, fsynced JSONL timing records in `$XDG_STATE_HOME/omp-kit/load/observer-refusals.jsonl`, and `load.json` supports positive `sbh_deadline_s` seconds (default 30-second hang guard, sized above measured startup latency rather than treated as a latency budget). Admission, runtime, observer, and statfs suites retain all 62 cases in topic files with shared canonical subprocess fixtures.
- Measured test suites no longer inherit `FRESH_GATE_*` controls from their parent gate, in either environment mode. Nested fixture gates cannot accidentally borrow the outer checkout's policy history or verdict paths; ordinary declared environment controls remain available.
- Fresh-gate fixtures now obtain judged files from `suite-metrics.py judging-files` (or its imported `JUDGING_FILES` tuple), so newly judged files propagate without fixture-list edits. `check-judging-copies PATH...` reports fixture-local literal closure copies. Foreign-owned private-index and release-verdict fixtures remain unchanged pending their owners' integration.
- CIONLY1 (ompkit-fp72.120.16.86): the push-time release verdict also runs package-release.test.ts and kit-update.test.ts on a git-initialized export of the exact commit and records PASS/FAIL for that tree (`full-suite-verdict-store.py run-ci-only` / `require-ci-only-pass`), so a cut can reuse the PASS instead of running them after build, sign and notarize (up to 900 s and 2400 s).
- CIONLY1: release-local requires the push-time ci-only PASS for the exact tree and refuses in seconds without it; the cut never runs those tests.
- FRESHGATEFIXTURE1 (ompkit-fp72.120.16.87): the pre-push affected-test selector follows two more dependency kinds: a test that reads a `tests/fixtures` file by its quoted name (for example through `join(root, "tests", "fixtures", "x.patch")`), and a Python test that imports a script module (`import bead_lint` after `sys.path.insert`). On 2026-11-02 each of these selected 0 files at the push gate and failed a release full suite instead.
- EPICWAIT1 (ompkit-fp72.120.16.88): bead-lint's m-goal-path remedy no longer tells an author to make an epic with open children wait on a new bead (that edge hides every child from `br ready`); with no childless goal it advises `kind:intake`.
- The goal-path tests now expect `kind:intake` when the fixture goal has open children, with a childless-goal control that keeps the `br dep add` remedy.
- Bead: ompkit-fp72.120.16.98
- Full-suite verdicts now reuse individually measured PASS files across candidate trees using content-addressed dependency closures from the fresh-gate graph. Action keys include candidate global inputs, judging code, the canonical runtime header, and resolved tool paths, versions and executable digests. Unknown dynamic, filesystem, subprocess and network inputs fail cold; local extra inputs may be declared using `// full-suite-inputs: GLOB ...` (or `# full-suite-inputs:`), with matched membership and bytes included. Shell closures conservatively include all scripts unless `# full-suite-deps: PATH ...` declares them. Network and dynamic loading remain uncacheable. FAIL files never supply reusable PASS evidence; complete tree-level FAIL refusal and explicit rerun behavior remain unchanged.
- Tree verdicts bind action keys and ran/reused provenance to their paired logs and validate the original source record before reuse. The default shared pool is capped at 12 workers based on observed fleet-load failures (approximately 40 at 28 workers versus 8 at 12, subsequently fixed); FULL_SUITE_JOBS remains authoritative.
- Eligibility is pure-or-declared: unresolved imports fail cold unless they belong to a small pure-module allowlist; filesystem/process imports require explicit local-input declarations, while ambient environment access and dynamic loading always refuse reuse. Global inputs include bunfig.toml and the preload's transitive imports. Runtime identity additionally binds hermetic/fence flags, OS build, timezone/locale, and Bun/Node options. Undeclared shell closures include tests/**/*.sh as well as scripts/. Global symlink uncertainty runs cold rather than aborting the verdict.
- RELEASE4MIN: test-runner builds a private current manifest from scripts/build-manifest.sh instead of trusting a stale ignored copy; native-br-preserve gives only its two end-to-end installed-chain cases a measured 90 s deadline.
- RELEASE4MIN: heavy and work-doctor tests measure the product's own timestamps instead of machine load; the work-doctor git probe default is 4 s, from measured loaded git status times.
- RELEASE4MIN: the live e2e suite runs scenarios in a bounded pool of private HOMEs (default min(8, cores/4)) with a version- and digest-keyed read-only native seed and private transpile-cache copies: 336 s serial to 80 s at width 8, 157/0; kit-update and package-release are split into independent CI-only files.
- RELEASE4MIN: commit preflight runs the gate's pinned ShellCheck (koalaman/shellcheck:v0.9.0) instead of the local engine, so it reports what the commit gate will refuse.
- RELEASE4MIN: the live e2e suite runs scenarios in a bounded pool of private HOMEs (default min(8, cores/4)) with a version- and digest-keyed read-only native seed and private transpile-cache copies (336 s serial to 80 s at width 8, 157/0); kit-update and package-release are split into independent CI-only files.
- RELEASE4MIN: the full-suite pool defaults to ncpu/4 workers clamped to 2..6 (measured: width 6 had 1 contention failure, 16 had 36, for 108 s less wall time).
- RELEASE4MIN: release-only kit-update and package-release suites run as independent CI-only files, and live e2e scenarios share a read-only native seed (336 s serial to 80 s at width 8).
- RELEASE4MIN: pre-push contract families build common Git/checker/judge fixtures once per file and clone them into isolated case repositories, including independent tag remotes; all contract assertions remain unchanged.
- RELEASE4MIN: skill-set tests share one read-only default-profile recipe result (inventory launches 45 to 18; the file's system CPU 238 s to 102 s).
- RELEASE4MIN: output-ids renders declarative help from a CLI bundled once per file; state-root's doctor case runs from its fixture home instead of auditing the live checkout.
- RELEASE4MIN: manifest generation batches checksums and classification joins per rule pack while preserving manifest bytes.
- RELEASE4MIN: test suites cap child thread pools (UV_THREADPOOL_SIZE, TOKIO_WORKER_THREADS, RAYON_NUM_THREADS = 4), and the runtime and inventory env allow-lists pass those keys through when set.
- RELEASE4MIN: the push-time CI-only verdict judges every relocated release journey (kit-update N+2, compiled, relink, package-release-live); an exclusion that is neither judged locally nor a reasoned GitHub-only exception is refused.
- RELEASE4MIN: the heavy runtime-label test pins its disk observer to statfs, so sbh scheduling cannot replace the runtime evidence it checks.
- RELEASE4MIN: archive-compile's fixture owns a test-budget baseline; cass-freshness's fake cass is shell, not a second Bun.
- RELEASE4MIN: package-release fixture timeouts are load-scaled, so the oversized-file case no longer races two 120 s children with a 5 s bound.
- RELEASE4MIN: br-shim CUTCLAIM1 fixture bounds are load-scaled together, so two sequential claims fit their case budget under load.
- RELEASE4MIN: verify.test.ts fixture deadlines are load-scaled, so its planted negatives fit their fixture work under load.
- RELEASE4MIN: converge's race fixture bounds are load-scaled, so the stale-lock reclaimer race fits its fixture work under load.
- RELEASE4MIN: fleet-lessons polls a killed descendant until it is gone, a zombie or exiting, instead of racing its exit.
- REAPCLI1 (ompkit-fp72.19.1.9.1): `omp-kit scratch index-lock --repo DIR --reap --yes` now runs the gated stale-lock reaper (empty, aged, no lsof holder, no git process rooted in the tree, unchanged identity; renamed aside, never unlinked) and appends one `GITLOCK_REAPED` ledger row per move. It used to report `WOULD_MOVE` and move nothing. `--min-age-ms` is honored; without `--yes` it stays a dry-run report.
- Profile retained focused-gate and full-suite costs with `python3 scripts/gate_profile.py --runs 10 --json`. Record worker-queue wait, pre-exec setup and post-exec run per file; aggregate explicit spans into stage rows. Stage and file phase basis must match producer contracts; a zero file count cannot waive stage spans. Historical runs without these fields remain unknown and cannot be reconstructed.
- Gate records now carry explicit wait, setup, and run spans per file and stage; structurally empty runner stages record zero phases rather than missing data.
- The legacy-base fixture (`tests/fixtures/legacy-suite-metrics.patch`) carries the phase-timing change forward: a helperless judge has no exec marker, so it records setup as zero and the whole span as run. The 0.2.86 release verdict for 75eb1a0151 failed on this fixture no longer applying.
- A foreign exclusive lease on the tracker’s JSONL export no longer freezes peer database mutations: validated export-only conflicts force native no-auto-import/no-auto-flush execution before create admission and delegation, including comment-target and P0-displacement side writes. Export bytes stay unchanged until the lease is released and a normal flush exports the deferred database state. Foreign database or mixed custody, unknown reservation authority, explicit sync and JSONL-only/ambiguous export modes remain refused; unleased native behavior is unchanged. Guard-only native reads are non-importing and non-flushing, and comment-file/literal argument boundaries retain their original meaning.
- Scratch exports land in `<dir>/src` (`data.exportDir`), so an archive can never replace the owned root's `.owner`; an empty root owner left by a raw extraction gets a named recovery route.
- Run live scenarios in a bounded pool of private HOMEs and model configurations, preserving ordered verdicts and parent-owned case counts. The default is `min(8, max(1, online CPUs / 4))`; `OMP_KIT_E2E_JOBS` selects an explicit width.
- Reuse only read-only native bindings keyed by the selected OMP version and executable digest, plus private copies of immutable Bun transpilation output; configs, credentials, extension databases and model files remain private to each scenario.
- Schedule the updater's N+2, compiled activation and relink-refusal live journeys, and the installed-package live ladder, as separate CI-only files without removing their assertions or live checks.

### Fixed

- Scratch orphan reaping now gives the real directory-user probe measured load headroom instead of preserving abandoned interpreters when a healthy `lsof +D` narrowly exceeds three seconds; incomplete evidence still refuses termination.
- Refuse changed tests that fail under concurrent suite-width load before commit, with isolated per-copy HOME/temp directories and case, concurrency, load and added-time diagnostics.
- LOADGATE1: fixtures accept TMPDIR nested under the owned load wave, and the legacy suite-metrics patch matches the new execute block.
- FILEBUDGET1 remedy: fresh-gate.test.ts is split into five topic files, each well under the 90 s per-file budget.
- LOADGATE1: load-wave copies run in the full suite's own environment mode; only their temp dirs are private.
- LOADGATE1: the load fixture copies the canonical v2 budget policy, so the policy schema and the fixture cannot drift apart.
- `omp-kit service install <job> --apply` no longer leaves a daemon unloaded when the new plist fails to bootstrap: every failure after the old job is booted out restores the previous plist, bootstraps it again and reports `INSTALL_ROLLED_BACK` with the backup path. The retry bootstrap also waits (at most 2 s) for launchd to remove the old label, the window in which `Bootstrap failed: 5` occurs. On 2026-11-02 a cc install hit that failure and left the command center down until a hand restore.
- `omp-kit doctor --scope hooks` retains its fleet census and also runs both hook installers' read-only `--check` against `--project PATH` (the CLI defaults to the current repo), reporting missing/stale fresh-gate and bead-chain members with reinstall commands. Run `sh scripts/install-pre-push-gate.sh` from the source checkout being repaired and `sh <release>/scripts/install-commit-msg-bead.sh <repo>`, then rerun the doctor; it never mutates installed hooks itself.
- The `br` shim now refuses a tracker path that still holds an unexpanded `$` variable (`--db '$DB'`, `--db=$DB`, or `BEADS_DB=$DB`) before br runs, naming `BR_SHIM_DB_LITERAL`. Such a call made br create a whole new beads database named `$DB` at the omp-kit root three times, and each copy blocked every build wave as checkout dirt.
- The flywheel guard refuses a `br` or `bd` call whose `--db` is a shell expansion (`--db $D`, `--db=${DB}`, a command substitution) with `TRACKER_DB_UNEXPANDED`, before any of its tracker checks run. Those checks ran `br show --db <the literal text>` in the cwd, which created the empty `$DB*` and `$D*` databases: the guard was the writer, not an agent.
- Planning conversion dry-runs resolve the native br executable past seat policy shims only after isolated database admission, preserving the real seat identity and leaving the live tracker untouched. Apply continues through the seat shim and its actor admission checks.
- SHIMDRYRUN1: a dry-run aimed at a database outside its owned directory is refused at admission, before any native br is resolved.
- The same rule no longer fires on an edit's own file header line (`[/Users/.../fleet-watch.json#C82E]`), which named the home path of the file being edited. On 2026-11-02 that false match refused every agent edit to `fleet-watch.json`, so only Joshua could change a milestone pin. A new home-path line in the edit body still fires. (ompkit-fp72.135.3.16.2, part b)
- Work-scope doctor Git probes now allow four seconds by default, with measured headroom for loaded machines, while preserving explicit `--timeout-ms` overrides and UNKNOWN results when evidence cannot be obtained.
- Heavy-work disk checks now stop an unresponsive `sbh check` after four seconds, clean up its process group, and report the observer as unavailable instead of waiting indefinitely.

## [0.2.85] - 2026-11-02

### Changed

- Fix (ompkit-774u.70): the hook installer installs the stale-worktree commit-msg member again. Adding the deploy-step member had replaced its install call, so installs on the 774u.70 source silently dropped the guard that refuses commits reverting landed lines. The deploy-step test fixture no longer rewrites a landed installer line (it passed only because that guard was missing), and the installer's inert-member test copies check-deploy-step.sh into its fixture kit.
- Set CLI and OMP plugin version metadata to 0.2.85. It is a fix release cut from a main-role full-suite PASS on 848fd7e01e: companion main is green again after the 05c red-main regression (seat br shim admits owned native tracker fixtures, kup44.4.3; fleet-policy refusals stay outside owned fixture scope; dependency-edge guards no longer depend on handoff-only imports, 774u.87), LSP readiness retries are bounded under contention (l9kv), and structured scratch owners survive export (774u.9.30). It does not close release train 6; its beads close on their own evidence.
- Poll real cold-server readiness at 250 ms intervals, capped at 25 seconds and 100 retries inside the unchanged 60-second probe limit; exercise the existing real request under bounded CPU contention. (ompkit-l9kv)
- SUBAGENTRESTART1 (ompkit-o2iif): the fleet UPGRADE_NOTICE now tells a background task subagent that it is not the seat and must ignore the notice; `self_restart.py` refuses such a caller with `REFUSED_SUBAGENT` before any Esc reaches the seat.
- Release-goal admission now requires an executable `release-local.sh --dry-run` box using the script’s freshly fetched origin head, rejects bead-closure prerequisites, and does not count quoted commands or argument values as dry-run proof.
- The per-file test-budget threshold is explicitly report-only while it remains distribution-heuristic. Budget checks reject a policy that attempts to enforce that heuristic; measured overages remain visible in report mode.
- Require a deploy or recovery step for commits that change installation, hook-chain, service, or update behavior.
- Add `python3 scripts/gate_profile.py --runs 10 --json` to rank retained focused-gate and full-suite stage/file costs. Missing wait/setup/run measurements and invalid history stay explicitly partial with exit 3; no optimization, cache reuse, gate relaxation or speedup is inferred.
- Author handoffs from repositories without `fresh-gate.sh` can use an exact-commit non-author pregrade bound to the real tracker and acceptance; missing proof stays refused with repository-declared guidance, companion handoffs retain their complete fresh-ledger requirement, and unrelated dependency-edge checks do not load pregrade modules.
- Prevent scratch exports from overwriting their structured `.owner` with an archived root `.owner`, preserving capability-based release.
- Owned-scratch fixture trackers can run native `br init` and `br create` without a pane identity or Agent Mail registration. Physical ownership and selected database/JSONL destinations are checked before the exception; symlinked, missing/foreign-owner, outside-workspace and production-root targets retain identity refusals. Explicit, ambient and default-local fixture database bindings remain distinct, registered policy fixtures retain their existing admission checks, and the release payload includes the sibling scope validator. Installed-seat rollout remains separately gated.
- Fleet-policy shell countercases now bind their own canonical workspace, so a checkout inside an outer owned export still proves all production refusals. Genuine owned-fixture cases prepare their standard scratch-root container through the portable test setup before `ownedTmp`, so a fresh exact export needs no preinstalled local-kit setup.
- Recognize adjacent, same-block caller-selected database argument spreads on tracker metadata reads. Keep unpinned fixture initialization, inherited writes, changed bindings and namespace mismatches refused; staged and pushed-range checks exercise both valid reads and unsafe controls.
- PARENTBLOCK1 (ompkit-rc-epic-land-fix-release-dogfood-rz5.134): the seat br shim refuses `br dep add P C` with the default blocks type when C descends from P by parent-child (child, grandchild and deeper), naming PARENT_CHILD_BLOCKS. Such an edge parent-blocks every child of P and drops them from `br ready`: on 2026-11-01 four of them on the release-train epic hid 51-54 of its ~60 open children. Related-type edges, child-to-sibling and unrelated blocks edges pass through unchanged.
- PARENTBLOCK1 remedy: bead-lint's m-goal-path finding no longer tells an author `br dep add <goal> <bead>` when that goal is one of the bead's own parent-child ancestors (the remedy that produced those edges); it names the next non-ancestor goal, or `kind:intake` when every open goal is an ancestor.

## [0.2.84] - 2026-11-01

### Changed

- WAKEBIGID1 (ompkit-774u.82): Tern sends and mail wakes no longer fail `PLANE_SEAT_UNBOUND` for every seat when any tab holds a browser or picture-in-picture block. Those blocks carry 64-bit ids above 2^53; the inspect parser now skips such an id as not ours instead of rejecting the whole snapshot. A non-integer id is still refused as schema drift.
- Set CLI and OMP plugin version metadata to 0.2.84. It is a fix release cut from a main-role full-suite PASS: Tern sends and mail wakes work again when any tab holds a browser or picture-in-picture block (WAKEBIGID1, 774u.82), kit safeguards apply during update (fp72.135.3.77's build boxes), scratch quarantine is bounded (774u.80), and author review handoff is separated from close authority (774u.62.1). It does not close release trains 5 or 6; their beads close on their own evidence.
- Allow implementing authors to hand off finished beads for review without treating the handoff as self-grading. Keep implementer close and legacy grading refusals, source-publication and claim-stability checks; closed-status updates retain close ownership and Lesson requirements.
- Add the hourly `cache-retain` service with registered 30-day cache/log and 90-day runtime-receipt expiry, a 120-second worker deadline, and durable deletion journals. Live or unverified users, browser login data, rollback-linked receipts and reusable bundles with fresh descendants are preserved. Thirty-two daily journal slots bound coordination inodes; full journals refuse new removals. Building the kit does not activate the job.
- Add `beads migrate`: preview lossless legacy acceptance repairs with canonical lint and verify grammar, preserve exact original text, and apply only as a non-author with revision checks and byte-matched readback. Underivable commands remain unchanged; newly replayable criteria lose unsupported old ticks, while status and assignment are preserved.
- Every kit safeguard is on by default and reported by a new read-only scope: `omp-kit doctor --scope activation --json` lists each rule pack entry, plugin extension, kit service, per-repo hook member and profile plugin link as ON, OFF-WITH-REASON or OFF-NO-REASON, and exits nonzero while any item is off with no recorded reason. An opt-out records item, reason, actor and time; an empty reason is refused. (ompkit-fp72.135.3.77)
- Activation copies local extension dependencies alongside entrypoints so imports resolve, preserves extension opt-outs across shared support files and profile links, ignores unrelated caller-project guard state during manifest application, and rolls back failed loads instead of leaving a partially applied manifest. (ompkit-fp72.135.3.77)
- Updater postchecks now discard reaped mock PIDs before the final leak check, avoiding false failures if the OS reuses a PID during the live suite. (ompkit-fp72.135.3.77)

### Fixed

- Expired scratch quarantine uses a bounded, tree-size-aware inode/open-file check instead of a pathname snapshot. Cleanup retains held files and unavailable proofs, rechecks owners, users, hold eligibility and directory identity, and preserves released legacy-owner attribution.
- Add hourly OMP session transcript retention. Regular JSONL transcripts older than 14 days, including nested repository sessions, are removed only when CC's session state has `pending: null`, the path, device, inode and committed offset match, and the producer's title-slot, prefix and tail integrity hashes still match the file (with valid mutable title-slot updates allowed). The newest committed error-free session source tick must confirm the same position; otherwise transcripts are kept. Planned and completed deletions are fsynced to a private journal.

## [0.2.83] - 2026-11-01

### Added

- `scripts/autocut.sh plan|run` picks the newest origin/main commit since the latest release whose exact tree has a main-role full-suite PASS and whose package.json version is newer and untagged (a FAIL or missing verdict falls back to the previous PASS), waits out the 12 h release floor unless `--now`, then runs `release-local.sh --version V --source SHA`, installs the release and reads the version back. The cut names an exact sha, so pushes are never frozen; every decision is one JSON line in `.git/omp-kit/autocut.log`.
- release-local runs its ci-only package-release and kit-update tests with the full suite's 120 s per-test budget instead of bun's 5 s default.
- A kit service job `autocut` runs the operator-configured `autocut.sh run` hourly (fleet-watch.json `autocut`: `{argv, cwd}`), with a 55-minute run cap; it stays UNCONFIGURED until that key is set.
- When the release full suite on a published head fails, `scripts/release-verdict.sh` now names the commit that broke it. It reruns only the failing test files: first at the head (a file that passes again is a flake, and no commit is blamed), then bisecting the first-parent commits since the last main-role PASS (at most 8), each in its own export. It logs `release-verdict: CULPRIT <sha> <author> <bead>` or `CULPRIT none (<reason>)`, stores the result as a validated `culprit` object in the verdict record, and adds one REWORK comment naming the failing files to the culprit's bead. If the next judged head is still red with the same culprit, it prints `PROPOSE: git revert --no-edit <sha>` and never runs it. The culprit step never changes release-verdict's exit status. (ompkit-6xxhu)
- `scripts/release-verdict.sh` runs from a private copy of itself, so committing a change to it while a verdict runs can no longer feed the running process new bytes at old offsets.
- The culprit step finds the culprit's `Bead:` line even when a `Supersedes:` or `Revert:` block follows it, so its REWORK comment reaches the right bead.
- A commit-msg member (`55-omp-kit-commit-gate`) runs the installed push fresh-gate on the commit being made, against `origin/main`, so a commit the push would refuse is refused at commit time and never lands on the shared main where it would hold every later commit off origin. It is a no-op in repos without the push fresh-gate member and never starts a release verdict for the unreferenced candidate.
- A green commit gate is recorded, and the push of that same commit (same tree, parent, stored message, `origin/main` and gate file) reuses it (`FRESH-GATE: VERDICT REUSED commit-gate PASS`) instead of running the gate a second time; any difference runs the full gate.
- A pre-commit member (`55-omp-kit-staged-wallclock`) refuses new test lines that pass only within a fixed wall-clock bound under 10 s (a child `deadline_s`/`timeout_s`, a spawn `timeout`/`timeoutMs` under 10000 ms, a Python `timeout=`, or an elapsed-time `toBeLessThan`) unless the line is annotated `wallclock: p99=<number>(ms|s) headroom=<number>x`, with p99 above 0 and headroom of at least 2x. An incomplete annotation (no headroom, an empty p99, headroom under 2x) counts as none, and line length never exempts a line. Untouched existing lines never block. `scripts/wallclock_check.py --inventory` lists every such line.
- `omp-kit save -m MSG -- PATH...` commits your reserved paths and publishes them in one step, then prints one line: `SAVED <sha> on origin in <n> s` or `REFUSED <code>: <fix>`. It runs every check `land` runs and logs each save's time for the speed measure. (ompkit-ypiyn)

### Changed

- Set CLI and OMP plugin version metadata to 0.2.83: verify keeps the build judgement on the parent (774u.52), full-suite runs that are skipped or implausibly short are refused (fp72.49.4), and `omp-kit grader next` picks one prioritized grader action.
- Goal-scoped claim-cut ranking (commit 42e735b) and its fixture repair (commit 1ee5603) are withdrawn from this release: claim admission stays on the explicit-pin contract until the new one ships with passing preflight tests.
- The pre-push judge-role change (commit b4bc605, kup44.5) is withdrawn from this release: the push again records the main-role full-suite verdict, because its consumer tests (private-index-land) still read the main-role record. It returns with those consumers in one commit.
- The affected-test selection change (commit 5ceaba1, phodh) is withdrawn from this release: its new judge inputs were not carried by five tests' fixtures. It returns with those fixtures reading the judge closure from one place.
- The change that makes shared hook and fixture edits select every suite (fp72.49.5) is withdrawn from this release: that wider selection reaches extensions/ee-failure-journal.test.ts, which has failed since 2026-10-20 (w1azf). It returns once that test passes.
- The session-retention notes entry (commit 709d7da, 774u.9.27) is withdrawn from this release: its code is not committed yet. It returns with that code.
- The scratch-owner liveness test no longer fails on days 1 to 9 of a month. Its legacy-probe check compared the whitespace-collapsed start time against the raw `ps` text ("Nov  1"); it now uses the raw start, as the old writer recorded it. Product code is unchanged; the tracker-recovery lease reads and writes the raw form on both sides.
- Full-suite admission by host load and free disk (fp72.49.6, commit 2159c87) is withdrawn from this release: nested fixture verdicts inherited the host load ceiling and refused under the release suite's own load, and a fixture patch to suite-metrics.py no longer applied. It returns with fixture-safe admission.
- `omp-kit mission validate` returns exit code 2 when the mission record is absent; invalid record contents still return exit code 1.
- Pre-push reuses the base-role full-suite verdict that land produces for the same tree; release-local continues to use the main-role verdict.
- `omp-kit verify` keeps an unchecked `[v][build]` judgement on the parent and reports PENDING instead of deferring it as live-readback debt.
- Preflight now refuses in-review or close for grader-queued step 3/4 fixes unless a bead comment records valid code-cited prior art or a complete nothing-found search.
- Added `omp-kit grader next`; it selects from available priorities, reads `grade_wave.py` only from `OMP_KIT_GRADE_WAVE`, and reports unavailable queue sources as UNKNOWN rather than treating them as empty.
- Full-suite qualification refuses declared run-count shortfalls and implausibly short runs against the last validated green reference, even after a judge change. Verdicts retain the policy, measured counts, effective wall time and named shortfalls without falsifying test failures; missing or inconsistent current qualification is never a reusable PASS.
- `br` close and in-review transitions validate each cited commit against a freshly fetched `origin/main` in its source repository; citation-free transitions continue to the existing guards. `omp-kit verify` and DONE callbacks remain fail-closed for unresolved cited commits.
- The pre-push gate test carries the full-suite judge closure into its fixtures from `scripts/suite-metrics.py`'s `JUDGING_FILES` instead of a hand-kept copy list, so a file added to the closure reaches every fixture with no test edit, and it refuses a closure entry that names a file absent from the repo.

### Fixed

- Keep valid claim-cut graph traversals under loaded tracker latency within budget while refusing traversals that exceed the hard deadline.
- The fleet guard reads `git commit --only --trailer "Bead: ..."` values as commit metadata instead of unreserved paths, so a fully reserved commit with trailers is admitted; every path after `--` is still checked.
- `omp-kit doctor` no longer reads a slow rch as a missing one: a `rch --json daemon status` probe killed at its deadline is reported as `RCH_PROBE_TIMEOUT` (UNVERIFIED) and the row stays in the unscoped inventory, and that probe now gets the 15 s its sibling rch probes have instead of 5 s.
- Gate-plane checks now accept the installed br admission shim when its contents match the release, while refusing a different shim.
- Add hourly, explicitly scoped Agent Mail rotation retention: preserve the newest doctor reclaimable rotation, remove older rotations without following links, and durably record deleted names and regular-file logical bytes. Native service definitions retain the selected store across restarts.
- Add hourly OMP session transcript retention. Regular JSONL transcripts older than 14 days are removed only when CC's session state has `pending: null`, the exact transcript cursor matches path, device, inode and byte length, and the newest committed error-free session source tick confirms the same position; otherwise transcripts are kept. Planned and completed deletions are fsynced to a private journal.
- The bead-lint guard now treats expansion characters inside single-quoted shell values as literal, allowing quote-rich acceptance text through `br update` while continuing to refuse active substitutions.
- Separate the CASS status deadline from classification fixtures: callers retain the 2000 ms production default, tests use an explicit larger budget, and timed-out probes remain explicitly UNVERIFIED. CASS probes now use the owned async execution helper.
- Cover checkout and relocated installed-shim layouts in the gate-plane regression suite, including Python admission, doctor isolation, and changed-content rejection.
- Keep the bounded echo/printf exclusion before the pipeline token, so quoted filter commands printed as text remain quiet.
- The live fire scenario for bash-silenced-filter-pipe pipes a silenced `ls` instead of `printf`, which the rule now deliberately ignores.

## [0.2.82] - 2026-10-31

### Added

- scripts/release-verdict.sh runs the release's full suite on the published head with that commit's own runner, one run per repo, handing newer heads to the running job, so release-local finds a recorded verdict instead of waiting for one.
- A green push gate that deferred the complete suite starts release-verdict.sh for the pushed commit in the background (log in .git/omp-kit/release-verdict.log); OMP_KIT_RELEASE_VERDICT=0 opts out.

### Changed

- The full-suite runner runs its bun stage in the background while the shell and python stages run, instead of before them; the suite was measured wait-bound (3,071 s CPU in about 1,500 s wall), so releases and pushes wait less for the same tests.
- A release refused by its CI-only tests now prints the failing output; it used to point at a log file the script had already deleted.
- A push no longer runs the complete suite (about 25 minutes); the release requires it instead, and release-local refuses without a main-role PASS for the exact tree. PRE_PUSH_FULL_SUITE=push restores the in-push run.
- A push runs only the checker contracts its changed paths reach (all twelve ran on every push: 366 s), plans its affected tests against this machine's measured timings with a budget of what is left of a 55 s push (15 s minimum; the standalone default is 120 s), and runs bun files and shell or python suites at the same time on the same workers.
- Checker contracts a push reaches are planned against the same push budget and the rest deferred to the release's full suite; a contract whose test file changed, and the gate's own contracts when a gate script changed, always run.
- The push gate creates var/agent-tmp before its checker contracts run in parallel, and the land publication test opts into the in-push verdict it asserts.
- omp-kit land defers the complete suite to the release like the push gate; PRE_PUSH_FULL_SUITE=push runs it inline.
- The release verdict a green push starts now runs in its own session. git_converge.py kills the push's process group when the push returns, and the nohup'd verdict died with it.
- tests/cli/preflight.test.ts requires an agent-attributed fixture root only when the test runs under an omp seat. Off a seat (CI, or the release verdict a push starts in its own session) scratch new records no seat pair, and the release verdict on bcf5218f04 failed on it.
- release-local runs its two CI-only test files side by side instead of one after the other (606 s serially on 0.2.81).
- Set CLI and OMP plugin version metadata to 0.2.82: the push gate runs in about a minute and the complete suite moves to the release (run by release-verdict.sh on each published head), omp-kit land no longer runs the complete suite inline, the release ships the two pysafe inline helpers its hook installer places, and release-local runs its CI-only tests side by side and checks the package version before it builds.

### Fixed

- Two more tests stop measuring the machine: the scoped doctor/status test asserts no live OMP probe ran instead of a 2-second CLI start, and the parallel profile-probe test measures probe overlap (peak in flight above 1, at most 12) instead of a 2-second wall bound.
- omp-kit land and omp-kit converge read the lock git_converge.py leaves behind, JSON {pid,start_time}, as a process incarnation: a live pid with the recorded start holds it, a gone, zombie or reused pid does not. Before this every repo the Python converger had published refused land with CONVERGE_LOCK_UNVERIFIED until someone deleted the file by hand.
- An ack-required Agent Mail ask resolves its bead in the tracker of the message's project_key (the recipient's repo), so a seat whose session cwd is outside that repo can send a real QUESTION, BLOCKED or APPROVAL. The refusal names the tracker it read.
- The release package ships pysafe_inline.py and pysafe_inline_literals.py, which the hook installer places; 0.2.81's hook install failed on the missing files.

## [0.2.81] - 2026-10-31

### Added

- New beads must now sit under a goal (`m-goal-path`, CUTGRAPH1). A bead needs a blocks path into an open `kind:goal` bead: the goal, or a bead already on its path, depends on it. A bead labelled `kind:intake` or `kind:goal` is exempt. A parent-child link does not count, and neither does a path into a closed goal. The create guard and the update gate refuse an unplaced bead created at or after 2026-10-31T00:00:00Z with `LINT_REFUSED m-goal-path:GOAL_PATH_MISSING`, naming the open goals and the remedy `br dep add <goal> <id>`. An older bead is never refused: the update gate prints a `GOAL_PATH_LEGACY` warning with the same remedy, and `goal_path_report` lists it as legacy. A create cannot point an edge at itself, so it declares its target with the label `goal-path:<target>`. br labels allow no dots, so a dotted id is written with underscores (`ompkit-774u.60` becomes `goal-path:ompkit-774u_60`; only the trailing numeric segments are decoded). The guard admits the create only when the target is an open goal or on an open goal's path, and the follow-up `br dep add <target> <NEW_ID>` makes the edge real. Blocks edges are read live (`br dep list --direction up`). A tracker with no open goal is not judged. `bead_lint.py --selftest` and `--bead` cover the check.
- `scripts/beads_place.py --title TEXT [--description TEXT] [--db PATH] --json` tells you where a new bead goes. It ranks the open beads on each open goal's blocks path by TF-IDF cosine similarity to the text, using only the standard library, and prints the goal, the nearest target bead, and two commands: `br create ... --labels goal-path:<encoded target> [--parent <epic>]` and `br dep add <target> <NEW_ID>`. It only reads the tracker's JSONL export. It exits 3 when there is no open goal (label the bead `kind:intake`).
- Check f (fanout and depth) no longer refuses goal beads. A `kind:goal` bead may gather more than 20 beads. Chain depth now counts from a work bead to its first goal, so one release train linking to the next adds no depth. A work chain deeper than 4 below a goal is still refused.
- The update lint keeps a bead's incoming edges when it rebuilds the bead, so a mention backed only by an edge pointing at the bead no longer refuses the update (i-mention-edges). This bug predated the goal-path check.
- Refuse new shipped companion references to machine-specific `~/.claude/skills` and `/Users/josh` paths at pre-commit and pre-push; existing baseline references may only shrink.
- Admit repositories without a baseline: compare committed history against the old Git tree and unborn repositories against an empty source tree; include the checker, wrapper and baseline in release packages.
- Warns when a Bash command discards stderr before piping into a filter; capture the full output and exit code first.

### Changed

- `omp-kit verify` closes done work without waiting for a release (CLOSEPASS1, J-2026-10-29-20). When every box it ran passes, the unticked `[live]`, `[after]` and `[v]` boxes move word for word into one open bead `LIVEREADBACK: <title>` (label `live-readback`) created under the closing bead's own active parent, or under the constraint lane's parent `ompkit-kup44` when it has none, with a `related` link to the closing bead. The closing bead keeps its original acceptance under `## Original acceptance` in its description and closes holding only the boxes verify ran and ticked, so br's own close policy admits it with no `--force`; the close reason names the child and its parent. A bead whose boxes are all `[live]` or `[after]` still returns `PENDING`.
- `omp-kit verify <child> --live-readback` runs that child's boxes on the installed kit (no export): a pass ticks them and closes the child; a failure reopens the related bead with `REWORK` naming the box. `omp-kit verify --live-readback --all` reads back every open live-readback child.
- br ticks acceptance by checklist line, so verify now ticks each box by its position among all `- [ ]` lines, not its position among tagged boxes.
- The GATEPLANE1 controlled-PATH probe binds the actual source or compiled CLI and an explicit fixture tracker. REPLAYABLE1 grammar parity binds both native readers to the same fixture and reuses immutable executable code with separate row data, avoiding cold-launch timeouts without changing original cases, refusal counts or deadlines.
- Set CLI and OMP plugin version metadata to 0.2.81, release train 5, cut by the lead under Joshua's release floor (J-2026-10-29-13). It ships companion batch 2: HANDLERCAUSE1's handler diagnostics, the async converge path and its tests, the test-budget store helper resolved beside the script, gate fixtures that follow the verdict-store and environment changes, a runtime identity that strips every git exec-dir copy, the lockfd and send-serialization test fixes, and a per-test cap that never cuts off a land command before its own deadline. The macOS suite fence is opt-in until it passes its own full-suite control, and claim-cut enforcement is held back until it admits repos without a declared cut.
- Bead admission now requires acceptance that `omp-kit verify` can replay (REPLAYABLE1). `br create` refuses an acceptance box (other than `[v]`) that names no backticked command, or whose tags are not one scope letter then one phase (`[a,b]`, `[a] [b] [build]`, `[after 7d]`), with `r-verify-replayable:ACCEPTANCE_NOT_REPLAYABLE` naming the box and printing the corrected shape ``- [ ] [a] [build] <what it proves> `<one bounded command>` -> rc 0``. A content update refuses only the boxes it adds or changes; unchanged legacy boxes are reported on an `ACCEPTANCE_NOT_REPLAYABLE_LEGACY` line.
- `br update <id> --claim` and the move to `in_review` are refused `REFUSED_NOT_REPLAYABLE` (through `br-shim.sh` and the update lint) until the bead's acceptance is replayable, naming each bad box; rewrite the boxes, then claim again (J-2026-10-29-22).
- The lint uses verify's own grammar: `scripts/box-lint.ts` runs `parseBoxes`, `commandOf`, `expectedOf` and `unreplayableReason` from `src/verify.ts`, and ships bundled in the release, run by the release binary. `python3 scripts/bead_lint.py --replayable-report --repo <tracker>` lists the in-scope beads verify cannot replay; it only reports.
- Acceptance with backticks must reach the guarded `br create` in a quoted heredoc (`--acceptance "$(cat <<'EOF' ... EOF)"`); a backtick in a plain shell word is still refused `BEAD_LINT_UNEVALUABLE` (ompkit-fp72.135.3.49).
- A box whose first backticked span is not followed by `->` or `expect:` is now refused (`command-not-followed-by-expected`) by both `br create` and `omp-kit verify`, because verify runs that first span: quoted obligation text such as `br update <id> --status in_review`, `scratch new`, `brew list --versions` or `ask` would otherwise run against the real system. Quote an obligation's own commands with single quotes, or put ``Replay `<cmd>` -> <expected>`` first. Commands with no expected outcome are refused the same way rather than judged exit-only.
- `omp-kit verify` no longer has an exit-only judgment. A box whose arrow names nothing (`` `cmd` ->; ...``) is refused `command-not-followed-by-expected` like the others, so every replayed box is judged by its named outcome; the `outcome` field is gone from each `replays` entry of the JSON result and the close reason no longer lists `exit-only boxes:`.
- `scripts/box-lint.ts` no longer emits the always-empty `exit_only` field, and the create and update lints no longer print `REPLAYABLE_EXIT_ONLY` notices.
- `omp-kit verify` reads a box's expected outcome only from the text right after its first backticked span (the command it runs); an arrow elsewhere in the box is never the expected outcome. A box with `->` in its obligation text before that command is refused `arrow-before-command` by both `br create` and `omp-kit verify`, because earlier readings judged such a box on its prose; quote the obligation's arrow as `'->'`, or put ``Replay `<cmd>` -> <expected>;`` first.
- Retain bounded, secret-redacted handler exception class, message, and stack frames in `HANDLER_FAILED` responses and private diagnostics files. Remediation names the file actually written; unavailable diagnostic storage preserves the original failure without changing exit code 1 or `UNVERIFIED`.
- Preserve the structured failure even when the thrown value cannot be inspected or converted to text; cause formatting must not crash the CLI.
- Record schema-v2 full-suite and focused-gate evidence with per-file wall/CPU time, exit status, command, source closure and producer identity; retain queryable timing CSVs and durable native-format timing maps.
- Refuse successful but over-budget changed tests at push, naming their measured duration and cap. Report the 225-second cap as an initial heuristic; reject impossible aggregate cycle lower bounds without claiming a latency guarantee.
- Bind reusable verdicts, focused coverage and tag admission to the complete authoritative judge dependency set. Reject incomplete or stale records, isolate per-run claims and propagate cancellation through nested file supervisors.
- Split the two test files that crossed the 225-second per-file budget under machine load into balanced parts with shared helpers, every test unchanged: private-index-land (75 tests, three files) and check-staged-kitlib (84 cases, three parts). CI runs every part. (commit 5b31e2b)
- The per-file 225-second test cap now reports OVER_BUDGET without refusing the push, until it is derived from measured per-file times; the aggregate makespan bound still refuses. (J-2026-10-31-01)
- The kit-update N+2 release fixture copies .github/test-budget.json, which package-release now reads.
- `omp-kit land` archives the hermetic suite runner files (scripts/suite-hermetic-env.sh, scripts/kitlib_tmp.py) with its full-suite judge when the base tree has them, so landing no longer ends LAND_FULL_SUITE_UNRUN (exit 77) on bases that carry the HERMETIC1 suite runner; older bases keep the old judge set.
- The land test fixtures are copied from one git-built template, and a fixture git spawn that runs past its load-scaled deadline is reported as TIMEOUT_UNDER_LOAD with the load average instead of a bare failed git.
- Restore PATH-selected tracker reads and the existing non-claim time budgets for review and close preflight; claim admission retains its explicitly bound tracker and three-second read limit.
- Claims now use one native milestone-cut predicate in preflight, the agent guard and the br shell bridge. A declared cut admits its pins and open blocking prerequisites; unrelated, closed and parent-child-only relatives are refused. With no declared cut, this check admits stock claims without requiring operator-specific pillar labels.
- Explicit tracker bindings do not escape a managed checkout's cut. The shell bridge requires exactly one internally consistent native adjudication and refuses missing, stale or malformed authority rather than maintaining a second cut policy.
- Native authority envelopes are decoded by a packaged, bounded Python helper instead of embedded command-substitution code. This keeps mandatory shell analysis complete while preserving claim decisions and malformed-authority refusals.
- Scoped doctor initialization follows the declared component requirements before optional OMP discovery. Gates retain their real review, claim, creation and admitted-control probes without querying an unrelated OMP launcher or provisioning its sources; unscoped, OMP and policy inventories keep their identity checks.
- The release carries the shell bridge's creation-guard entrypoint. Archive coverage now exercises the real compiled guard outcomes instead of checking source-file shipping lists.
- Fleet Watch can plan single-bead builder/grader goals from a declared milestone cut, preserve active holders and busy seats, and retire stale idle scopes. Explicit pauses require an owner, reason and expiry; supply warnings and overdue cut escalation reach director/chief reporting without automatically resuming paused sessions.
- Automatic kit updates now retire older installed releases and their poll downloads only after a successful update, keeping the active release, its two preceding installed versions, the updater's running release, and newer staged versions. Partial updates preserve recovery artifacts; cleanup failures are recorded as findings.
- `omp-kit verify` now runs each distinct replay command once per export, judges each box against its own expected outcome, and reports replay progress on stderr.
- Pre-push uses the pushed tree's own gates and full-suite runner, qualified once by candidate selftests through the base-owned bounded executor. Base policy checks and required contract inventory remain enforced; removing a required runner is refused. Archive judging resolves commit objects from the caller's repository and records a main-role verdict instead of borrowing base qualification.
- Full-suite judging and suite execution discard inherited `BEADS_DB`, `GIT_DIR`, and `GIT_WORK_TREE` instead of refusing before the suites run; per-test tracker selection and existing write/network fences remain unchanged.
- Test runners can scrub suite environments, isolate HOME/XDG/Git config and set a Git ceiling; unsafe inherited Git/tracker authority fails before tests. The scrub (OMP_KIT_SUITE_HERMETIC_ENABLE=1) and, under it, the macOS write/network fence (OMP_KIT_SUITE_FENCE_ENABLE=1) are opt-in until the full suite passes under them: the full suite on the published batch failed 100 tests under the scrub, so suites run with the caller's environment as in 0.2.80, in their own owned TMPDIR. Both stay tested on every run. Tests no longer depend on the developer's HOME: PyYAML, the flywheel probe, the bun-global OMP package, a global git ignore, AGENT_NAME and the depth of HOME are provided by each fixture, and every bun test runs at umask 022.
- `omp-kit full-suite verdict list|get` inspects the shared, repository-scoped verdict store, including each record's tree, judge role/check/runtime identity, verdict and integrity state. The runtime fingerprint also strips Git's exact leading exec-path entry from hook `PATH`, so a land-created PASS is reusable by pre-push; other `PATH` changes remain identity-bound.
- Refuse `in_review` and `DONE` handoffs without a complete passing fresh-gate observation for the exact source commit in its source checkout; refusals name `sh scripts/fresh-gate.sh --commit <sha>`. Metadata trackers and observations for another commit cannot qualify the handoff.
- Reject in-review admission when a passing pregrade does not identify a valid candidate commit.
- Carry the complete measured-judge helper closure in save-first test fixtures from both Git checkouts and stamped history-free exports, preventing missing-helper failures without weakening the original component or source-identity assertions.
- Refuse tracker closes whose evidence admits unrun, unverified, skipped, or limited acceptance checks; report the incomplete clause while preserving completed-evidence controls.
- The worker `ask` refusal now names the held bead even when the session cwd has no `.beads` ancestor. It reads every tracker the session reached plus the cwd's own, and lets br discover from the cwd. It used to fall back to "the bead you hold", so ASKBLOCK1 failed 7/2 whenever TMPDIR was outside a tracker.
- A director or chief seat with an active goal can no longer open an `ask` that names a recommended option (ASKDEFAULT1). The guard refuses the dialog, names the recommended option, and tells the seat to take it, record it as a decision (rule, alternatives, who may overrule), report it in the next REPORT and keep working. Goal state is the latest `mode_change` transcript entry. An `ask` with no recommended option, or with no active goal, is still allowed; builder and grader refusals are unchanged.
- The machine-specific shipped-path gate (PORTGATE1) is held back from this release: its new pre-commit member refused every commit in a repository without its baseline file, and twelve suites failed. It returns once a repository without a baseline is admitted and the full suite passes with it.

### Fixed

- The long-token CPU-budget regression keeps a 2x margin between its budget and its planted slow fire, so it passes under machine load and still fails real slow work; the exact-candidate land test and the inert-kit installer fixture no longer fail on load or on newly shipped pysafe helpers.
- bead-lint's mention-edge check (`i-mention-edges`) reads a bead id only as a whole id. A child id such as `ompkit-t7cn7.19` is never also read as its parent `ompkit-t7cn7`, so a child bead whose text says `discovered-from: ompkit-t7cn7.19` no longer has to carry a fake related edge to its own parent. A sentence-final id (`see ompkit-x.`) still counts as a mention, dotted ids such as `ompkit-x.19.2` stay whole, and the selftest proves the old word-boundary pattern fails these cases. (ompkit-fp72.135.3.83)
- SENDFAST1 (ompkit-fp72.135.3.84): `omp-kit send` to a busy keyless Tern seat no longer holds the sender up to 300 s waiting for a turn boundary. A message to a BUSY seat whose composer record is EMPTY is pasted at once and OMP's native steering queue journals it (`PROVEN_STEERED`); a DRAFT or UNKNOWN composer is re-read for at most `TERN_STEER_BOUND_MS` (3 s), then `NOT_DELIVERED` with a drop copy and nothing pasted. A mid-turn seat (assistant awaiting tools) is observed as BUSY with its runtime binding only for this sender (`turnInFlightIsBusy`); keyed ctl turns and `/goal set` keep their turn-boundary admission. Fixture bench: busy seat from >5 s (capped; designed 300 s) to ~1.0 s.
- SENDFAST1 (ompkit-fp72.135.3.84): the Tern send proof read now ticks every 50 ms (`TERN_PROOF_POLL_MS`, was 1000 ms) within the same 20 s deadline, re-reading the session file only when its size grew, so a proven send returns about 50 ms after the entry is journaled. Observation and pane-lock retries keep their 1 s cadence (`TERN_OBSERVE_POLL_MS`). A file watch was measured and not used: Bun 1.4.3's `fs.watch` delivered no event on macOS while node's did. Fixture bench: idle and busy proofs from ~1.0 s to ~53 ms p50.
- SENDFAST1 (ompkit-fp72.135.3.84): the steer opt-in also reads a working seat as BUSY when its branch ends in context OMP injected for the model to answer next (a `custom_message` nudge or guard notice, a compaction, a branch summary, a `custom`-role message). Live, SilverCondor's goal-mode seat sat in that state for up to 26 s between assistant messages and refused `UNTIL_DELIVERED_EXHAUSTED` (`SESSION_ORACLE_STATE_UNKNOWN`) after the 3 s bound. Tern must still report the seat working; a finished turn waiting on an async job stays UNKNOWN.
- SENDFAST1 (ompkit-fp72.135.3.84): the session journal's active leaf no longer sticks at the last `model_usage.activeLeafId` hint once the branch grows below it. From the hint the parser follows the unique child chain to its tip, ignoring hint-carrying usage entries, and stops at the first fork. Live, a hint OMP wrote beside a forked `memory` usage made an idle send prove `ENTRY_OFF_ACTIVE_BRANCH` after 20.8 s (PENDING_CONSUME), and the next 10 sends to that seat were `SUPPRESSED_PENDING`. A marker on a genuine sibling branch still never proves.
- SENDOMP1 (ompkit-fp72.135.3.85): the Tern send plane recognizes Tern's bundled OMP as OMP. A foreground whose argv[0] is an absolute `…/omp/versions/<major.minor.patch>` (Tern's launcher layout, process named for its version) is accepted; a version-named binary anywhere else stays `FOREGROUND_OMP_MISSING`. Before this, every send to a Tern-launched OMP seat (lead and chief seats) refused before any paste.
- SENDOMP1 (ompkit-fp72.135.3.85): the seat observer reads a foreground's start time and `AGENT_NAME` from `ps` by matching argv as one joined string, so a launcher path with its own space (`…/Application Support/Tern/omp/versions/…`) no longer reads `FOREGROUND_INCARNATION_UNAVAILABLE`. A token inside argv is still never read as environment.
- Postchecks report a watched regular file as `skipped-concurrent-writer` only after observing a further content change once the test runner exits; isolated-test writes and unconfirmed changes remain failures.
- Avoid tail-window-only observation failures in large Tern journals by progressively widening reads, retaining fail-closed branch checks and per-read byte accounting.
- `omp-kit intake` writes rule and work rows to its dedicated `intake.jsonl` ledger, preserving `decisions/joshua.jsonl` for schema-validated decisions.
- `omp-kit verify` sets `GRADE_WAVE_SCRATCH` to its per-run scratch in every replay's environment (VERIFYSCRATCH1). A selftest that builds fixture trackers under `GRADE_WAVE_SCRATCH` (`grade_wave.py --selftest`) now builds them inside the verify root; the read-only `br` binds implicit fixture-repo operations to that repo's local database, while a tracker outside the root remains refused as `READONLY_TRACKER`.
- Each replay's export now has `var/agent-tmp` (gitignored, so `git archive` omits it), and `KITLIB_TMP_ROOT` names it, as the fresh-gate and full-suite gates provide; a replayed test that asks kitlib for scratch under its repo root no longer fails `NotADirectoryError`.
- `br` admission now reaches Python and Bun subprocesses through the verified release shim. Review entry runs full lint and phase checks; create admission applies replayability lint. `doctor --scope gates` exercises review, claim, and create refusals on an owned tracker fixture without live tracker writes.
- Share load-scaled fixture process deadlines across land, stranded-work, scratch-release and diagnostic tests while preserving assertion and production bounds.
- Retain timeout output and resource context in fresh-gate failures, and verify ledger load/worker fields through the real selftest writer.
- `omp-kit update --reconcile` relinks covered OMP profiles to the verified release; incomplete relinks report NOT_RUN and non-OK instead of a successful reconciliation.
- Verification now reports independently confirmed missing OMP identity as an environment prerequisite, preserving review status and acceptance while requesting director attention; unrelated assertion failures still become REWORK.
- Actual assertion diagnostics take precedence when the same replay also reports a missing OMP identity; incomplete output cannot be classified as environment-only.
- Judge complete literal Python programs embedded in staged shell and TypeScript commands, retaining host source locations and refusing unresolved payloads.
- Bound existing Python helper processes and preserve standalone installer bootstrap through generated canonical supervisors, with release-time freshness checks and explicit truncation failures.
- Reap only incarnation- and ownership-proven interpreter orphans, preserve live/shared/unknown users, and omit inline programs from cleanup receipts.
- Bash write-ownership checks use the invoked command's working directory when validating reservation scope (commit 115db7d). The 0.2.80 notes listed this fix before its code shipped; they now carry a correction.
- bash-silenced-filter-pipe stays quiet when the pipeline is only quoted text in echo or printf, so the metamorphic ratchet passes and the release's package test runs.

## [0.2.80] - 2026-10-29

### Changed

- Restored `extensions/jev-memory-filter.ts` as a portable vendor: the
  machine-absolute re-export (`/Users/josh/.omp/jev-pinned/...`) is replaced
  by a self-contained local-Clef client (plain fetch to an explicit loopback
  gateway, exact committed calibration plus model fingerprint match, fail-open
  KEEP on every closed outcome). Policy entry restored in
  `policy/extensions.json`; `package.json` records it as profile-installed via
  that policy, not loaded through the plugin manifest.
  Covered by `tests/cli/absolute-imports.test.ts` (ABSIMPORT1: no absolute
  import/export specifiers; every production entrypoint bundles in an exact
  export with an empty HOME) and `tests/cli/jev-memory-filter.test.ts`
  (wire shape, loopback gate, invalid-noul, scoring-off, enforced prune,
  byte-exact round-trip, transport hold).
  (ompkit-ommaa)
- Set CLI and OMP plugin version metadata to 0.2.80, release train 4, cut by the lead under Joshua's release floor (J-2026-10-29-13). Reaches the installed kit: the full suite runs its shell suites five at a time, and a hung suite now ends at its deadline instead of running on (FULLSUITEPAR1); the release ships its installer members (PKGMEMBER1); a reconciled update relinks profile plugins before it reports OK (UPDATERELINK1); the close guard counts a bead's filer and DONE authors as authors (FILERCLOSE1); fixture trackers no longer lock the live parent tracker (BRINITPIN1); and the generated fleet-pack provenance is kept (10 commits). (ompkit-774u)
- Fixed release packages omitting installer-placed commit hook helpers: ship check-commit-kitlib-reversal.sh and the opt-in native-br-preserve.py helper. A PKGMEMBER1 regression test derives required scripts from the installer's place calls, helper loop, and member table and checks the release ship list.

### Fixed

- The full-suite verdict runs its shell suites `FULL_SUITE_SHELL_JOBS` at a time (default 5, never more than the online cores or the suites left to run) instead of one after another. Each suite runs under its own owned `TMPDIR`; its output and its GREEN/RED line join the log in sorted suite order, so the log, the GREEN/RED lines and the verdict counts do not depend on the worker count. The bun and python stages are unchanged. Measured on one tree at load 13-21 on 32 cores: the 54 shell suites took 1415 s one after another (whole run 2162 s, past the 1800 s bound); no worker count beats the longest suite (404 s), and 5 workers is the fewest predicted within 5% of that.
- The full-suite deadline now kills the whole suite tree. Its process walk kept the pid in a global that the recursion overwrote, so each TERM and KILL round reached only the last leaf: a hung suite's shell, and the runner, went on past `FULL_SUITE_TIMEOUT_SECS` (a 6 s bound took 40 s on a looping planted hang). A timed-out or incomplete run now names the shell suites that never finished.
- `SELF_CLOSE_REFUSED` now blocks the bead filer and every author of a DONE-first comment, even when another agent holds the assignment. Missing or malformed author metadata fails closed; an independent non-author can still close with evidence. (ompkit-l5746)
- `omp-kit update --reconcile` relinks covered OMP profiles to the verified release and reports failed relinks instead of a successful reconciliation.
- Bash write-ownership checks use the invoked command's working directory when validating reservation scope.

## [0.2.79] - 2026-10-29

### Added

- `docs/setup.md` lists every external tool the kit uses: required or optional, the kit feature it enables, how to install it on macOS and Linux, the command that verifies it, and what the kit does when it is absent. The README Installation section links it. `tests/cli/setup-tools.test.ts` fails when `omp-kit doctor --scope dicklesworthstone` probes a tool with no table row, and checks graceful absence on a clean HOME (plus a graceful `tern:`-send refusal with no Tern host). (ompkit-fp72.135.1.16)
- `src/diagnostics.ts` restores the `ntm` entry in `STACK_SOURCE` (commit 8f93195): the 9dc tree dropped it and the doctor probe reported no `ntm` row. `tests/cli/setup-tools.test.ts` now checks both directions (every probed tool has a table row; every table row is probed). (ompkit-fp72.135.1.16)
- `omp-kit slice-verify --overlay PATH [--test FILE...] [--changed-file F...] [--base SHA]` tests a proposed change against a clean export of HEAD (or `--base`), so other agents' uncommitted files in the shared checkout cannot blur the verdict. It builds an exact `git archive` export in owned scratch, links `node_modules`, overlays only the named worktree paths, and runs the named test files twice: on the export alone (base) and on the export with the overlay. Per file it reports pass/fail counts for base and overlay and classifies each failure as pre-existing (fails in both) or introduced (fails only with the overlay). Exit 0 when nothing is introduced, 1 on introduced failures, 2 when the setup, selection or judgment itself failed. A dirty foreign file that is not named in the overlay never reaches either run. The export's bookkeeping commit is hookless with a `[test]` message, a failed export setup is an error on which no test runs, and the overlay deadline is measured from the same file's base wall time (`TIMEOUT after Ns`, never `hang`). Test selection is the push gate's own selector plus every test that reads a changed file's test titles (`docs/flywheel-invariants.tsv`, `cases/*.tsv`). (ompkit-t7cn7.7)
- Linked the raw-process baseline maintenance (commit 12d7057) to the guard-runtime helper's migration to bounded kitlib execution (commit da37cf5).

### Changed

- Restored `extensions/jev-memory-filter.ts` as a portable vendor: the
  machine-absolute re-export (`/Users/josh/.omp/jev-pinned/...`) is replaced
  by a self-contained local-Clef client (plain fetch to an explicit loopback
  gateway, exact committed calibration plus model fingerprint match, fail-open
  KEEP on every closed outcome). Policy entry restored in
  `policy/extensions.json`; the stale `package.json` map line stays removed.
  Covered by `tests/cli/absolute-imports.test.ts` (ABSIMPORT1: no absolute
  import/export specifiers; every production entrypoint bundles in an exact
  export with an empty HOME) and `tests/cli/jev-memory-filter.test.ts`
  (wire shape, loopback gate, invalid-noul, scoring-off, enforced prune,
  byte-exact round-trip, transport hold).
  (ompkit-ommaa)
- Reimplemented check_i typed causal edges with mention-local patterns (at most two plain words, never across clause punctuation) so a causal word about another subject no longer demands a blocks edge; historical evidence with genuine discovered-from now passes, edgeless mentions still fail. Restored elapsed classification for numbered/bullet/prose acceptance including 24 h windows. (ompkit-fp72.135.3.36)
- Set CLI and OMP plugin version metadata to 0.2.79, release train 3, cut by the lead under Joshua's release floor (J-2026-10-29-13). Reaches the installed kit: worker seats can no longer open a blocking ask dialog (ASKBLOCK1), native verify surfaces the failing child's output and binds reviewer identity, replay pins its own tracker, fixture trackers and databases are pinned so tests stop writing the live tracker, history-free ratchet inputs, the activation manifest applied in full by update, doctor activation opt-outs recorded with reasons, and the compaction and composer fixes since 0.2.78 (79 commits). (ompkit-t7cn7.17)
- Fixed fixture tracker initialization to bind each fixture's own database; staged and pushed-range ratchets now refuse unpinned `br init` and fixture calls inheriting caller `BEADS_DB`; fresh-gate Bun tests use an exact-tree-local `TMPDIR`.
- The verifier now binds its owned replay fixture to an explicit database, preventing nested runs from opening or locking an ancestor tracker.
- Refuse `ask` dialogs for fleet-roster builder and grader seats, directing them to QUESTION mail with their in-progress bead (or “the bead you hold”). Director and unbound sessions may ask; unreadable rosters explicitly warn and fail open. The guard uses the fleet launcher's AGENT_NAME or existing Agent Mail pane identity, with an injectable roster path.

### Fixed

- Enable this Bun-based repository's tests and typechecks through its optional project-local RCH routing policy, preserving existing compiler entries and leaving user-wide configuration unchanged. Frozen-source validation still requires the pinned runtime and verified source-bound inputs.
- `omp-kit verify` now parses the native tracker acceptance grammar without
  dropping phase-only boxes (ompkit-fp72.135.3.17.1). The letter is optional
  and `after` joins the known phases; untagged prose still is not a box, and
  the `[v]` verification-note skip is unchanged. A tag that is neither a
  single letter nor a known phase, and a box with no replayable command, are
  named by index and fail closed (ACCEPTANCE_NOT_REPLAYABLE) instead of
  disappearing. `live`/`after` items are never executed as build items:
  they report a typed pending result and the verdict is PENDING, never PASS.
  Only executed-and-passed boxes are ticked. Covered by
  `tests/cli/verify.test.ts` (18 tests: original GATESET1 phase-only input
  yields exactly 2 ordered boxes with retained build phases; mandatory-letter
  mutant finds none; unsupported and commandless planted negatives name the
  indexed box with no tracker mutation; export-failure and gate-report
  failures fail closed; live/after pending with no tracker mutation;
  phase-only REWORK; `[v]` skip).
- Record a safeguard opt-out with `omp-kit activation opt-out --item ITEM --reason TEXT`; empty reasons are refused and nothing is recorded. (ompkit-fp72.135.3.77)
- Ship the hook installer and member-source closure (`install-commit-msg-bead.sh`, `install-pre-push-gate.sh`, member scripts) in the installed release so `doctor --scope activation` hook rows have an executable remedy path. (ompkit-fp72.135.3.77)
- A `br update <id> --claim` on a bead carrying an unresolved `needs-director` label is now refused before the real tracker mutates. The `br` shim relays the native claim-preflight verdict (`BR_SHIM_NEEDS_DIRECTOR`) and adds no second policy, names, or roster; an inconclusive probe passes through with a warning, and an explicit `--db` redirection skips the probe. (ompkit-izpwd.1)
- Ratchet real-withdrawal inputs now prove path-set equality and per-path blob identity against the manifest before any replay runs, and planted corrupted-blob or dropped-path capsules fail closed with no fixture created. Fixture Git calls keep the caller's `GIT_CEILING_DIRECTORIES` so no enclosing checkout can leak into the replay. (ompkit-axz7m.11)
- `extensions/kit-composer-state.ts` resolves the late pane registration race (RESTARTRACE1): the seat registry lists a Tern block only while omp runs in it, so a restarted seat can start before it is re-listed. The fleet opt-in is now resolved on every tick until on, then the composer record publishes on that first tick; a pane that is never listed stays silent tick after tick. The old session_start-only decision is replaced by the per-tick decision. `extensions/kit-composer-state.test.ts` proves the first-tick publish, the never-listed silence control, and the old-decision planted negative. (ompkit-t7cn7.18)
- `omp-kit verify` no longer throws on dotted bead ids before exporting the
  candidate (ompkit-t7cn7.20). The scratch label is the constant `verify`
  while the exact bead identity still travels in the allocation metadata, so
  `verify-ompkit-t7cn7.18`-style derived labels cannot reach the kitlib tmp
  label grammar. The label grammar itself is unchanged. Covered by
  `tests/cli/verify.test.ts` (20 tests: a dotted bead id proceeds past
  scratch allocation through the real `verifyBead` path with per-box
  replays; an unresolvable bead names the unmet tracker prerequisite
  with zero writes; all prior planted negatives unchanged).
- A missing tracker binding now names its unmet prerequisite instead of a
  bare exit code. When `br show` cannot resolve the bead, the refusal
  names the sought bead and the bound tracker's own identity (read from
  `br where`, never hardcoded), so a wrong or empty tracker reads as
  the unmet prerequisite rather than `exit N with no message`.
- `omp-kit verify` replays now run behind a per-run read-only `br` dispatch,
  so a replayed command can never mutate the production tracker through the
  supported dispatch (ompkit-t7cn7.21). `src/verify.ts` resolves the next
  existing `br` delegate once, installs `src/kitlib/readonly-br.ts` (a
  portable POSIX `sh` shim, no new runtime dependency) at the front of the
  replay `PATH`, and keeps trusted metadata reads and final acts on the
  real binding. Reads pass through; any other subcommand is refused with
  the `READONLY_TRACKER` marker (exit 77) unless its effective `--db`
  names the explicitly admitted per-run owned fixture, which the verifier
  creates with `br init` in owned scratch only when the acceptance
  references `OWNED_TRACKER_DB`, and fails closed otherwise. When a harness
  designates `GRADE_WAVE_SCRATCH`, the per-run scratch (and the owned
  fixture inside it) roots there, so replay fixtures live where the ambient
  `br` authority permits writes. Covered by
  `tests/cli/verify.test.ts` (22 tests: a computed behavior probe
  (shell arithmetic verified at replay, not echoed text) plus
  explicit/bound/same-repo reads on real trackers beside the exact code
  export; ordinary, env-stripped and implicit-inherited writes refused
  with the whole tracker state (journal plus sqlite bytes) byte-identical,
  the owned write admitted, and neutralization making the fixture fail)
  and `tests/cli/runtime.test.ts` (native guard checks at the `sh` seam;
  the exact source and the official compiled `omp-kit` verifier both reach
  the guard on owned fixtures, with source/binary/input digests recorded —
  the guardless binary executes the mutation and fails the box while the
  new source refuses it — plus `verifyBead` and CLI-driven close smokes).
- Native `omp-kit verify` now binds the explicit reviewer identity on every
  durable `br` mutation it performs (intake, REWORK, acceptance ticks,
  reviewer-gate report, close) by passing `--actor <reviewer>` on each
  generated act, instead of letting `br` default to the host user. Previously
  the close reason named the reviewer while the native audit trail recorded
  the ambient user, breaking non-author close attribution.
  Covered by `tests/cli/verify.test.ts` (VERIFYACTOR1 durable-audit cases:
  reviewer on ticks/gate/close and REWORK, same-tracker control untouched,
  author-refusal and dry-run leave state/audit unchanged).
  (ompkit-t7cn7.24)
- Every `scripts/install-*.sh` refuses an argument it does not know with a usage
  line and exit 2 before anything is written (ompkit-t7cn7.9). Previously only
  `install-extensions.sh` refused (and only `$1`); the rest ignored unknown
  flags, and `install-pre-push-gate.sh --check` installed the fresh gate
  instead of reporting. `install-pre-push-gate.sh` gains a read-only `--check`
  matching `install-commit-msg-bead.sh`: exit 3 with `MISSING`/`STALE` lines
  when the installed `40-omp-kit-fresh-gate` member differs from the repo's
  `scripts/pre-push-gate.sh`, exit 0 with `hooks fresh` when current, no writes
  in any `--check` path. Covered by `tests/cli/install-flags.test.sh`
  (45 assertions: per-script planted unknown flags, extra positionals, and
  missing/fresh/stale check runs, each proving byte-identical hooks).

## [0.2.78] - 2026-10-27

### Added

- Every kit safeguard is on by default and reported by a new read-only scope: `omp-kit doctor --scope activation --json` lists each rule pack entry, plugin extension, kit service, per-repo hook member and profile plugin link as ON, OFF-WITH-REASON or OFF-NO-REASON, and exits nonzero while any item is off with no recorded reason. An opt-out records item, reason, actor and time; an empty reason is refused. No apply verb is included in this slice. (ompkit-fp72.135.3.77)

### Changed

- The definition of done now has three separately reported stages that match the local release route. A change is **accepted** when it is on `main` with an exact-tree full-suite PASS and a non-author acceptance re-run at that commit. It is **published** when a `scripts/release-local.sh` cut contains it. It is **running** when the intended consumer is shown to load that release. Green CI is no longer a requirement while the CI pipeline is suspended. A task is done at the stage its acceptance names, and releases are cut as soon as accepted work is on `main` (AGENTS.md "Landing the Plane", ROADMAP.md, docs/release-procedure.md section 7). (ompkit-fp72.135.3.4)
- An admitted two-path withdrawal whose staged bytes differ from X's parent on one path is refused naming the parent entry, and the same commit with parent-exact bytes passes (check-staged-kitlib.test.sh origin-admitted-parent-*).
- Set CLI and OMP plugin version metadata to 0.2.78, release train 2, the hardening release: every fix for a stall in the 0.2.77 cut (exact-archive tests, a recorded rerun of an environment-caused suite failure, a hermetic tracker fixture, the tag push read against the cached full-suite verdict, CI-only tests run before the tag, update fetching its own attestation bundle) reaches the installed kit, with the rules doctor reading what each profile loads and the new activation scope. (ompkit-fp72.135.3.78)

### Fixed

- ARCHIVEMODE1 (ompkit-774u.34): `tests/cli/file-modes.test.sh` judges its four scripts from the tree it runs in, with no `OMP_KIT_CASE_CWD` needed. In an exact `git archive` export (revision stamp substituted, nested anywhere) it reads the exported files' own executable bits — tar preserves the committed bit — consulting no ambient Git object store, so an enclosing checkout cannot mask a committed 100644. In the live repo it still reads the committed tree (HEAD), so a dirty worktree chmod cannot mask one either. A real committed 100644 still fails in both layouts.
- The tracker-retention fixture test no longer resolves to an ambient tracker. Its `br` helper passes `--db <repo>/.beads/beads.db` on every call and scrubs `BEADS_DB`, `BEADS_DIR`, `BD_DB`, `BD_DATABASE`, `BEADS_JSONL` and `BEADS_CACHE_DIR` from the child environment, so `br init` can no longer reach the live tracker through an exported selector the way tonight's run did through `companion/.beads` (exit 2 on the held live DB). Replayed with an owned broken outer tracker and a hostile `BEADS_DB`: before, the unpinned call resolved to the outer tracker and failed; after, every call uses only its own fixture tracker and an owned sentinel stays byte-identical. (ompkit-fp72.143)
- A compaction no longer blocks a seat: the flywheel guard does the reread itself and tells the seat what it holds instead of halting it. On every compaction the guard now sends one summary naming the nearest AGENTS.md, listing the seat's held beads (or saying none held), and naming any tracker it could not read with its error. (ompkit-j27dd)
- Pushing a brand-new tag whose target is already on the pushed-to remote's main skips fresh-gate but never the full-suite verdict: the gate fetches the literal refs/heads/main from the pre-push $1 remote (origin fallback when the chain runner drops argv, named in the line), confirms the target is an ancestor, reads the verdict for the exact target commit back from its cache, and admits only on VERDICT PASS. A cache miss is refused with the command that produces the verdict, never a silent suite inside the push. Tag moves, tags pointing off main, and branch pushes still run the full gate. (ompkit-t7cn7.2)
- `scripts/full-suite-verdict.sh` accepts `--rerun-reason TEXT` for a recorded rerun of a cached FAIL. The old entry is kept beside the cache as `<tree>.superseded-<utc>.{json,log}`, the suite runs again, and the new entry records the reason, the actor (`AGENT_NAME` or `USER`) and the superseded entry's digest. An empty reason is refused and nothing reruns; a cached PASS is still reused, never rerun. Retrying an environment-caused FAIL no longer needs a hand file move. (ompkit-t7cn7.4)
- The three test files the full-suite verdict leaves to CI (package-release, kit-update, external-live) ran nowhere while CI was off. `scripts/release-local.sh` now runs package-release.test.ts and kit-update.test.ts on the exact-commit export before tagging, and any failure stops the cut (exit 4) before a remote write, in dry runs too. external-live stays out because it needs the host's real OMP launcher and a local mock server. kit-update's N+2 test no longer copies the gitignored MANIFEST.tsv from the live tree; it regenerates it with the source's own `scripts/build-manifest.sh`, so it passes on an exact export. (ompkit-t7cn7.5)
- `omp-kit update --apply --index I --archive A` no longer refuses `KIT_ATTESTATION_BUNDLE_MISSING` when no `A.sigstore.json` sits beside the archive. It fetches the bundle itself — `gh api repos/<repo>/attestations/sha256:<archive digest>` with `--jq '.attestations[].bundle | tojson'`, exactly as `scripts/release-local.sh:383` and `kit-update-job.ts` do — then verifies it with the same verifier. A co-hosted bundle still wins; only an absent sibling triggers the fetch, into a private snapshot (the operator's source tuple is untouched). An unreachable authority refuses `KIT_ATTESTATION_BUNDLE_UNAVAILABLE`, a wrong bundle `KIT_ATTESTATION_UNVERIFIED`. Authority: `OMP_KIT_UPDATE_REPO` or the `JYeswak/omp-kit-companion` default. (ompkit-v66l.22)
- The update postcheck no longer fails on volatile third-party browser caches churning under the watched state root. On 2026-10-27 a long-running Chrome the kit did not start (pid 12023, `--user-data-dir` under the kit state root) wrote `chrome-jfp/Default/Cache/Cache_Data/` during the isolated test and PARTIALed the 0.2.77 apply (receipt 32e9590f). `snapshotWatched` now skips the regenerable Chromium cache subtree names (`Cache`, `Cache_Data`, `Code Cache`, `GPUCache`, `DawnCache`): the kit never writes these under a watched root — its own caches live in the isolated run's private XDG dirs and release bytecode caches are pre-sealed read-only — so the skip cannot mask a kit write, while a tested-process escape to any other operator path, a non-cache profile write, and a missing live scenario still fail. (ompkit-v66l.22)
- `doctor --scope rules` probes each OMP profile in an isolated HOME that now carries the profile's plugin scope (lock files, `node_modules` links, marketplaces) and its native overlay rules, and both probe commands share one isolated HOME per profile whose paths are mapped back before comparison. Profiles with a linked release again report 0 missing kit rules with `plugin_version` set, and `kit-standing-law` reports loaded through the always-apply method instead of missing. A profile with no plugin link reports every kit rule missing; a profile linked to an older release reports STALE. (ompkit-rc-epic-land-fix-release-dogfood-rz5.82)

## [0.2.77] - 2026-10-27

### Changed

- Withdrew the unreleased bead-reference and elapsed-acceptance lint changes after independent review found false dependency requirements; the previous lint behavior remains, and the repair stays open. (ompkit-fp72.135.3.36)
- Set CLI and OMP plugin version metadata to 0.2.77, release train 2: the bounded Tern send, the chief mail-wake path, the scoped staged-kitlib reversal gate and every fix published since 0.2.76 reach the installed kit; the unqualified 3cbef process-identity change is withdrawn. (ompkit-fp72.135.3.47)
- The claim-gate rework committed after 0.2.76 (commits 5282402 and 09cd2eb) was withdrawn before this release (commit a598187), so `br update --claim` is still not lint-gated, as in 0.2.76. (ompkit-fp72.135.3.50)
- The staged-kitlib ratchet limits published-origin exceptions to exact incumbent raw-spawn entries and requires a complete, named `Revert: X` parent reversal with per-path commit-msg verdicts; ordinary and non-excepted findings remain enforced.
- A `Revert:` trailer on an ordinary commit (a root, partial or multi-commit rewrite with no published-origin admission) now gets the ordinary ratchet verdict instead of the exact named-X proof, so declared rewrites judged by the stale-worktree gate are no longer refused; active ratchet findings are still refused.
- Withdraw the unqualified complete-suite cancellation candidate. Restore the incumbent gate, `pysafe`, and source-archive behavior; no new cancellation guarantee is claimed. The original cancellation-boundary repair remains open for independently verified work.
- Remove the residual cancellation-carrier copy layer from the pre-push fixture after the owner-safe process-identity withdrawal. Retain separately reviewed cache-integrity fixture maintenance; no cancellation guarantee is added.

### Fixed

- Include the shared gap scanner and its findings library in release archives; refuse candidates with missing extension script references or a packaged gap callback that cannot allow cited input and refuse unfiled input.
- Bundle the inbox-wake extension's local runtime helpers so packaged extension loading does not depend on checkout-only source files.
- A restarted seat keeps its mail wakes. The inbox-wake extension now checks whether the seat's project is opted into the fleet on every poll until it is, instead of only once when the session starts. The seat registry drops a pane while its omp is down, so a seat that restarted before the registry listed it again never read its inbox for the rest of its life. (ompkit-fp72.135.3.60)
- Tern sends now verify the target OMP process's `AGENT_NAME` against the pane identity in the caller's separate `AGENT_MAIL_PROJECT`, rechecking process and session identity before delivery. A matching live runtime can identify a legacy-unverified pane without relying on stale fleet-watch state; mismatches still refuse before sending.
- Tern sends report target `AGENT_NAME` drift from the resolved Agent Mail identity as `SEAT_REBOUND`; route tests prove zero sends both before dispatch and when the name changes between observation and identity resolution.
- Register the mail-wake extension's cursor file and ledger in the ownership registry, so the pid-writer lint accepts `extensions/kit-inbox-wake.ts` and records its real cancel, crash and respawn limits.

## [0.2.76] - 2026-10-26

### Added

- Fetch-backed source quotes with `sources.py add/check/verify` and the opt-in `52-omp-kit-staged-sources` pre-commit member: refuse memory citations, unresolved sources, unregistered links beyond a shrinking baseline, and tampered excerpts; claim-to-quote faithfulness remains a non-author review.
- Help now points to automation discovery, presence checks, next actions, and authoritative schema exit categories. (commit cb72d3b)
- Discovery publishes contextual custody and heavy exit contracts, including unchanged child exits and route-specific retry guidance, without renumbering global exits. (commit b63cfa1)
- GATEEVENTS1 (ompkit-fp72.135.3.12): one gate-events ledger, `$XDG_STATE_HOME/omp-kit/gate-events.jsonl`, rows `{ts, seat, act, target, gate, kind, attempt, detail}`. `extensions/gate-events.ts` (`recordGateEvent`, `trackerAct`, `gateFromReason`) writes through kitlib jsonl with the lock beside the ledger; kit-flywheel-guard records every tracker act (`br`/`bd` claim, in-review, release, close, create) and every refusal it answers, with the tool call id as the attempt. The git hook chain runner (v3) records each member's verdict through `scripts/gate-event.sh` (installed beside the commit-msg chain with `kitlib_jsonl.py` and `kitlib_lock.py`), act `commit`/`publish`, attempt = the git pid shared by every hook of one command. New weekly service child `gate-rationalize` (operator argv in fleet-watch.json `gateRationalize`, 7-day interval, 600 s cap). The ledger never changes a verdict: a failed write is a `GATE_LEDGER_UNWRITTEN` warning. The hook installer's own probes set `OMP_KIT_GATE_EVENTS_SKIP=1`, so installing a chain writes no ledger rows.
- GATEDIAG1 (ompkit-fp72.135.3.16): one complete diagnostic per act. `scripts/kitlib-findings.sh` (`kitlib_finding GATE CODE DETAIL REMEDY [FIX...]`) and `scripts/kitlib_findings.py` define the FINDING line grammar hook members print instead of exiting at their first defect; chain runner v4 runs every member to completion, collects every FINDING line into one envelope (`<act> REFUSED: N finding(s)` with remedy and `fix:` argv per finding; raw lines on stdout under `OMP_KIT_FINDINGS_JSON=1`), records each member's verdict in the gate-events ledger and exits once. A legacy member that exits non-zero without FINDING lines becomes one `MEMBER_REFUSED` finding, so conversion is incremental. Installer ships the helper beside every chain and upgrades v3 runners.
- `omp-kit preflight commit [--message FILE] | claim|in-review|close BEAD --json`: runs every check the act will face side-effect free and prints one envelope bound to a snapshot (staged tree id or the bead's updated_at). `preflight commit` also runs each staged script's own `--selftest`, the gate that was missing when a NameError reached origin on 2026-10-25. `src/kitlib/findings.ts` is the TypeScript half of the grammar.
- Packaging bundles `extensions/gate-events.ts` (it imports src/kitlib), so the staged-package load probe passes; the first GATEEVENTS1 publish was refused by it.
- Fix: the preflight and verify handler registrations were committed inside `rchLeaseCommand`'s body (the working tree had the right order; a partial stage split the hunk), so every `omp-kit preflight …` and `omp-kit verify` was HANDLER_UNAVAILABLE on origin 9c567a2a..fb545ce9. Found by the non-author verifier of GATEDIAG1. Two CLI-level tests now assert the handlers are registered at module load (planted: they fail on the previous tree).
- AUTOCOMPLETE1 (ompkit-fp72.135.3.17): on a `git commit`, kit-flywheel-guard completes what the kit already knows from `extensions/commit-autocomplete.ts`: the `Bead:` trailer from the seat's live Agent Mail reservation reason, a `changelog.d/<bead>.md` scaffold (a draft) when none exists, and `Supersedes:` trailers from blame of the removed lines; each completion is an `AUTO_COMPLETED:` notice and a gate-events `auto_complete` row. A staged path no live reservation covers, two covering beads, or a reason with no bead is one `COMMIT_INCOMPLETE` refusal listing every finding with its fix; nothing is guessed.
- `omp-kit verify BEAD --export SHA [--actor] [--family] [--dry-run]`: the one non-author close verb. Exports the exact commit into owned scratch, replays the command each acceptance box names and judges it by the box's named expected outcome (`-> 16 pass 0 fail`, `expect: prints X`, `rc N`), never by exit 0 alone (exit-only boxes are flagged in the close reason); refuses the author (NON_AUTHOR_REQUIRED), a box with no command (ACCEPTANCE_NOT_REPLAYABLE, back to intake) and a failing box (REWORK naming it); on all-pass ticks the boxes, reports the min_reviewers gate under the caller's identity and closes with the command log and the verifier family.
- `python3 -B scripts/bead_lint.py --bead ID --repo DIR [--json]` lints one bead from the live tracker before a claim. It reads with `br show` and `br list` (no flush, no tracker write), runs the same checks as the create and update gates, prints PASS or FAIL with the failing check names (or UNVERIFIED with the reason), and exits 0, 1, or 3 when the tracker cannot be read; `--json` prints the verdict as JSON instead. Dependency records in `br show` shape are normalized, so a bead that mentions another bead and holds an edge to it passes. (ompkit-fp72.135.3.32)
- Add role-aware, read-only `next` guidance with ranked worker/director actions, bounded optional adapters, explicit UNKNOWN evidence, and a git-only stock-checkout fallback.
- Patch construction applies the bytes already read and parsed, so replacing the patch file during fetch cannot publish an unselected hunk.

### Changed

- Commit-message checks identify unfiled prose gaps with `GAP_UNFILED`, a search remedy and a one-refusal retry; bead citations, reasoned `Gap-Bead` waivers and quoted test names remain accepted.
- Tracker-comment and `DONE`/`PROGRESS` mail checks reuse the same scanner.
- MACHINEMEASURES1 (ompkit-774u.9.22): `scratch release --now` records `sizeBytes` on its `release-deleted` row so M-REAPED-BYTES can sum it; `omp-kit heavy` sbh pressure deferrals carry the statfs reading beside the verdict (`...reports pressure; statfs: N GB free (P%)`).
- NODOUBLEPASS1 (ompkit-bp50d): a publish no longer pays for the same test files twice. The focused gate writes a focused-passed report (tree id + every file it ran GREEN) when `FRESH_GATE_PASSED_OUT` is set; `full-suite-verdict.sh --focused-passed FILE` subtracts those files when the report's tree is the candidate's, runs only the complement, and records the split (`covered_by_focused` in the verdict JSON, `covered_by_focused=N` on the PASS line). A report for another tree, or naming a file the archive does not enumerate, is printed and ignored. `pre-push-gate.sh` wires the two. Test: tests/cli/full-suite-complement.test.sh (same-tree complement, planted other-tree, planted failing complement, planted unknown name, control). The report also carries the judge's sha256 and the runtime; the verdict accepts it only when all three match its own.
- The full-suite verdict json records the focused-passed join decision (`covered_by_focused.join`: joined, absent, tree-mismatch:<tree>, judge-mismatch:<sha>, runtime-mismatch:<rt>, no-report), so a run that covered nothing says why without the gate's stdout.
- pre-push-gate keeps every gate.log (green runs too) under `<git-dir>/omp-kit/gate-logs/<sha>.<utc>.log`, local and uncommitted: the phase anatomy and the full-suite join line are no longer lost with the archive.
- Bare human invocation shows help without OMP; explicit status and machine-only flags retain presence checks. (commit e6c2b0d)
- Unknown discovery commands offer registry-validated semantic guidance (`inspect` → `status`, `diagnose` → `doctor`, `discover` → `capabilities`) before spelling suggestions. (commit ad467e6)
- Unknown flags suggest the exact spelling for a single-edit or adjacent-transposition typo, preferring the current command's own flags over globals (`--robto` → `--robot`, never `--root`); flag values are never echoed. (commit eefd8d6)
- MEASUREREG1 (ompkit-fp72.135.3.1): a registered mission pillar check may be `python3 <path> --pillar <id> [--json]` as well as `bun <path> --pillar <id>`, with the `omp-kit heavy -- ` prefix optional (an admission that defers must not make the check unrunnable). This repo no longer ships its own `.omp/mission.toml` or `scripts/mission-check.ts`: the mission record is a per-project file that lives with the project's tracker, and the fleet's checks are one runner over the plan's measure registry.
- Set CLI and OMP plugin version metadata to 0.2.76, release train 0: the stage-0 repairs published since 0.2.75 (bead lint CLI, hook runner and guard fixes, preflight and verify verbs, mail wake binding) reach the installed kit. (ompkit-fp72.135.3.23)
- Claims are not lint-gated in this release. The claim gate that refuses `br update --claim` on a bead failing bead-lint (J-2026-10-25-107) was committed (commit 4cbc1e8) and held out of this release (commit d7be7ee) until its source review completes; it ships in a later release. (ompkit-fp72.135.3.50)
- Prevent full-suite tests from inheriting the publisher's tracker database while preserving each test's explicit database choices and the publisher's repository validation.
- Made the linked-OMP runtime guard check observe the mock server’s published port state when filesystem notifications are absent, preserving startup deadlines and early-exit refusal.
- Fixed stale-worktree commit checks in linked worktrees used by `omp-kit land --patch`: invocation scratch now uses the existing owned temporary directory, preserving stale and foreign-bead refusal checks.
- `omp-kit send` labels seat text with agent provenance, preserves existing headers and bare slash commands, and refuses forged human senders.
- The on-main pre-push member refuses a push that creates or moves any remote branch other than `main` (SNAPSHOTPUB1, ompkit-v66l.14). Once the reservation check moved from pre-push to pre-commit, an unadmitted off-main commit pushed to `refs/heads/topic` passed the ordinary pre-push chain; only `main` is published now. Tags and other non-branch refs pass, and deleting a stray remote branch passes.

### Fixed

- MAILWAKECWD1 (ompkit-774u.38): the mail-wake resolver honours every configured chief seat (fleet-watch `chief` plus `chiefs[]`), each under its canonical project's identity hash, so a chief that launches above its repo (cwd ~/Developer) wakes. Exact match on agent, tab, block and cwd stays required; an unconfigured block under the same cwd, or a row naming another chief's block, is still NO_WAKE_PATH.
- Discovery and command help distinguish missing native tools from unavailable handlers, with remediation and a structured unavailable-command catalog. (commit b21a401)
- Attached string flag values preserve all equals signs, matching separate argument values. (commit 096fe00)
- `infra undo --apply` is a boolean flag: it no longer swallows the next flag as its value, so a request without `--yes` reaches the safe refusal. (commit 07df535)
- TERNADDR1 (ompkit-fixjo): `omp-kit send` to a Tern seat no longer refuses every fleet target with `PLANE_SEAT_UNBOUND`. The tab a block lives in is derived from `tern inspect --json` (`locateBlock`); the configured fleet session name is only checked against the derived session or tab (name or id), so a block that moved is `SEAT_REBOUND` naming where it is, and nothing about tab names is assumed in code. An empty window key is Tern's documented default window (AC2), no longer `TERN_WINDOW_UNBOUND`. Measured before the fix: 3,046 dropped sends since 2026-10-17; live probe after it reaches the seat observer (`SESSION_TURN_IN_FLIGHT` on busy chiefs, zero sends) instead of the addressing refusal.
- The land test fixture matches the project path land passes to Agent Mail (a realpath), so the suite no longer fails 50 of 72 land tests when TMPDIR is unset and temp paths go through the /tmp symlink.
- Heavy admission wait no longer limits admitted child runtime. Runtime budgets use `--max-runtime`, then `load.json`'s per-label `runtime_budget_s`, then `default_runtime_s` (10800 seconds); exceeded budgets terminate the child, escalate to SIGKILL after 10 seconds, and return 124 rather than admission deferral 75.
- `NO_WAKE_PATH` for an unbound chief now names the missing canonical repo identity file, without mistaking same-tab shell blocks for OMP seats.
- Refuse new unregistered URLs even when citation-debt counts stay unchanged; baseline allowances now name normalized URLs, only shrink, and reject legacy count-only baselines with migration guidance.
- Require registered citations in checked documents to have complete rows in docs/research/APPLICATION.md, including a gap bead for cited-only sources; staged checks use the staged application map.
- Hook chains and commit preflight honor members' shebangs, retain shell fallback for scripts without one, and report real policy refusals.
- Hook installation atomically replaces files so already-running hooks finish on their original bytes.
- The staged README check skips repositories without a README obligation while still refusing deletion of a required README.
- The config-facts rule (`kit-probe-readable-facts`) no longer reads a dotted bead id such as `ompkit-fp72.135.3.16` as a version number when the line also says `pinned`. A real version beside `pinned` (`"pinned": "0.2.75"`) still fires. On 2026-10-26 the false match rewound the omp-test director more than 70 times while it edited its milestone. (ompkit-fp72.135.3.16.2, part a)
- SENDANY1 (ompkit-fp72.135.3.20): `omp-kit send <label> tern:<id> <text>` now discovers an unregistered live block from `tern inspect --json`, binds its Tern session and cwd, and proves delivery from the session-file marker. A seat reported working, including an unknown session-oracle state, a temporarily unavailable session file or an unproven active branch, is wait-only: Tern sends queue for up to 300 seconds by default and report `QUEUED`→`DELIVERED` or `QUEUED`→`EXPIRED`; typing occurs only after an idle observation is fully proven. Closed blocks return `BLOCK_GONE`; modal or non-empty/unknown composers still refuse paste.
- Lock conformance tests terminate and reap their own FIFO inheritor without relying on a transient EOF handshake. Child exit waits remain asynchronous and bounded, preserving descriptor-inheritance checks and reporting a named timeout after forced cleanup.
- Bead lint's `elapsed-time-mix` check (TIMEAC1) no longer flags a runtime counter or a finished time item. "N consecutive" counts as an observation window only when it counts reports, runs or time periods (for example "6 consecutive hourly sitreps"); "after 3 consecutive wakes" is code behavior. A ticked time item can no longer hold a close open, so it no longer makes a bead mixed. The selftest now checks that controls pass as well as that planted violators fail; before, only the violators were checked. (ompkit-fp72.135.3.48)
- The same check now catches two time items it used to miss: an explicit dated window ("On or after 2026-10-27, ...") and a first armed run ("first armed run + live inbound call with ring proof"). Both real TIMEAC1 texts are selftest fixtures. (ompkit-fp72.135.3.48)
- The bead-lint update gate admits a content edit that repairs a failing bead without making it pass: when the checks the bead fails afterwards are a strict subset of the checks it fails now, the edit lands with a `LINT_REPAIR_ADMITTED` note naming what it cleared and what still fails. Before, a description repair was refused whenever an unrelated failure remained, even one only a checker change could clear. An edit that adds a failure or repairs nothing is still refused, and a content edit combined with `--claim` or `--status` is judged exactly as before. (ompkit-fp72.135.3.50)
- `omp-kit planning convert --apply` no longer refuses a whole plan because one item's bead is closed. A plan item whose bead is closed or deleted (tombstoned) is now reported as `SATISFIED_TERMINAL` and skipped, so the rest of the plan still applies, and new items that depend on it still get their blocks edge to the closed bead. Before, closing any bead the plan named stopped every later intake ("reused target … is terminal"). (ompkit-fp72.135.3.51)
- A closed bead is still never written. If the plan would change it (an acceptance box the bead does not have, or a contribution it never recorded), the apply refuses before any write and names the plan item, the bead and the missing boxes. No dependency is added from a closed bead (`SKIPPED_TERMINAL`), and a deleted bead is never reopened. (ompkit-fp72.135.3.51)
- The skill-stations config cites the fleet rule file as `~/.agents/AGENTS.md`, not `/Users/josh/.agents/AGENTS.md`, so the shipped kit holds no machine-specific path and the packaged kit's own invariant gate passes its shipped-config stage again. Three regex and slow-path station citations had carried the literal since SKILLSTATION1. (ompkit-fp72.135.3.53)
- Heavy runtime limits now default to sourced, exact-label budgets in `config/heavy-labels.json`, with no runtime limit for undeclared labels; `load.json` label budgets and `--max-runtime` override the table. The former global `default_runtime_s` no longer applies.
- Runtime expiry names its budget and source (flag or label table) and retains exit 124, separate from admission deferral 75.
- The pushed-notes validator now clears all six Git repository redirects before initializing and folding its temporary validation repository, including when invoked directly with an inherited linked-worktree environment.
- MAILWAKE1.2 (ompkit-uk9wn.2): a `send_message`/`reply_message` from a seat whose cwd carries no `.omp/fleet.json` is still guarded and woken when its `project_key` (the recipient's repo) has the fleet opt-in. Measured 2026-10-25: the chief tab runs in `~/Developer`, so three ack-required chief-tab sends (68908, 68915, 68917) bypassed every check, wrote no mail-wake row and signaled nobody; Joshua had to type "check inbox". Only a readable opt-in promotes; an absent or unreadable recipient repo keeps the sender's own policy, and bulk reads stay inert outside a fleet cwd.
- Fleet senders now require their actual pane identity; an environment name alone cannot authorize sending. Registration and session macros bind the caller's actual Tern session, reject another pane or identity, and refuse unknown registration keys before calling Agent Mail.
- Sends and replies without a native correlation ID are refused before persistence, preserving the join from a successful send to its wake ledger row. Existing background-recipient notices and failed-send behavior remain distinct from delivered wakes.

## [0.2.75] - 2026-10-25

### Added

- kitlib tmp, one owned-temp-dir primitive in three languages (ompkit-41l85, KITLIB-TMP v1): `ownedTmp(label, {root, bead})` in `src/kitlib/tmp.ts`, `owned_tmp(label, root, bead)` in `scripts/kitlib_tmp.py` (also a context manager), and `kitlib_tmp VAR LABEL` in the sourced `scripts/kitlib-tmp.sh`. Each makes `<root>/<label>.<pid>.<6 random>` (mode 0700, root defaults to the TMPDIR-honouring system temp) with a `.owner` that `omp-kit scratch` parses and that names the pid. `cleanup()` is idempotent, and a per-process registry removes every live dir at exit and on SIGHUP, SIGINT and SIGTERM, then lets the signal's default action end the process. After SIGKILL the dir survives with its `.owner` for the reaper. All three languages pass one corpus, `tests/fixtures/kitlib-tmp/corpus.json`, which includes a planted hookless child that must fail the SIGTERM case. `docs/kitlib.md` indexes the kitlib primitives.
- kitlib proc, process incarnation and typed liveness evidence (ompkit-5m6ej, KL09; the liveness half of PIDIDENT1 ompkit-a0vy1): `incarnation(pid)` returns `{pid, start}` from `ps -o lstart=` (LC_ALL=C, whitespace-collapsed), and `probeIncarnation({pid, start})` returns `live`, `zombie` (ps state Z), `reused` (same pid, different start), `dead` (not listed and signal 0 says ESRCH) or `unknown` (unreadable, never dead) with evidence; `isDead()` is true only for dead, reused and zombie. `src/kitlib/proc.ts` and `scripts/kitlib_proc.py` (ps through `kitlib_run`) pass one corpus, `tests/fixtures/kitlib-proc/corpus.json`, with planted negatives proving the zombie and reuse detectors. Observation only: no authority, no signal other than 0, POSIX only.
- kitlib io: one atomic byte-replacement primitive, `atomicReplaceBytes(path, bytes, { mode, durability })` in `src/kitlib/io.ts` and `atomic_replace_bytes(path, data, mode=, durability=)` in `scripts/kitlib_io.py`, both passing the one corpus `tests/fixtures/kitlib-io/corpus.json`. It writes all bytes to a fresh private temp (O_EXCL|O_NOFOLLOW, one link, our inode until rename), sets the exact mode whatever the umask, fsyncs the file for durability `file`/`full`, runs an optional validator on the complete temp, renames, and fsyncs the directory for `full`. Unsafe paths are refused with a named code (symlink or non-file target, preexisting/symlink/hardlinked/swapped temp, a stage on another filesystem or inside a declared public tree, EXDEV with no copy fallback); any failure before the rename removes the temp and leaves the target intact, and a failure after it reports `published: true` so a caller never assumes the old bytes remain. Durability is never implied: callers name `none`, `file` or `full`, and the result reports `fileSynced`, `directorySynced` and `durable` apart from publication. Read-modify-write still needs a lock (KL08). Seven companion writers (kit activation receipts, heavy jobs and locks, fleet-lessons reports, the attestation bundle, report-inject output, the omp test receipt, plugin receipts) and the two release-train records in `scripts/release_reuse.py` now use it at their existing durability. (ompkit-67i70, KL06)
- kitlib tmp can keep a dir past exit (ompkit-b3zgu, KITLIBDETACH1): TS `ownedTmp(label, { autoCleanup: false })`, Python `owned_tmp(label, auto_cleanup=False)`, sh `KITLIB_TMP_AUTO_CLEANUP=0 kitlib_tmp VAR label`. The dir and its `.owner` are the same, but no exit or signal hook removes it; `cleanup()` / `kitlib_tmp_cleanup` still does on demand, and the scratch reaper covers a crash. The conformance corpus gains three cases (normal exit and SIGTERM keep both dirs with a parseable `.owner`; cleanup on demand removes them) and a planted negative that creates the dirs with the default instead.
- The last raw temp sites in production now create kitlib owned dirs with auto-cleanup off, keeping their removal paths: the isolated runtime sandbox (`omp-kit-runtime.<pid>.<6>`, the shape `runtime-adapter.sh` already admits; its tempsafe suppression is gone), the `test --integrations` workDir kept by `--keep` (`omp-kit-integrations.<pid>.<6>`), the full-test producer artifact dir under `var/agent-tmp` (its `.owner` keeps `repo=` the canonical repo root), the staged kit release root (`kit-stage.<pid>.<6>`; the `.owner` is removed before the root is returned), and the LSP probe dir kept on an unconfirmed mux shutdown. The full-test cause redactor also hides `omp-kit-runtime.` sandbox paths.
- Commits and pushes can no longer add a temp dir made outside kitlib. `scripts/tempsafe_check.py` reports `raw-temp` for TS/JS `mkdtemp`/`mkdtempSync`/`fs.promises.mkdtemp` and any `tmpdir()` call; Python `tempfile.mkdtemp`/`mkstemp`/`mktemp`/`TemporaryDirectory`/`gettempdir` and `NamedTemporaryFile(delete=False)` (import aliases followed); shell `mktemp` in command position and `$TMPDIR` expansions; and, in every language, a path built under `/tmp` (`"/tmp/x"`, `"/tmp/" + x`, `` `/tmp/${x}` ``, `join("/tmp", x)`, `os.path.join("/tmp", x)`, `Path("/tmp") / x`, shell `/tmp/...`). A bare `"/tmp"` value such as a fake `cwd: "/tmp"` creates nothing and is not a finding. Comments, string bodies and quoted heredoc bodies do not count. Each finding names the replacement: `ownedTmp` (src/kitlib/tmp.ts), `owned_tmp` (scripts/kitlib_tmp.py) or `kitlib_tmp` (scripts/kitlib-tmp.sh). A line is excused only by a `tempsafe: <reason>` comment with a reason of two or more words; reasonless and unused pragmas are findings. The check is a ratchet: only sites added since HEAD (or the pushed base) block, so existing sites do not. `install-commit-msg-bead.sh` installs it as pre-commit member `50-omp-kit-staged-tempsafe` (bounded by `pysafe.py run`, fail-closed when a helper is missing, `GIT_INDEX_FILE` honoured), places `kitlib-tmp.sh` beside the pre-commit and pre-push members that source it, and `--check`/`kit-update`'s hook refresh track all of them; `pre-push-gate.sh` runs the same ratchet over the pushed range. The installer also removes the probe tracker's `-wal`/`-shm`/`.fsqlite-*` sidecars it used to leave in the temp dir on every install. (ompkit-dhmzg)
- kitlib has one bounded, strict local artifact reader for TypeScript (`src/kitlib/artifact.ts`) and Python (`scripts/kitlib_artifact.py`) (ompkit-gvp4j, KL10). `readLocalArtifact` refuses a URL-like value (`NOT_A_PATH`), a path outside the allowed root lexically or after realpath (`OUTSIDE_ROOT`), a symlink (`SYMLINK`, unless the file policy follows links within the root), a non-regular file (`NOT_REGULAR`), a hardlinked file (`HARDLINK`, unless allowed) and an input that is the same inode as a caller's output (`COLLISION`). It reads at most `maxBytes + 1` bytes (`TOO_LARGE`) and keeps `MISSING`, `EMPTY` and `CORRUPT` as separate outcomes. A successful read returns the exact bytes with realpath, dev/ino, size and sha256. `strictJson` refuses invalid UTF-8, duplicate keys at any depth, NaN/Infinity and overflowing numbers, trailing data and excess nesting, each with path, line, column and a reason. `strictJsonl` reports every refused row by line (blank, oversize, truncated last row, rows past `maxRows`, empty input, and the owner's validator findings) and never drops a row silently. Domain validation stays with the owner; `rejectUnknownFields` is the helper an owner's validator calls. Both languages pass one conformance corpus, `tests/fixtures/kitlib-artifact/corpus.json`. Each planted negative flips when its detector is bypassed, and the valid control passes with every detector bypassed.
- kitlib jsonl, a locked complete-write JSONL append and bounded reader (ompkit-ibgvg, KL11). `appendJsonl(path, build, {deadline_s, tornTail, durable, mode})` holds the KL08 private lock on the canonical target path, so TypeScript and Python writers exclude each other. Under the lock it opens the target O_APPEND|O_NOFOLLOW (a new file gets exactly `mode`, default 0600) and checks the tail. A torn last line refuses `TORN_TAIL` with evidence by default, or with `tornTail: "newline"` the record starts on a fresh line and the torn bytes stay. It then calls the caller's `build(state)`: a throw is `BUILD_FAILED` and nothing is written. If the path no longer names the opened inode it refuses `INODE_REPLACED`. The whole line goes out through a complete-write loop (`NO_PROGRESS`, `WRITE_FAILED`), and `durable` is reported only after the fsync returns (`SYNC_FAILED` otherwise). A lock timeout is the KL08 `DEADLINE`. `readJsonl(path, {maxBytes, fromCursor})` returns rows, every invalid line as an error with its line number and offset, a resumable cursor, an unterminated-tail count, and `reset: "rotated" | "truncated"`. `src/kitlib/jsonl.ts` and `scripts/kitlib_jsonl.py` pass one corpus, `tests/fixtures/kitlib-jsonl/corpus.json`, including concurrent TypeScript and Python writer processes and planted negatives for each refusal. No consumers are migrated yet.
- kitlib lock, one persistent private resource lock in two languages (ompkit-lsn3a, KL08): `privateLock(resource, {deadline_s, inherit, state_dir, signal})` in `src/kitlib/lock.ts` and `private_lock(resource, deadline_s=, inherit=, state_dir=)` in `scripts/kitlib_lock.py` (shipped in every release beside `pysafe.py`). The domain names a resource (`{namespace, path}`, canonicalised with realpath so aliases share one key, or `{namespace, name}`), never a lock path; the lock is the separate persistent file `<state>/<namespace>/<sha256(key)>.lock` under `$XDG_STATE_HOME/omp-kit`. Both halves take the same `flock(2)` on the same inode, so a TypeScript holder blocks a Python waiter and the other way round. A symlink, a foreign uid, a group/other mode bit, a second hard link or a replaced inode refuses with a typed `PrivateLockError`; the wait is monotonic and bounded and refuses `DEADLINE` with evidence; cancellation closes the owner descriptor; FD inheritance is opt-in and read back; `release()` closes the descriptor and reports `INODE_REPLACED` when the path no longer names the held inode. Nothing is ever unlinked, and neither file age nor a pid decides liveness. macOS and Linux only; other platforms refuse `UNSUPPORTED_PLATFORM`. One conformance corpus, `tests/fixtures/kitlib-lock/corpus.json`, runs every planted negative twice: refused as written, flipped with its detector bypassed.
- The `br create` admission guard (`scripts/br_create_guard_core.py`) now takes its tracker lock through kitlib lock: the same lock file (`create-admission/<sha256(realpath(db))>.lock`), the same 5 s bound and refusal messages, plus the inode and hard-link checks.
- Acceptance items now carry an evidence phase, and `in_review` can require a passing pre-grade (ACPHASE1 ompkit-9e9w6, PREGRADE1 ompkit-3s6d2). Each `- [ ]` item takes exactly one of `[build]`, `[landed]`, `[live]` or `[after <window>]` (window `7d`/`12h`/`30m` or `>=YYYY-MM-DDTHH:MMZ`) in the leading run of bracketed tokens after its checkbox, beside scope letters such as `[a]`; `AC-KITLIB` items are build by definition. The grammar, the tick-invariant AC digest, the 2026-10-24T00:00:00Z cutover and the admission check live in the new `scripts/ac_phase.py`. For beads created at or after the cutover: bead-lint check `l-ac-phase` (also in the create and update gates) refuses an untagged item (`AC_PHASE_UNTAGGED`) or a doubly tagged one (`AC_PHASE_MULTI`), naming the line; `br update --status in_review` is refused while any `[build]`/`[landed]` item is unticked (`AC_UNTICKED_BUILD_LANDED`). A tracker repo opts in to the pre-grade requirement with `.omp/pregrade.json` set to `{"required": true}`: the move then also needs a non-author pregrade record at `$XDG_STATE_HOME/omp-kit/pregrade/<bead>.json` (else `$HOME/.local/state/...`) matching the bead and its current AC digest, verdict PASS or WAITING, within 24 h (`PREGRADE_MISSING`, `PREGRADE_AC_CHANGED`, `PREGRADE_NOT_PASSING`, `PREGRADE_STALE`, `PREGRADE_SELF`). An optional string `"hint"` in that file (control characters stripped, 500 characters max) is printed on a `PREGRADE_HINT` line after any `PREGRADE_*` refusal, so the repo says how to produce a pregrade. Without the file no record is asked for; an unreadable or invalid file is refused `PREGRADE_CONFIG_INVALID` and the record is required. Older beads are reported under the `l-ac-phase-legacy` warning and admitted with an `AC_PHASE_LEGACY` notice. `planning convert` writes `[build]` after the scope letter when a plan's item has no phase tag.
- `kit-probe-readable-facts` flags copied live versions, profile counts and splits, absolute home paths, process IDs, and lease values in config/registry writes; reasoned decisions and runtime probes remain permitted.
- Commits and pushes can no longer add a process spawn that bypasses kitlib. `scripts/kitlib_ratchet.py` reports `raw-spawn` for Python `subprocess.run`/`call`/`check_call`/`check_output`/`Popen`/`getoutput`/`getstatusoutput`, `os.system`/`popen`/`spawn*`/`posix_spawn*`/`exec*` and `asyncio.create_subprocess_*` (import aliases followed); TS/JS `Bun.spawn`/`Bun.spawnSync` and `spawn`/`spawnSync`/`exec`/`execSync`/`execFile`/`execFileSync`/`fork` from `child_process` or `node:child_process` (named, namespace, default, `require` and dynamic-import bindings); and a shell call-site `timeout N cmd`. Each finding names the kitlib replacement: `kitlib_run.run` (scripts/kitlib_run.py) or `run()` (src/kitlib/run.ts). Untouched existing sites never block; a new site always does unless its line carries `kitlib: <reason>` (two or more words, 10+ characters); an unused pragma is reported. The new pre-commit member `51-omp-kit-staged-kitlib` (installed by `install-commit-msg-bead.sh`, checked by `--check` and `omp-kit hook-refresh`), the `kitlib-range` pre-push step and CI enforce it. kitlib itself, `pysafe.py` and the ratchet's own files are exempt. The rule set is built to take further kitlib primitives as rules. TEMPSAFE now runs on the same engine, `scripts/kitlib_ratchet_core.py`, with unchanged output; its installed member gets the engine beside it (ompkit-qwqh1).
- Release eligible legacy scratch tasks through `scratch release DIR --legacy-owner --reason TEXT --yes`, preserving original ownership evidence and refusing open files, unknown probes, foreign roots, or replaced tasks.
- kitlib `run()` (TypeScript and Python) adopts processes that need inherited descriptors and live output: `inherit_fds` passes an explicit allowlist of open descriptors at the same number (default closed), `on_output(stream, chunk)` streams raw stdout/stderr while the child runs through a bounded queue (`max_sink_queue_bytes`; overflow is dropped and counted in `stream_dropped_bytes`, a sink error is reported in `sink_error`, and the child is still reaped under the same deadline and group rules), and `max_total_bytes` adds a combined capture budget beside the per-stream cap (`total_truncated`). Results report `captured_bytes` and `streamed_bytes` separately. `pysafe.run_bounded` gains the matching optional `pass_fds`, `on_chunk` and `total_cap` inside its one drain. (ompkit-t8dfi)
- kitlib poll, one bounded condition-polling primitive (ompkit-u6k6t, KL13): `pollUntil(probe, {deadline_s, interval_s, classify, signal, attempt_timeout_s})` in `src/kitlib/poll.ts` and `poll_until()` in `scripts/kitlib_poll.py` return `success`, `terminal`, `deadline` or `cancelled` with the attempt count, elapsed seconds and the last observation, capped at `max_observation_bytes` and flagged when truncated. One monotonic budget covers probe time as well as sleeps, each attempt's timeout is at most the remaining budget, a wall-clock jump does not move the deadline, and no sleep follows expiry and no probe follows cancellation, success or terminal. The owner's `classify` decides (HTTP 200 with the wrong body is not success); `whenAll()`/`when_all()` builds a conjunction and refuses an empty condition set (`INVALID_ARGUMENT`). Shell scripts use `python3 -B scripts/kitlib_poll.py --deadline-s N --interval-s M [--success-codes 0] [--terminal-codes 3,4] -- <probe argv>`, which runs each probe through kitlib run and exits 0, 1, 124 or 130 (SIGINT/SIGTERM) with one final JSON line. Both languages and the CLI pass `tests/fixtures/kitlib-poll/corpus.json`, whose planted negatives each flip when their detector is bypassed.

### Changed

- Scratch, the ownership doctor and `omp-kit heavy` now judge a recorded owner `{pid, start}` through kitlib proc's incarnation probe instead of hand-rolled `kill -0` and `ps` checks (ompkit-5m6ej). A zombie or a reused pid now reads dead, where the old checks read it alive. A probe that cannot read `ps` is unknown and never counts as dead, so it reaps, deletes and releases nothing; the ownership doctor counts it as unprobed. Owner records written before this change hold the raw `ps -o lstart=` text and still compare, because the probe collapses whitespace on both sides. New scratch owner records store the collapsed form. Ownership is unchanged: who owns a dir and who may release it are decided exactly as before. kitlib gains `runSync` for short leaf commands and `incarnationSync`/`probeIncarnationSync`, which share the async probe's classifier, so synchronous callers use the same decision.
- The embedded command-center event registry drops the never-emitted `selftest`
  producer, mirroring omp-kit b154cf52 (`generate-cc-schema.py --check` is
  current again).
  (ompkit-fp72.120.16.47)
- `update --reconcile` without `--prefix` now derives the install location from the receipt postimage instead of the running kit; tampered postimages still refuse and remain pending.
- Remove the staged README hook's redundant cleanup callback; the native temp registry removes its INDEX archive on acceptance, refusal and signals, including readonly trees. Keep the POSIX helper's EXIT trap installed while re-raising HUP, INT or TERM so Bash's deferred termination cannot turn a final signal into a successful exit. No new runtime dependency or shellcheck suppression. (ompkit-774u.29)
- Prevent shell temporary-directory allocation from hanging when the caller ignores SIGPIPE by bounding entropy input before filtering; preserve six-character lowercase-alphanumeric names, ownership records, signal policy, and cleanup behavior.
- Check executable modes against the committed source revision recorded in an immutable archive's existing `package.json` export metadata and explicit source object store, not its empty or enclosing Git HEAD. Canonical checkouts still use their committed tree; dirty executable bits cannot hide a committed non-executable script. Missing archive provenance or a mismatched explicit revision fails closed. (ompkit-774u.34)
- When the CC spool is available, fleet-watch records typed pull outcomes and per-pass freshness/coverage ticks without copying free text; the existing JSONL log remains until CC14's seven-day reconciliation retires it.
- Validate CC envelopes and complete append batches against generated canonical event and credential registries instead of hand-maintained allowlists. Enforce declared context, Unicode bounds, identity/time and coverage constraints before writing; expose fixed `.code`/`.field` refusal metadata without echoing inputs. Preserve the existing credential screen and add the full canonical rule catalog, including capture, entropy and allowlist semantics. Generate the portable artifacts with `python3 scripts/generate-cc-schema.py <events.v1.json> <credential_shapes.v1.json>` (`--check` detects drift); Python is needed only for authoring, never installed producer runtime. (ompkit-hueaw)
- Make the Python temporary-directory cancellation fixture explicitly use default SIGINT in its child, preventing false conformance failures when the suite runner backgrounds it with SIGINT ignored; production signal policy and test deadlines are unchanged.
- Cached full-suite verdicts are reused only while their paired suite log is present and matches its recorded SHA-256. (ompkit-rhy9.12)
- Fixed installed-receipt release checks to include the strict artifact reader and verify valid and forged out-of-domain receipts through both installation paths without ambient Python imports.
- Report an unavailable launchd inventory as unverified instead of treating an empty failed query as healthy; a successful empty query remains healthy.
- Keep real tmux recovery tests isolated with relative socket addresses so deeply nested exact-source exports do not exceed Unix socket path limits.
- Measure process-runner memory conformance in fresh processes so an earlier suite allocation cannot conceal the bounded-output controls or the unbounded-queue negative.
- Give local release tag pushes a finite budget that includes their mandatory validation hooks, and record the actual tag-push duration separately in the release receipt.
- Bound the default work-audit fan-out so clean repositories remain measurable under the existing Git probe deadline; explicit worker overrides and fail-closed timeout reporting are unchanged.
- The `br create` admission guard now runs native br through kitlib run instead of raw `subprocess.run`. The tracker creation lock still reaches native `br create` (through `inherit_fds`), dry-run and plain creates still stream br's output live to your terminal, and the deadlines (30 s for shim writes, 120 s for creates), messages and exit codes are unchanged. A new test shows the child holds the lock even after the guard is killed, and fails if the lock is not handed over. The guard's kitlib ratchet allowance drops from 4 raw spawns to 0. (ompkit-t8dfi)
- Set CLI and OMP plugin version metadata to 0.2.75 so the next release tag, packaged binary and plugin report the same version.
- Keep rule-pack regression checks on the canonical default/fleet rule paths, and clean their temporary fixtures when setup fails.
- Expose the existing test-runner scratch-boundary diagnostic through `doctor --scope test-scope`.
- Keep release-bump README stamping inside the explicitly selected repository.

### Fixed

- Temp dirs made by remaining CLI, fleet-guard, shell and Python tests now come from kitlib (`ownedTmp`, `owned_tmp`, `kitlib_tmp`) and are removed by their creator on exit, on SIGHUP/SIGINT/SIGTERM and in test teardown, instead of piling up in system temp (ompkit-1yshq, TEMPSAFE1, J-2026-10-22-06).
- When a bash call sets `name`, fleet guard runs it as a long-lived service. If the command is finite work, the refusal now says first that `name` should be dropped. The SERVICE_MODE_CONFLICT and SERVICE_READINESS_REQUIRED refusals used to say only to remove `async` and `timeout` or to add a readiness condition, which pushed finite commands further into service mode. On 2026-10-22 a codex seat that put `name` on every call had its `br`, `omp-kit` and receipt commands refused and reported itself blocked. The service advice is still given for real services.
- `scratch release --now` and `scratch apply` no longer delete a dir that a running process is still using between writes. A process registers with `omp-kit scratch use DIR [--pid PID]`, which records its pid and process start in `DIR/.users` under a private lock with an atomic rewrite. Without `--pid`, the user is the process that ran `omp-kit`. `scratch unuse` removes the record. While a registered user probes live or unknown, or the `.users` file can't be read, `release --now` refuses with `USER_LIVE`. The refusal names the pid, its start and its state, and says the user must finish or run `scratch unuse`. In the same case, `apply` keeps the dir as `LIVE user-live`, released or not. Users that are dead, reused or zombie don't block, and the next rewrite prunes them. Registration grants no authority to release. (ompkit-5fn07)
- `.users` is bookkeeping, not content: it is left out of the transfer digest and the byte-identical-copy set, so `use` then `unuse` no longer changes a dir's `scratch-sha256` token, and a committed copy of an empty `.users` file no longer proves an evidence or promote release. Quarantine expiry now rechecks registered users like the other deleters and keeps an entry whose user is live or unknown (`LIVE user-live`, logged with the pid and why). Every deleter and mover holds the same lock `scratch use` takes across its user check and its delete or move, so a `use` lands either before the delete (which then refuses, `now-held-users-lock-busy` or `users-lock-busy` while the lock is held) or after it (and is refused because the dir is gone). `scratch use` refuses a dir that is not directly inside a scratch root (`outside-scratch-root`). (ompkit-5fn07)
- README corrections. `doctor` covers 37 scopes, not "38 components"; the README contradicted its own "37 named scopes". `omp-kit service` manages twelve jobs, not nine: `scratch-pressure`, `cc` and `loop-sentinel` were missing from the list. `send` now documents the `tern:<block>` route and its `--window-key` requirement.
- Temp dirs made by production `src/` code (including `isolatedProbeHome`, which leaked 139 probe homes, 11 GB, when probes were killed) now come from kitlib (`ownedTmp`, `owned_tmp`, `kitlib_tmp`) and are removed by their creator on exit, on SIGHUP/SIGINT/SIGTERM and in test teardown, instead of piling up in system temp (ompkit-5vgd5, TEMPSAFE1, J-2026-10-22-06).
- The Tern seat observer and the Tern send path decide an omp session file of any size, instead of refusing every file over 64 MiB (ompkit-774u.1.3). A file within the cap is still parsed whole. A larger one is read as the session header (at most 64 KiB) plus the last 8 MiB of one open inode, from the first complete record after the cut. That read never exceeds 8 MiB + 64 KiB, and a 70 MiB file decides in tens of milliseconds. The tail reads IDLE only when it proves what the whole-file parse would see:
  - the state: the active branch reaches its root, or a process-exit checkpoint after the cut, with the branch's last message also after the cut;
  - the leaf: a `model_usage.activeLeafId` pin, or the whole body is in the window.
  Otherwise the tail is never IDLE. A mid-turn tail (a user message, or an assistant message awaiting tools) still reads as work in flight (`SESSION_TURN_IN_FLIGHT`). A settled-looking tail is UNKNOWN: `TAIL_STATE_BEYOND_WINDOW` when an earlier tool call or job could still be pending, and `TAIL_ACTIVE_LEAF_UNPROVEN` when only the leaf is missing. omp leaves dead-end branches the cut would hide, and omp 18.10.3 writes no leaf pin, so a live over-cap seat reads BUSY or UNKNOWN, never IDLE.
- Async jobs die with the omp process that owns them. A `session_exit` record with reason `dispose` (written by omp's session dispose, which then cancels every owned job) settles every earlier job as dead-by-restart, and its `pendingToolCalls` becomes the pending set. A job id reused after it is a new job. Signal exits (`sigint`, `sigterm`) settle nothing: a live job started before one was delivered after it.
- The Tern send path reads the same bounded view as the observer. Its observe-to-effect check compares a fingerprint of inode, size and every byte read, not a whole-file sha. Past the cap, a proof key pins the 64 KiB before its cursor and the file's inode, so a rotated or rewritten journal never proves. A goal-set proof from a tail read counts only a goal's creation record. Pending records written before this change still load and prove as before.
- A Tern send proof no longer depends on its pinned range staying in the last 8 MiB (ompkit-774u.1.3). Before, once a journal grew about 8 MiB past an unconfirmed send's cursor (or a key made from a whole read of a sub-64 MiB file grew past the cap), the proof read returned `UNCERTAIN JOURNAL_PREFIX_BEYOND_WINDOW` and the record suppressed every later send to that seat (`SUPPRESSED_PENDING`) for the rest of the incarnation. Now the bounded read also reads the key's range plus at most one window after its cursor, on the same fd under the same before/after fstat; a rewritten range is still `JOURNAL_PREFIX_CHANGED`, a replaced file `JOURNAL_REPLACED`, and a range that stops short of the file's end is never ABSENT (`JOURNAL_PROOF_RANGE_BEYOND_WINDOW`). The tail window now starts at the cut when the byte before it is a newline, so a record starting exactly at the cut is no longer dropped. Known limit, by design: malformed or duplicate records, or a record-count overflow, before the cut are invisible to the tail read although they make the whole-file parse refuse. IDLE still holds because everything it rests on (the root or a dispose checkpoint, the branch's last message, and the leaf pin or full body coverage) must itself be in the window, and earlier damage cannot falsify appended records.
- Disk pressure no longer blocks saving work. The pre-push fresh gate's compile and harness steps admit on physical bytes (`omp-kit heavy --disk-observer statfs`, the 10 GiB floor), so sbh's policy floor no longer refuses a push while the disk has room. When sbh reports pressure, the gate prints one `WARN disk-pressure:` line naming sbh's free percent and pointing at waste management (ompkit-774u.15), then continues. Below 10 GiB, explicit statfs admission now returns `heavy: REFUSED reason=DISK_BELOW_FLOOR need=10G` with an action to free at least 10 GiB; the actual pre-push gate names the refused step and does not wait out the heavy queue timeout.
- New `omp-kit heavy --disk-observer statfs|sbh|auto` overrides `load.json`'s `disk_observer` for one call, and `OMP_KIT_DISK_OBSERVER` sets the same default ambiently for callers that cannot take a flag (the pre-push gate uses it for nested ladders). An explicit statfs override also ignores `load.json`'s percentage floor for that call; the physical 10 GiB floor remains. Auto/sbh and calls without an override retain the configured percentage floor. Invalid values refuse loudly instead of silently changing admission.
- Heavy calls nested inside the save path admit on physical bytes too: the pre-push fresh gate and its sibling full-suite verdict both set `OMP_KIT_DISK_OBSERVER=statfs`, and `heavy` honors it as the ambient form of `--disk-observer` (precedence: flag, then env, then `load.json`); the isolated-run allowlist carries it into nested fixtures. Standalone runs leave it unset, where admission is unchanged. The 10 GiB physical floor remains, invalid values refuse loudly, and the pressure warning names the three largest scratch owners.
- During archive-based pre-push runs, scratch-owner reporting uses the caller checkout carried in OMP_KIT_CASE_CWD, not the temporary gate archive, so the warning names owners in the repository being saved.
- Pre-push tests clear the save-only `OMP_KIT_DISK_OBSERVER=statfs` override when checking `auto`/`sbh`, preserving those refusal controls; CC spool tests assert the ingester's normalized code surfaces (for example, `kit-capabilities`).
- A heavy admission deadline that expires before child start now refuses the command; a fast child cannot finish inside the timeout floor, while already-started children remain bounded by the same deadline.
- The `land` full-suite judge archive now includes `scripts/kitlib-tmp.sh` and binds its bytes into the suite-check identity, so the exact-candidate suite no longer returns `LAND_FULL_SUITE_UNRUN` when that helper is omitted.
- Each archived full-suite shell run now gets an owned TMPDIR rather than inheriting a plain caller directory, preserving nested helper ownership and cleanup.
- The SaveFirst pressure fixture reports the incomplete-suite refusal and unchanged local ref; it is a component control, not AC1 publication proof.
- Convergence reports `published_commits` only after confirming the remote main postimage; failed hooks and refused push admission no longer count unpublished candidate commits.
- Resolve a configured chief's mail-wake identity from its canonical project when its launch directory differs. The configured agent, tab, block and launch directory must all match; wakes retain the actual launch directory. Missing or mismatched identity still refuses an actionable send.
- Temp dirs made by CLI tests, second batch (`drain-project` leaked 174 dirs) now come from kitlib (`ownedTmp`, `owned_tmp`, `kitlib_tmp`) and are removed by their creator on exit, on SIGHUP/SIGINT/SIGTERM and in test teardown, instead of piling up in system temp (ompkit-83356, TEMPSAFE1, J-2026-10-22-06).
- Temp dirs made by CLI tests, first batch now come from kitlib (`ownedTmp`, `owned_tmp`, `kitlib_tmp`) and are removed by their creator on exit, on SIGHUP/SIGINT/SIGTERM and in test teardown, instead of piling up in system temp (ompkit-8aza1, TEMPSAFE1, J-2026-10-22-06).
- Temp dirs made by CLI tests, third batch now come from kitlib (`ownedTmp`, `owned_tmp`, `kitlib_tmp`) and are removed by their creator on exit, on SIGHUP/SIGINT/SIGTERM and in test teardown, instead of piling up in system temp (ompkit-8hpf4, TEMPSAFE1, J-2026-10-22-06).
- Named repair plans inspect only their selected scope; policy planning reads settings from a private HOME clone and avoids unrelated probes of the caller's HOME (ompkit-8hpf4).
- A scratch dir made by a short-lived `omp-kit scratch new` subprocess can now be released by a later process (ompkit-a0vy1). Before this fix, an eval kernel or tool shell with no `AGENT_NAME` got an owner record holding only the pid of the `scratch new` CLI, which exits as soon as it prints. Every later `scratch release` was then refused `SCRATCH_RELEASE_REFUSED: caller-not-owner`, and the dir leaked to the reaper (918 MB for one builder). `scratch new` now mints a random 256-bit release capability and returns it once, as `data.capability`. `.owner` stores only its sha256 (`capability_sha256`), and the kit never writes the token to disk. `scratch release DIR --capability TOKEN` (or `OMP_KIT_SCRATCH_CAPABILITY`) releases the dir from any process, whatever its seat or pid, when the digests match; the comparison is constant-time. The seat path (agent plus omp session) is unchanged. A wrong or missing token, with no seat match, is still refused `caller-not-owner`; the refusal now says which case applied, and its remediation names `--capability`. Dirs made before this change, with no `capability_sha256`, are released exactly as before.
- Temp dirs made by scratch, send and service tests (the reaper's own fixtures now live inside owned roots) now come from kitlib (`ownedTmp`, `owned_tmp`, `kitlib_tmp`) and are removed by their creator on exit, on SIGHUP/SIGINT/SIGTERM and in test teardown, instead of piling up in system temp (ompkit-aabyn, TEMPSAFE1, J-2026-10-22-06).
- `omp-kit scratch plan` and `scratch apply` now reclaim kitlib owned-temp leftovers in system temp (ompkit-army3, KITLIBREAP1). A dir that `ownedTmp`, `owned_tmp` or `kitlib_tmp` made survives only SIGKILL or power loss, and the reaper used to leave it in TMPDIR or /tmp forever. A TMPDIR or /tmp entry is now admitted only when all of these hold: its name is `<label>.<pid>.<6 [a-z0-9]>`; it is a real directory owned by you with mode 0700; its `.owner` is a regular file with mode 0600; and the `.owner` parses with the name's label and pid. An admitted dir then follows the existing rules. A live pid stays LIVE. A dead pid, or a pid reused after `created`, with no open files is REAP, and goes through the same quarantine, inode, owner and lsof rechecks before delete. The row reasons name the rule (`kitlib-owner-dead-no-open-fds`, `kitlib-owner-alive-start-unverified`, `kitlib-owner-dead-but-open-fds-present`). Nothing else in system temp is visited. `kitlibTmpProblem(dir)` names the first rule a refused entry fails, for example `kitlib-dir-mode-not-0700` or `kitlib-owner-pid-mismatch`. `tests/cli/scratch-kitlib.test.ts` SIGKILLs a real bun `ownedTmp` creator and a real python3 `owned_tmp` creator, then checks that plan shows REAP and apply removes both dirs. It also checks that controls for a live pid, an open file, a pid mismatch, a label mismatch, a non-kitlib name, a symlink and mode 0755 are all left in place.
- Native planning conversion accepts legacy lettered criteria and scoped canonical checkboxes, including compound scope tags, without losing explicit progress (ompkit-axz7m.1; CONVERTCHECKBOX1 ompkit-axz7m.4).
- Newly converted criteria and generated mission epics satisfy canonical bead-lint admission. Logical amendment identity ignores checkbox progress and equivalent scope spelling; repeated contributions no longer duplicate criteria or reset checked state.
- Preserves stale-acceptance and native revision fences. Removes obsolete null snapshot fields that are no longer in `PlanningScoreSnapshot`.
- Verification: `bun test tests/cli/planning-convert.test.ts` — 52 passing tests, including failing-before/passing-after converter/admission and idempotence cases. This is source-candidate evidence, not a claim that the installed CLI was upgraded.
- Reduce subprocess peak memory by releasing discarded pipe buffers promptly. Captured output and chunks accepted by streaming callbacks are never detached by the drain; partial views and non-detachable buffers retain their ordinary lifetime.
- Reuse immutable Git commit facts within each stale-worktree gate invocation instead of rereading them for every removed line, preserving line-specific stale and foreign-bead decisions.
- Join removed sites to blame once in original site order, refusing join I/O failures instead of silently skipping checks.
- Refuse failed or incomplete Git observations instead of treating them as clean history. Proving an unborn branch uses Git 2.46+ `show-ref --exists`; an unavailable lookup refuses rather than guessing.
- Fleet guard now expands a leading `~/` in the path of a write or edit tool call to your home directory, the same way the omp file tools do. It used to resolve the path relative to the current directory, which broke in two ways. A seat working in omp-kit that edited `~/Developer/omp-kit-companion/...` was refused against the wrong repository, even though it held the right reservation. And a seat working outside any repository was not checked for ownership at all. A path such as `~user/...` is still taken literally.
- `omp-kit send <session> tern:<block> <text>` reaches fleet Tern seats again. Tern 0.9's `ctl` only reaches a window opened with `tern --control EP`, and no fleet window has one, so every send refused `TERN_WINDOW_UNBOUND` and dropped. A seat with no window key now delivers with `tern send <block> paste <text>` then `tern send <block> keys Enter` (the pane's own window, else the first), after the same observe and identity checks, and proves delivery the same way: a USER entry in the seat's session file that hashes to the sent text. Because a paste is not atomic, it runs only when the seat's own fresh kit-composer-state record says the composer is empty; a draft refuses `TERN_COMPOSER_BUSY` and a missing, stale or dead-writer record refuses `TERN_COMPOSER_UNKNOWN`, both with zero sends. Enter is never pressed after a failed paste. A seat with a window key keeps the single native `ctl` turn. (ompkit-fixjo)
- A `scratch release --now` whose delete fails partway now leaves the directory releasable. The delete used to remove the owner record and the release marker along with the first files, so a directory with a nested folder the owner could not write ended up as an unowned remnant that nobody could release again. Those two records are now removed last. A partial failure reports `SCRATCH_RELEASE_HELD` (`now-held-delete-failed`), keeps both records, and the same release with `--now` retires the directory once the cause is fixed.
- Reclaim recently touched orphaned claims without waiting 24 hours when current holder evidence proves no live seat, genuine mail activity or active reservation. Unreadable liveness still refuses; a reclaim still requires an atomic assignee clear, seen revision and transition reason.
- A registered fleet seat now publishes its composer state even when its process started outside its repo. The chiefs run from `/Users/josh/Developer`, where fleet policy is off, so their record was never written and the reload/arm gate fell back to scraping the screen (HELD_DRAFT). Its Tern pane (`TERN_PANE`) is looked up in the seat registry, and the policy is read from that session's repo. Unregistered panes, stock repos and a missing or malformed registry keep the cwd rule.
- `omp-kit scratch release --bin evidence|promote` now requires the reference to show that the directory's content actually arrived. Before, any bead that `br show` found, or any file git tracked, was accepted, even if it had nothing to do with the content. The release marker (which the reaper honours) and `--now` (0.2.74) then retired the directory on that reference. Every directory now has a content token, `scratch-sha256:<digest>`. A bead reference must have a comment that cites the token. A file reference must be committed and pushed, and must either cite the token or be a byte-identical copy of one of the directory's files. A refused release names the token, so you can cite it and release again. New refusal reasons: `ref-transfer-unproven`, `ref-uncommitted`, `ref-unpushed`, `ref-git-unverified` and `ref-content-unreadable`. Directories released with an unproven reference before this fix stay recoverable from quarantine only until their quarantine time-to-live ends.
- Test fixtures that seed the OMP source cache now plant the OpenTelemetry runtime entry the cache requires since the incomplete-entry fix, so the runtime and doctor tests exercise the cache instead of failing on a miss (ompkit-kl9p3).
- `omp-kit test --integrations` honours a set `OMP_KIT_TEST_WORK_ROOT`: the work dir goes under that validated caller-owned scratch root, and an unowned or foreign-workspace root fails closed with INTEGRATIONS_UNAVAILABLE before any profile is read, as the xa5s.5 entry already described.
- `omp-kit scratch new --export` archives the whole commit from the repository top level, so an export requested from a subdirectory (or an ignored scratch dir inside another checkout) is never partial or empty.
- `omp-kit service list` and `service status --all` report `loaded: false` for a job launchd does not know, instead of null.
- The packaged full test is green again past `regex-budget` and `metamorphic-ratchet` (ompkit-kl9p3):
  - `kit-rea-runtime-shipped` failed `regex-budget` with `NO_REQUIRED_LITERAL_PROBE`, because every token of its condition sat inside an alternation. That stopped the ladder and left later stages unrun. The condition now factors out the `/` every shipped path shares. The `.app/Contents/MacOS/` branch keeps its `.app` through a fixed-width lookbehind.
  - `kit-rea-runtime-shipped` and `kit-tool-result-is-not-json` fired on `echo "<their fire snippet>"`, which broke the strict metamorphic quoting invariant. Both now stay quiet when the tracer word or `JSON.parse` sits in a command segment whose command word is `echo` or `printf`. A bounded lookbehind after the literal checks this, so a stream check stays one literal scan.
  - Every existing `cases.tsv` row keeps its verdict.
  - The live scenario `tool-result-json-fire` runs the `cases.tsv` fire snippet (`node -e "...JSON.parse(...)..."`) instead of echoing the text.
  - `shipped-config-selftest` is classified as a non-case ladder stage. Since it joined the ladder, every green full test reported `Unknown stage case domain` and returned no case counts. A test now requires every `ladder.sh` stage to have exactly one case domain.
- The package-manifest fixture carries `scripts/kitlib-tmp.sh`, which `scripts/build-manifest.sh` sources since the kitlib temp migration, so packaging's manifest producer runs on it again (ompkit-kl9p3).
- Test suites that run a real `omp-kit service run JOB` no longer refuse each other with `SKIPPED-ADMISSION` (exit 4) under the parallel push gate (ompkit-kl9p3). The run's launcher admission reads the whole host `ps` table and counts every live `service run JOB` process against its own keeper claim. A launcher from a parallel test file or a live launchd job therefore made an isolated-HOME fixture skip its work. Each spawning suite now puts the `ps` from `tests/cli/launcher-table-fixture.ts` first on the CLI's PATH. It passes the next `ps` through and hides only `service run` rows outside the test process's own tree. The fixture's own launchers stay visible, and a planted second launcher in that tree still refuses.
- Keep upgrade regression packages complete with fleet rules and manifests, automatically retire read-only and compiled fixture releases, and check unavailable postchecks by their declared stage rather than generic wrapper messages.
- `scratch release --now` and the reaper's delete no longer stop at `now-held-delete-failed` / `delete-failed` on dirs that hold read-only subdirs (installs leave `releases/<v>` at 0555). After a dir passes every existing gate (owner, inode, lsof), a failed removal gives each real dir inside it owner rwx and retries once. Symlinks are never followed, and nothing outside the dir is touched.
- `tests/cli/scratch.test.ts` creates its omp-kit state dir 0700, as production does. Under umask 0022, its fixtures used to leave `<state>/omp-kit` at 0755. The `scratch-users` lock correctly refuses a dir like that (`PERMISSIVE_MODE`), so 9 deleter tests read `SKIP users-lock-busy`. The lock is unchanged. A new test pins the refusal: with the state dir at 0755, quarantine expiry keeps an expired entry (`users-lock-busy`), and at 0700 it deletes it. (ompkit-5fn07)
- Project-ambiguity warnings no longer bypass Agent Mail subject, secret-body, sender-token, or wake admission checks; permitted sends retain both the warning and their authenticated input.
- Stop failing otherwise valid saves on an incidental scheduler-message timing assertion; the actual save-admission, disk-pressure warning and physical-floor refusal controls remain unchanged.
- `omp-kit scratch new` now refuses roots that `scratch release` cannot discover and reports the scoped `OMP_KIT_SCRATCH_ROOTS` remedy.
- `scripts/runtime-adapter.sh` now admits an `OMP_KIT_TEST_WORK_ROOT` made by `omp-kit scratch new` (ompkit-774u.39, WORKROOTJSON1). It used to accept only a line-form `.owner` (`repo=...`), so the JSON `.owner` every canonical scratch dir carries was refused. The adapter now reads the single `"repo"` value from a JSON `.owner` in plain POSIX sh and still refuses a foreign repo, two repo keys, a non-string or relative value, any backslash escape, a symlinked `.owner` and a dir outside `<repo>/var/agent-tmp`. The line form still works. `tests/cli/runtime.test.ts` makes its work roots with the canonical writer (`createScratch`, JSON owner) instead of a hand-written line `.owner`.
- `runtime-adapter.sh` now reads the JSON `.owner` key by key, so a value that spells `repo` (a real `omp-kit scratch new --label repo` owner) is a value and is admitted. Before, the adapter counted raw `"repo"` tokens and refused that owner as a repo mismatch. Malformed shapes are still refused: a token in value position, nested or non-string repo values, two repo keys, backslash escapes, and trailing text.
- A bare JSON value in the `.owner` must now be a scalar (a number, true, false or null). Before, an unclosed outer object whose only `repo` key sat inside a nested object was admitted.
- Retire planning CI e2e work through the existing owned-temp lifecycle on successful and failing runs instead of leaving completed fixture repositories behind.
- The cc command-center service no longer runs under background QoS, which made its 10 s fast-lane deadline overrun at ordinary fleet load. Kit service jobs now declare a QoS class (`ServiceJobDef.qos`). cc is `deadline`: ProcessType Standard, Nice 10 and no LowPriorityIO. Every other job keeps the `background` shape, byte for byte. `service doctor`'s `contract-processtype` check now follows the declared class and FAILs a deadline job rendered Background. systemd units are unchanged. (ompkit-fp72.120.16.50)
- `omp-kit service run cc` now starts the command center from the fleet checkout's committed `scripts/cc/cc.py` at HEAD, never the working-tree file, so an uncommitted syntax error in cc.py can no longer stop the live service. A small stdlib bootstrap (`python3 -c`) resolves HEAD with git and execs those bytes with `__file__` set to the adapter path. If the checkout is not its own git top level it prints `DEPLOY_BOOT_GIT_FAILED` and exits 3. (ompkit-fp72.120.16.53)
- The close-evidence tripwire no longer mistakes quoted Agent Mail send/reply payloads, including JSON-escaped shell line continuations, for close attempts. Actual reasonless closes following mail or inside command substitutions remain blocked; unrelated acceptance updates remain quiet.
- Single-quoted argument values containing parentheses are consumed as data before checking active command terminators, preserving evidence-bearing closes with parenthesized database paths.
- `tests/cli/migrate.test.ts` no longer depends on the checkout's own `MANIFEST.tsv` having a commit identity. Once MANIFEST.tsv became untracked packaging output (ompkit-kl9p3), a gate archive with no history built pack `uncommitted-<date>`, and 11 migrate tests failed `SOURCE_INVALID`. The suite now stages its own release root: the repo's rules are committed to a fixture git repo, `build-manifest.sh` writes the MANIFEST.tsv (its pack is that commit), and the CLI is compiled into the fixture's `bin/`. The suite passes in a git checkout and in a history-less archive. A new test pins the refusal: the same manifest with an `uncommitted-` pack is still `SOURCE_INVALID`. (ompkit-kl9p3)
- The launcher-table test fixture no longer hands a later test file a deleted `ps` shim: when an earlier file's cleanup removed it, the next call rebuilds it, so the full suite stops failing with `ps` ENOENT.
- `repair --plan`, `status` and plain `test` no longer write the rch socket inode baseline (`rch-socket-ino.json`) into the kit state root; only `doctor` records it, and the other commands still compare against an existing baseline, so a replaced socket is still `SOCKET_UNLINKED`. (ompkit-lrbd.3)
- `tests/cli/private-index-land.test.ts` no longer depends on the scratch dirs of whoever runs it (ompkit-lrbd.3). Each `omp-kit land` child it spawns ran the push-time scratch disposal gate over the real `~/Developer/*/var/agent-tmp` roots, so "reports local catch-up without claiming publication or retrying" could fail with `SCRATCH_DISPOSAL_REFUSED` naming an unrelated dir (seen: a dead owner whose pid the land child had reused). Every land run in the file now sets `OMP_KIT_SCRATCH_ROOTS` to an empty fixture root, so the gate sees only fixture state. The gate itself is unchanged.
- `scripts/full-suite-verdict.sh` now waits on the suite instead of polling it every 5 s, so a verdict takes the suite's own time plus well under a second.
  - The old loop slept a full 5 s before its first check, so even an instant fixture suite paid that floor on every `omp-kit land`.
  - On a trivial fixture suite, the median verdict dropped from 5.41 s to 0.59 s (5 interleaved runs of each).
  - A watchdog still enforces `FULL_SUITE_TIMEOUT_SECS` with the same TERM, 5 s grace, KILL sequence. A timed-out run on a 2 s budget now ends after 2.5 s instead of 10.6 s, with the same verdict: non-pass, nothing cached, partial log kept.
  - No timeout was raised (ompkit-lrbd.3).
- `scripts/full-suite-verdict.sh` runs every bun, shell and python suite with SIGINT and SIGQUIT at their defaults, the same as a foreground run.
  - The runner starts its suite loop in a background list, and a non-interactive shell starts background lists with both signals ignored. Every test therefore inherited SIG_IGN.
  - As a result, `tests/scripts/kitlib_tmp_test.py` (test_03_sigint, "want signal SIGINT, got 0") failed only under the gate's full suite.
  - A tiny `python3` exec shim resets the two signals and then execs the suite, so the suite keeps its pid and its process tree (ompkit-lrbd.3).
- The full-suite pre-push verdict no longer throws away the suite output when a run ends without complete evidence or times out. The partial output is kept as `<tree>.incomplete.log` in the verdict cache dir and the RED line prints its path. The run still exits non-pass and caches no verdict, and the verdict lookup only reads `<tree>.json` and `<tree>.log`, so the kept log can never be reused as a verdict. (ompkit-lrbd.6)
- The full-suite verdict no longer miscounts when a test runs a nested gate. `scripts/full-suite-verdict.sh` used to count `GREEN`/`RED script-suite` lines and take the last `Ran N tests across` and `N fail` lines from the whole suite log, so a nested gate's output made a complete run look incomplete (47 shell suites counted as 48), and a nested bun summary printing ` 0 fail` could hide a real bun failure's count. The runner now writes its own status file (one line per shell and python suite, plus the bun phase's exit code) and keeps the bun phase's output apart, so completeness requires exactly one status line per enumerated suite and the bun counts come from the bun phase alone. Incomplete runs are still non-pass and cache nothing; the side files are removed on every path. (ompkit-lrbd.6)
- A run whose suite process was killed (exit status other than 0 or 1) is now always incomplete. Before this, status lines that already named every suite could turn a killed runner's record into a cached FAIL. The independent verifier found this by planting a suite that forged the status file and then killed the runner. It never produced a PASS.
- The fleet watcher's `source.tick` now carries `error_code: null` and `skew_ms: null` (ompkit-n703x, WATCHTICK1). Both fields are required (nullable) for `source.tick` in the command-center registry `events.v1.json`. Without them, the cc ingester dead-lettered every watcher tick as `FIELD_MISSING data.error_code`, so `source:watcher` never ticked. The `SPOOL_APPEND_FAILED` quarantine stays reported in the tick's coverage, and `error_code` stays null because the registry declares no code for it. `tests/cli/fleet-watch-pull.test.ts` now asserts the exact registry field set on every harness-produced tick.
- The br-create-guard lock-descriptor test no longer leaves its probe process polling forever after the test exits.
- The fleet tripwire `kit-no-live-tracker-sqlite` now also watches eval cells, and it catches prefixed and double-quoted strings. All three measured tracker outages (2026-10-13, 10-22, 10-24) came from a persistent eval kernel holding a sqlite connection to `.beads/beads.db`, and the rule did not watch `eval`. Its connect condition also missed `sqlite3.connect(f"file:{repo}/.beads/beads.db?mode=ro", uri=True)` and every double-quoted path in bash and eval, because streamed arguments arrive JSON-escaped (`\"`). The advice is unchanged: use `br`/`bv`, or open a disposable copy under `var/agent-tmp/`. A path held in a variable is still not caught (ompkit-u335).
- The same tripwire no longer blocks a command that only prints SQLite code as text. `printf '%s\n' 'sqlite3.connect(".beads/beads.db")'`, `echo "sqlite3 .beads/beads.db"` and `printf 'sqlite3 .beads/beads.db\n' >> notes.md` are quiet again: when `echo` or `printf` is the command word of the segment, the `sqlite3` and `Database` tokens count as text. The text is still blocked if the same line pipes it into `python3`, `sh`, `bash`, `node`, `bun` or `sqlite3`. A real reader after `;`, `&&`, `|`, a newline, or inside `$(...)` or backticks still fires. A reader on the line after a newline (`echo hi` newline `sqlite3 .beads/beads.db`) used to slip past the command-form condition, and it now fires too. Text that `echo` or `printf` writes to a file is blocked when the same command later runs that file: `echo "sqlite3 .beads/beads.db" > r.sh; sh r.sh`, `printf 'sqlite3 .beads/beads.db\n' > q; bash q`, `... > x.py; python3 x.py`, and `... > r.sh && chmod +x r.sh && ./r.sh` all fire. Quoting either file name does not hide it: `> "r.sh"; sh r.sh`, `> r.sh; sh "r.sh"`, `> 'r.sh'; bash 'r.sh'` and `> "x.py"; python3 "x.py"` fire too. Writing the text to a file that is only read (`> notes.md; cat notes.md`, `> "notes.md"; cat "notes.md"`) or that is not the file run (`> "a.sh"; sh "b.sh"`) stays quiet. A file that is run in a later, separate command, or run through a variable or a different path, is still not caught (ompkit-u335).
- The ownership census no longer reports an unreadable directory as an observed zero. `omp-kit doctor --scope ownership` read every directory error (EACCES included) as an absent directory, so an RCH job-leases directory it could not read counted 0 records and 0 untracked. Only ENOENT and ENOTDIR now mean "absent"; any other read error makes that census row UNKNOWN (census null, the reason names the error) and the summary is not OK. This applies to the scratch, quarantine and lock censuses too. A truly absent directory is still a legitimate zero (ompkit-uj4af).
- Verify memory diagnostics against bundled, hash-checked OMP 18.12.6 source fixtures instead of the active installation, preserving source-change refusals and PATH-independent results.
- `tests/cli/repair.test.ts` runs in the local full-suite and pre-push gates again. Its `scripts/gate-ci-only.tsv` hermeticity row is removed now that the HOME-snapshot differences are fixed: the rch socket baseline is written only by `doctor`, and the compiled repair child no longer sees the host omp (ompkit-lrbd.3). The file passed 5/5 in an exact-commit export at 4-way concurrency (ompkit-v66l.27.9).
- Native policy CLI tests reuse the selected, verified OMP SDK source cache with fetching disabled instead of repeatedly preparing sources in isolated homes. Native reads, refusal and race assertions, and test timeouts are unchanged.
- The complete publication suite reuses the focused gate's bounded, isolated Bun workers and timing order without reducing suite coverage or extending its deadline; a passing worker cannot mask another worker's failure.
- The staged-fragments pre-commit check no longer turns a repository into a bare one when a commit is made from a linked worktree, as `omp-kit land --patch` does. Its validation step now ignores the git location that git hands to hooks.
- Temp dirs made by extension tests (`kit-guard-optin` had no cleanup and leaked 166 dirs) now come from kitlib (`ownedTmp`, `owned_tmp`, `kitlib_tmp`) and are removed by their creator on exit, on SIGHUP/SIGINT/SIGTERM and in test teardown, instead of piling up in system temp (ompkit-pyoq7, TEMPSAFE1, J-2026-10-22-06).
- The scratch reaper no longer waits 72 hours on dead unowned scratch while the disk is short. When the disk holding a scratch dir is at RECLAIM pressure (20% free or less), an unowned dir untouched for 12 hours, with no open files, goes to quarantine. On 2026-10-22, 26 GB of abandoned test exports and probe homes, idle for 17 to 50 hours, held the release disk gate at 12% free. At normal pressure the bound is still 72 hours, and quarantine stays reversible until its TTL. The plan names the bound that decided (`unowned-idle-12h-reclaim-would-quarantine` or `unowned-idle-72h-would-quarantine`).
- `receipt.py verify` no longer crashes on a deeply nested receipt. The strict JSON parser in `scripts/kitlib_artifact.py` used two Python stack frames per nesting level and raised `RecursionError` at depth 494, before its own 512 bound, so verify died with a traceback, and valid receipts 494 to 512 levels deep stopped verifying. The parser now keeps nesting on an explicit stack: up to 512 nested containers parse at any caller stack depth, and anything deeper is refused as `CORRUPT` with reason `DEPTH` (a typed `verify REFUSE` line, exit 1). The deepest of the 6,139 receipts found under `docs/evidence/receipts/` across the fleet repos is 13 levels. (ompkit-gvp4j)
- `receipt.py sign` no longer writes receipts that `verify` refuses. Before writing anything, sign now refuses (exit 2, `sign refused: ...`) a receipt larger than verify's 1 MiB read limit or one verify's strict parser rejects, such as one nested more than 512 levels. It also parses `--result-ref-json` with the same strict parser, so duplicate keys and `NaN` are refused at sign time, and a 2000-level `--result-ref-json` is refused with a typed message, where it used to crash with `RecursionError`. (ompkit-gvp4j)
- Cached full-suite verdicts are reused only when the matching suite log is present and its SHA-256 matches; a missing or changed log forces a full rerun.
- `omp-kit send SESSION tern:<id> MESSAGE` now sends to a Tern seat directly and proves the message landed by finding it in the seat's session file. It used to go through tmux/ntm, which can never reach a Tern seat (LIVE MISS 2026-10-19: two coordinator sends reported NOT_DELIVERED). A `tern:` address without a decimal id is refused before anything is sent, with `TERN_MALFORMED_ADDRESS`. `--cwd`, `--tern-session` and `--window-key` identify the seat.
- When `git commit --only` names a path that another agent holds exclusively, fleet-guard now refuses with that agent's name and the path ("…names some/path, which PeerHolder holds exclusively; ask PeerHolder to release or hand it over"). It used to say only that the path had no reservation, which left the caller guessing whom to ask. A path held only as shared, or held by nobody, still gets the plain "reserve it first" refusal.
- Temp dirs made by `scripts/` tools and hook members (installed members source `kitlib-tmp.sh` from their own hook dir) now come from kitlib (`ownedTmp`, `owned_tmp`, `kitlib_tmp`) and are removed by their creator on exit, on SIGHUP/SIGINT/SIGTERM and in test teardown, instead of piling up in system temp (ompkit-tpoge, TEMPSAFE1, J-2026-10-22-06).
- SNAPSHOTPUB1 (ompkit-v66l.14, Joshua J-2026-10-25-12): Agent Mail's reservation guard now runs at pre-commit only.
  Its pre-push plugin re-judged already-committed history against other agents' later editing leases, and vetoed
  release publication. In one shared checkout, the commit to main is where work meets, and the pre-commit plugin
  checks every staged path against foreign exclusive leases there. `scripts/install-pre-push-gate.sh` removes the
  plugins through `am guard uninstall`, reinstalls with `--no-prepush`, and refuses (exit 2) unless pre-commit custody
  is present and the pre-push plugin is gone. Publication races stay with Git's fast-forward check (git_converge), and
  history admission stays with 30-omp-kit-on-main. This follows Jeff Emanuel's repos, which install no hooks;
  upstream am supports `--no-prepush`.
  - `tests/cli/snapshot-publication.test.py`: 14/14 pass. A new installer-migration case converts a repo installed with
    Agent Mail's default (`--prepush`). The publication-scope mutant (custody re-applied at pre-push) fails
    publication, and the mutation-custody mutant fails custody. The same test at the previous HEAD fails publication.
  - Found in the live deploy: `am guard install` rewrites the pre-commit chain runner and drops omp-kit's
    storage-root bootstrap (GUARDROOT1). The installer now re-applies it through
    `install-pre-commit-storage-root-gate.sh` whenever the repo uses the 10-omp-kit-storage-root member, and exits
    2 if that fails. It also installs the fresh-gate member before `am guard uninstall`, so a pre-push runner
    whose only member was Agent Mail's plugin is kept.
- snapshot-publication.test.py also runs under the full-suite checker, which exports the archive's own var/agent-tmp (no .owner) as TMPDIR. The base checker's complete run on 409b3f0e had refused it there (RED python-suite, rc 2).

## [0.2.74] - 2026-10-22

### Fixed

- `scripts/release-local.sh` now refuses to run under `sh` or bash's POSIX mode and exits 2 with the command to use. Run as `sh` on macOS, it built the archives and then stopped at the signing stage, yet still exited 0. A caller reading only the exit code would believe the release had succeeded.
- `omp-kit service doctor cc` no longer warns on `last-exit` after a deliberate restart. When `launchctl kickstart -k` stops the cc daemon, the old instance exits with code 143 (SIGTERM) and launchd starts a new one; the doctor reported that 143 as a failure, so the service could never pass every check after a restart. A daemon that is running again after a SIGTERM exit now passes. A SIGKILL (137), any other exit code, or a daemon that is not running still warns. The daemon still exits 143 on SIGTERM: with KeepAlive `SuccessfulExit: false`, exiting 0 instead would stop launchd from restarting it after a stray kill.
- `omp-kit scratch release --now` now retires evidence and promote directories too, once their `--ref` has been verified (a tracked file or a bead that exists). A missing or untracked reference still refuses and leaves the directory unmarked. A directory released earlier without `--now` is retired by the same release with `--now`, the same bin and the same reference.
- A `--now` release that cannot retire its directory no longer reports success. When it finds an open file, no `lsof` evidence, a changed owner record or a changed inode, it exits `SCRATCH_RELEASE_HELD` and names the reason. The directory keeps its release marker and stays its owner's to retire with `--now` once the cause clears. Before, the command reported `ok` while the bytes stayed on disk.
- The ownership registry now lists `extensions/kit-composer-state.ts`, the writer of `~/.local/state/omp-kit/composer/` records. The extension shipped in 0.2.72 without an entry, so the registry check `tests/cli/ownership-registry.test.ts` failed on `main` with `UNREGISTERED_PID_WRITER`. The new `composer-state` entry records that the state is keyed by the seat's session, survives a respawn, is removed at shutdown and self-heals after a crash.
- Claiming a bead through `br update <id> --claim` works again on trackers that never declared a `rework` status. To check that the worker holds no other bead, the guard ran `br list --status in_progress --status rework`. br 0.7.x rejects an undeclared status (`VALIDATION_FAILED`), so on any stock tracker every claim was refused as `CLAIM_REFUSED tool_read_failure`, and three PULLADMIT1 tests failed on `main`. The guard now lists the assignee's open beads without a status filter and keeps the in-progress and rework rows itself. A claim while holding another active bead is still refused.
- `kit-agent-mail-guard` now checks an exact project-scoped Agent Mail identity when a capped recent-agent roster omits a recipient, admitting confirmed registrations while refusing authoritative absence and unknown lookup failures.
- fleet-guard now checks a `git commit --only` against the repository it actually runs in. A bash call that sets its own working directory used to be checked against the session's repository, so on 2026-10-22 a worker's commit in `mcp_agent_mail_rust` was refused 15 times over seven hours: the guard looked for its reservations in `omp-kit`. The same mix-up could also let through a commit whose path was reserved only in the other repository.
- When an agent holds no reservations in a repository, fleet-guard and `omp-kit land` now say the path is unreserved instead of "reservation lookup failed". Agent Mail leaves out the `my_reservations` field when that list is empty, and both read the missing field as a broken lookup. A lookup that really fails now names the cause: `am` not found, no answer within 10 seconds, the exit code with the first line of its error output, or a read that is not current.

## [0.2.73] - 2026-10-22

### Fixed

- After a context compaction, reading part of AGENTS.md now satisfies the reread check, as the guard's own reminder ("read any line range") says. omp marks every read shorter than the whole file as truncated, and the guard refused all truncated reads, so an agent whose AGENTS.md is longer than one page could never clear the check and every write stayed blocked. On 2026-10-22 a grader read jev's AGENTS.md six times and still could not write its verdict. A page cut at a line boundary now counts. A cut through the middle of a line, a cut by bytes, or a page of another file still does not. A read through a symlinked directory or a relative path now matches the real AGENTS.md.
- An owner can now retire scratch it released as throwaway without `--now`. Re-running `omp-kit scratch release DIR --bin throwaway --now` on such a directory deletes it through the same rechecks as a first-time `--now` release (pinned device and inode, unchanged owner record, owner inside the scratch root, no open files), where it used to answer `already-released` and leave the bytes for the reaper. Disposal follows the end of the job, not the reaper's schedule: on 2026-10-22 one marker-only throwaway held 64 GB while the reaper was paused. A plain re-release still answers `already-released`, a directory released as evidence or promote is never retired this way, and any failed recheck keeps the directory and its marker.
- `omp-kit scratch release DIR --bin throwaway --now` works from the command line. The command registry never declared `--now`, so the CLI refused it as `UNKNOWN_FLAG` and same-turn deletion was unreachable from the command line since it shipped; `--now` is now part of the documented grammar.
- A `--now` release checks for open files with one system-wide `lsof` snapshot, the evidence the reaper's final delete gate already uses, instead of a per-directory `lsof +D` walk. That walk times out on large directories and failed closed every time: a 64 GB throwaway was held as `now-held-lsof-unavailable`.

## [0.2.72] - 2026-10-22

### Added

- `extensions/kit-composer-state.ts` (COMPOSERTRUTH1): each fleet seat now publishes whether its own composer holds a draft, from omp's live `ctx.ui.getEditorText()`, to `~/.local/state/omp-kit/composer/<sha1 of the session file>.json` (`empty`, `idle`, `pid`, `at`; never the draft text). It rewrites the record at session start, at each turn boundary and every 5 s, and removes it at shutdown. The fleet's reload and arm gate reads this record before scraping the screen, so seats whose screen ends on a goal banner, an Advisor panel or a login flow are no longer held as if they had a draft (on 2026-10-22 five goal-mode seats with empty composers never reloaded onto 0.2.69 to 0.2.71). Inert unless the repo opted into the fleet, and outside the interactive TUI.

## [0.2.71] - 2026-10-22

### Added

- The wiring promised above has now landed, so Agent Mail sends from fleet seats wake their recipients. Until now `kit-agent-mail-guard` never called `kit-mail-wake`, and no send ever queued a wake (on 2026-10-22 the fleet host had no `mail-wake.jsonl` at all). The guard plans the wake once a send or reply has passed every check, refuses an ask with no wake path (`NO_WAKE_PATH`) before anything is sent, and adds the wake outcome (`WAKE_QUEUED`, `WAKE_DELIVERED` or `UNSIGNALED`) to the send's result. A wake that fails outright is reported as `UNSIGNALED`, never dropped. Repos that have not opted into the fleet stay inert.

## [0.2.70] - 2026-10-22

### Changed

- Fixed opted-in Agent Mail inbox throttling to count the outer write and its mounted fetch dispatch as one logical call when OMP reuses a nonempty tool-call ID.

### Fixed

- Unattended kit updates now relink the plugin into every profile instead of activating only the `omp-kit` binary. The plugin relink ran `omp plugin list` from the service's working directory, `$HOME`; omp started in `$HOME` moves to `/tmp`, and omp-trust-guard refuses to start there whenever `/tmp` holds an untrusted project file (on 2026-10-22 a stray `bunfig.toml` with a test preload). Every profile row was then `REFUSED PLUGIN_LIST_UNAVAILABLE` and the relink `NOT_RUN`, so seats kept the previous release's extensions after each update. Plugin commands now run from the kit-owned directory `~/.local/state/omp-kit/plugin-invoke`, whatever the caller's working directory.

## [0.2.69] - 2026-10-22

### Fixed

- The kit-update postcheck no longer fails because the kit's own services wrote their state during the isolated test. Each service job now declares the state it writes on its own clock (cc owns its `CC_STATE` store, cursors and spools, which every kit command appends while the store exists; ci-poller, load-watch, fleet-watch, fleet-flush, claude-save and scratch-reaper own the paths the old hand list named; every job owns its `jobs/<name>.*` records and the service TMPDIR). The isolation guard skips only the declared state of jobs whose plist or systemd unit is installed in that HOME, so any other write to a watched operator path, including one by the run under test, still fails with `Operator file changed during isolated test`.
- A kit release no longer collects Python bytecode. cc, skills and hooks import the release's `scripts/pysafe.py`, and on 2026-10-22 their `__pycache__/*.pyc` writes into the just-activated release made the postcheck report `Release snapshot changed during isolated test`. Staging (`kit-update` and `installer/install.py`) now puts an empty, read-only `__pycache__` beside every shipped `.py`; CPython 3.9 to 3.15 then runs from source without writing, whatever the caller's `PYTHONDONTWRITEBYTECODE`.
- A ladder stage that `omp-kit heavy` refuses under load (exit 75 with `RESOURCE_DEFERRED`) is now reported `DEFERRED`, not `FAIL`, and never `PASS`. When the deferral is the only failure, `omp-kit test --full` reports `DEFERRED` (exit 3) and `update --apply` reports postcheck `DEFERRED` with reason `KIT_POSTCHECK_DEFERRED`, live `NOT_RUN` and the deferred stage under `deferred_stages`, overall `UNVERIFIED`; the receipt stays pending as before. A deferral beside any other failure, and a stage whose own command exits 75 without heavy's refusal line, stay `FAIL`.

## [0.2.68] - 2026-10-22

### Fixed

- Agents can no longer rewrite a plist in place by accident. `plutil -extract`, `-convert`, `-replace`, `-insert` and `-remove` write their result over the input file unless `-o` names the output; on 2026-10-21 `plutil -extract ProgramArguments json <plist>` turned 12 LaunchAgent plists into JSON arrays and kit services failed doctor for 25 hours. fleet-guard now refuses (`PLUTIL_IN_PLACE`) a tool call that runs one of those verbs without `-o`, in `&&`/`;` chains, loops, wrappers, substitutions and nested shells too. `-o -`, `-o <path>`, `-lint`, `-p`, `-help`, `-type` and `-extract <keypath> raw` are allowed, and a mention inside another command's quoted argument (`echo "plutil -convert json x"`) is not a plutil call. The plists live outside every repository, so this rule applies in every session where fleet-guard is installed, with or without `.omp/fleet.json`. The conformance corpus has fire and quiet rows under the new `fleet-guard-plutil-in-place` tool admission, checked by `ttsr-harness --gate-json` and an independent differential-oracle reference. (ompkit-ffb85)

## [0.2.67] - 2026-10-22

### Added

- `omp-kit service` has a `loop-sentinel` daemon job, so the fleet loop sentinel no longer dies with the seat that started it. Its command is operator data, not a kit path: `"loopSentinel": {"argv": ["/absolute/program", ...], "cwd": "/absolute/dir"}` in fleet-watch.json. The plist runs that argv directly under `KeepAlive true` (systemd `Restart=always`), so a clean exit relaunches too, and logs go to `Library/Logs/omp-kit/loop-sentinel.{out,err}.log`. Without the key, `service install loop-sentinel` refuses `LOOP_SENTINEL_UNCONFIGURED` (an unusable entry refuses `LOOP_SENTINEL_CONFIG_INVALID`) and writes nothing. `service status` reports `state: "UNCONFIGURED"`, `service doctor` reports a `configured` WARN, and a hand `service run loop-sentinel` is refused `LOOP_SENTINEL_SUPERVISED`. Daemon status rows now carry `liveness` (`LIVE`, `DEAD` or `UNKNOWN`). A label launchd reports as not found reads as DEAD. The daemon KeepAlive/Restart contract checks now apply each job's own restart policy in both directions. (ompkit-b4zip)

### Fixed

- The fleet-watch tick now reaps stale empty git locks (ompkit-fp72.19.1.9 GITLOCK1). The gated reaper in `src/index-lock.ts` (empty, at least 120 s old, no lsof holder, no git process in the repo, identity unchanged; rename aside, never delete) had no caller, so a dead writer's `.git/index.lock` refused every commit until someone moved it by hand (188 min in one repo, 28 h in another on 2026-10-22). Each configured repo is reaped once per tick; a receipt goes to the kit's lock ledger and the fleet-watch log. `gitLockReap: null` disables the phase.

## [0.2.66] - 2026-10-22

### Added

- kitlib run, one bounded-run primitive in two languages (ompkit-hsfyp): `run(argv, {deadline_s, grace_s, max_output_bytes, stdin, cwd, env, rlimit_cpu_s, rlimit_as_bytes})` in `src/kitlib/run.ts` and `scripts/kitlib_run.py` (shipped in every release beside `pysafe.py`) returns `{rc, timed_out, killed, stdout, stderr, truncated, elapsed_s}`. The child leads its own process group with stdin `/dev/null` unless bytes are given; at the deadline the group gets SIGTERM, grace, then SIGKILL and is always reaped; output past the per-stream cap is read and discarded (`truncated`), so a 50 MB writer leaves the parent's memory flat. Only the group the call created is ever signalled. Optional CPU and address-space limits fail closed (exit 126) where the platform refuses them. Both halves pass one shared corpus, `tests/fixtures/kitlib-run/corpus.json`.
- `scripts/native-candidate.py` certification children now run through kitlib run: its hand-rolled `killpg` loop is gone, and output past 64 MiB per stream is refused instead of parsed truncated.
- `pysafe.run_bounded` now sweeps the process group with SIGKILL once the leader exits cleanly, so a descendant that redirected its pipes away no longer outlives the call, as its documentation already promised.
- fleet-guard now checks write ownership when the write happens, not at commit. In the checkout of a repository that opted in with `.omp/fleet.json`, a write or edit tool call, a bash redirect, a `cp`/`mv`/`install`/`tee`/`sed -i` target (and an `mv` source), or a `git add`/`git stage` pathspec outside `var/agent-tmp/` is refused (`WRITE_OWN_UNRESERVED`) unless the caller's `AGENT_NAME` holds a live exclusive Agent Mail reservation covering it. The refusal names the exact `am file_reservations reserve <project> <agent> <path> --exclusive` call. The lookup is the one `git commit --only` already uses (`am robot reservations`, attested current); a failed or unattested read refuses (`WRITE_OWN_LOOKUP_UNAVAILABLE`), and so does a missing identity (`WRITE_OWN_NO_IDENTITY`). `git add` with no pathspec, with `-u`/`-A`/`-p`, with `:/` magic or with a pathspec file is refused as unscoped staging (`WRITE_OWN_BLANKET_ADD`), because staging belongs inside `git commit --only -- <paths>`; a pathspec given through a variable is refused as `WRITE_OWN_UNRESOLVED_PATHSPEC`. Reservation patterns now cover paths the way Agent Mail matches them (fnmatch: `*`, `?`, `[...]`), for both this check and `git commit --only`. Replaying 4,000 recorded fleet bash commands, the change adds three refusals over HEAD: a redirect into an ad-hoc `.edn99-current.tmp/` directory at the checkout root, a redirect of `default-fold-boundary.out` into the checkout root, and an `mv` of the companion's `node_modules` out of the checkout. (ompkit-vf33j)

### Fixed

- Agents can no longer switch the Agent Mail commit guard off. fleet-guard refuses any agent tool call that sets `AGENT_MAIL_BYPASS` or `AGENT_MAIL_GUARD_MODE` (`BYPASS_ENV`, naming the variable): a `NAME=value` prefix, an assignment-only command, an `env` operand (including after `env -u`/`-i` options), or an `export`/`declare`/`typeset`/`readonly`/`local` operand, inside nested shells and substitutions as well. Mentioning, unsetting (`unset`, `env -u`) and reading the variables are still allowed, and a person in a plain terminal is unaffected. The conformance corpus has fire and quiet rows for both variables under the new `fleet-guard-bypass-env` tool admission, checked by `ttsr-harness --gate-json` and the independent differential-oracle reference. (ompkit-0daxx)
- `omp-kit drain stale-claims` (and `doctor --scope beads`) now implement the AGENTS reclaim rule: an in_progress/rework bead untouched 24 h is listed only when its holder is not live. Liveness (new `src/holder-liveness.ts`) is a live seat (the Agent Mail identity registry's name for a live Tern block or tmux pane), genuine Agent Mail activity within 24 h (send, read, ack, reservation grant; `last_active_ts` alone never counts), or a live reservation. An unreadable source lists the row `UNKNOWN` with no reclaim, never drops it. The old 24 h-unassigned / 48 h-evidence rule reported 0 rows while dead holders sat on 25-47 h claims. (ompkit-f9dun)
- The printed reclaim is one atomic write that cannot hit the `--if-unchanged` ordering trap: `br update ID --status open --assignee "" --if-unchanged 'REV' --transition-comment 'reclaimed DATE: no live holder'`. kit-flywheel-guard's `PARTIAL_RELEASE_REFUSED` now lets a third party run exactly that shape when the claim is untouched 24 h and the holder reads DEAD at the act; a live or UNKNOWN holder, a fresh touch, or a missing revision/comment/cleared assignee stays refused. (ompkit-f9dun)
- Drain parsed br's zoneless comment stamps (`2026-10-22 05:47:39`, UTC) as host-local time, shifting every comment by the host offset (+6 h on MDT): stale claims looked fresh and close-queue verdict timing was skewed. Zoneless stamps are now read as UTC. (ompkit-f9dun)
- The commit-msg notes member (`hooks.d/commit-msg/46-omp-kit-commit-notes`) now asks `release-notes.ts fragment-for` instead of checking that a fragment file exists, so it applies the release rule: a `Bead:` fragment counts only if it was added or modified since the latest stable `vX.Y.Z` tag (staged in this commit or committed after the tag). A fragment that already shipped in the last release no longer lets a commit through that `release-local.sh` then refuses (00828a5, bcf52aa and 33f0c61 blocked 0.2.65). The waiver and single-`Bead:` rules now live only in `release-notes.ts`; the installer copies the resolver and its deadline wrapper beside the member, and the member fails closed after 60 seconds.
- A write-tool write into owned scratch is no longer refused (`materialized source facts exceed admission limit`) in a repository that tracks more than 1024 files, such as omp-kit (2,613) or the companion (1,173). The working-copy source-copy comparison is now limited by how much work it does instead of by repository size: it runs `lstat` in parallel batches of 64 under a 1.5 s budget and hashes same-size candidates in batches. It still refuses, fail-closed, on real overload: more than 200,000 index entries or an exhausted time budget. Content that is byte-equal to a modified tracked working copy is still refused. (ompkit-ma3sn)
- Bead-lint admission now runs in every session that loads the kit, not only panes that put `br-shim.sh` on PATH. The kit-flywheel-guard checks each bash `br create` and content-changing `br update` (including `--status in_review`) with the release-shipped helpers (`scripts/br-create-lint.py`, `scripts/br-update-lint.py`, `scripts/bead_lint.py`, `scripts/br_create_guard_core.py`) before the command runs. A failing bead is refused `BEAD_LINT_REFUSED` with the failing check names and a WHAT:/WHY: template. A lint-read value the shell would expand at run time (`$VAR`, `$(...)`, backticks, `$'...'`, `--description-file -`) is refused `BEAD_LINT_UNEVALUABLE`; `$(cat <<'EOF' ... EOF)` bodies are read literally. A helper that cannot run (missing helper or python, unreadable tracker, timeout) warns `BEAD_LINT_UNVERIFIED` and allows. The release package now ships the four lint files.
- Restore the real pre-commit and pre-push regex regression fixtures with the checker's subprocess dependency, so safe changes pass and unsafe changes are rejected for the intended reason.

## [0.2.65] - 2026-10-22

### Added

- `omp-kit doctor --scope secrets` enforces the no-ambient-secrets guard (ompkit-3h11): it fails, naming variable names and never values, on literal secret-shaped exports in shell startup files, secret-shaped names in the global tmux environment, and non-allowlisted secret-shaped names in the live process environment.
- Add the versioned `cc.view` spool event contract with declared panel, route, and client fields; reject undeclared client values before any event is written. (ompkit-fp72.120.16.14.21)
- `omp-kit service` writes an operator-set `OMP_KIT_CI_REPOS` (comma-separated owner/repo) into the ci-poller launchd plist and systemd unit; the shipped default polls no repos. (ompkit-fp72.79)

### Changed

- Admission end-to-end coverage (ompkit-bj08.5) now includes the service launchers observed on the fleet and one e2e row per admission case, so a launcher the kit does not admit fails the suite instead of passing unseen.
- Add the canonical `policy/rules.jsonl` registry and `policy/rules.schema.json` contract, publish `scripts/rule_pipeline.py`, and keep live status fail-closed until an S6 receipt exists. [ompkit-fp72.19.1.30]
- Mutation receipts validate image digests with the bounded `isSha256Hex` check instead of an unanchored pattern. (ompkit-mlpl)
- Scratch durability facts tests pin a quiet synthetic src fixture and a firing shadow copy. (ompkit-pann)

### Fixed

- The Agent Mail storage-root gate (ompkit-2ayxn) refuses a commit when the hook chain did not hand the resolved archive root to the Agent Mail guard. An Agent Mail hook reinstall rewrites the chain runner and drops the omp-kit bootstrap; the guard then read its own default root, matched no archive and allowed every commit, so exclusive reservations went unchecked. The refusal names the remedy: re-run `scripts/install-pre-commit-storage-root-gate.sh`.
- fleet-guard now refuses a bash call whose executed `mktemp` allocates outside repo-local `var/agent-tmp` (`fleet-guard scratch-alloc`), including inside `$(…)`, backquotes, process substitution, unquoted here-documents, `eval` and `sh -c`/`bash -lc` text. The FreshPI1 shape `root=$(mktemp -d /tmp/pi1-installed-real.XXXXXX); … cp -R … "$root/…"` was admitted before. The default and `-t` destinations, TMPDIR, computed templates and options the pinned dialect does not define (Darwin BSD `mktemp` on macOS; only `-d -q -u` elsewhere and for `gmktemp`) are refused. Literal templates under repo-local `var/agent-tmp` and inert quoted, escaped, commented or quoted-delimiter here-document text still pass. The git and scratch guards now share one budgeted lexical traversal that also splits commands at newlines, skips comments, and refuses shell text it cannot delimit, so a second command on a new line can no longer hide `git commit --amend` or `git push`.
- fleet-guard scratch admission (ompkit-ma3sn) reads the scratch owner through the canonical owner parser, so a write-tool write into an owned scratch dir is admitted whether the owner is the seat form fleet-guard writes (with `agent`, `session`, `bin`) or the JSON form `omp-kit scratch new` writes. Before, only the legacy four-field owner was accepted and every write into a session's own `TMPDIR` was refused as invalid metadata. An owner naming another repository, or an unresolvable one, is still refused.
- The fleet-restart skill again ships its owned archive selftest (`skills/fleet-restart/tests/selftest-owned.sh`), which a mixed-scope land deleted by accident, and its step 8 documents that protected panes come from the fleet config.
- `omp-kit scratch new` releases ledger reservations whose scratch directory no longer exists before checking the seat budget, so dirs removed by tests or interrupted cleanup stop blocking new scratch. (ompkit-774u.9.14)
- `omp-kit tern-ref` reads br's JSON envelope, runs qwen searches under the qwen interpreter (refusing `QWEN_UNAVAILABLE` when it is absent), guards the daemon socket, and accepts `drift --site`. (ompkit-fp72.120.8)
- Tern seat observation pins the daemon socket (`TERN_DAEMON_SOCKET`, else `$TERN_CONFIG_DIR/daemon.sock`, else the default settings socket) and resolves the seat's window before any read: an explicit key is verified with `--window KEY`; an empty key addresses Tern's default window only when that window lists the configured session. Unresolvable seats are refused, never observed blind. (ompkit-kdbz.2.16)
- Fleet lessons read the user's fleet overlay instead of the shipped config; an empty shipped fleet list reports `FLEET_LESSONS_NOT_CONFIGURED` rather than an empty success. (ompkit-oq1h.7)
- The fleet respawn finder (ompkit-xa5s.6) accepts versioned Tern omp install paths and session files under a pane's subtree, so a seat started from a versioned omp release is found and respawned instead of reported missing.

## [0.2.64] - 2026-10-22

### Changed

- FLEETOPTIN1 (ompkit-26xhq): opt this repo into the shipped fleet guards with `.omp/fleet.json {"enabled": true}`. Until now fleet-guard (scratch writes, blanket git, TMPDIR to owned scratch), kit-save-guard (write ledger) and kit-agent-mail-guard returned early in every fleet repo, because no repo had the opt-in file.
- MAILWAKEREG1 (ompkit-dh9b4): stop registering the library module extensions/kit-mail-wake.ts as an omp extension. It has no factory, and every fresh seat on 0.2.63 warned 'Extension does not export a valid factory function'. kit-agent-mail-guard already imports it. ext-manifest.test.ts now imports every loaded entry and requires a default-exported factory.
- Exact-version OMP source-cache repair isolates Bun's registry cache and discards it after verification, so a corrupt user-wide cache cannot keep required runtime files missing. (ompkit-rhy9.12)
- Release archives now include the opt-in fleet rule tree and `MANIFEST.fleet.tsv`, so installed ladder manifest stages validate both packaged rule packs instead of stopping before harness and claim-selftest stages.
- Make `scripts/build-manifest.sh` portable in clean source archives (canonical physical root, private scratch, direct Bun producer) so manifest checks and installer dry-runs do not route `rule-class.ts` through a missing embedded runtime; add a control plus stale-manifest refusal regression. (ompkit-oq1h.8)
- Bundle all shipped extensions that import kit source helpers so release archives load every guard without a checkout `src/` tree. (ompkit-v66l.31)
- The guard recognizes native `read` text ranges and raw-mode selectors in either documented order as observed rereads; arbitrary suffixes, conflict summaries, image modes, and failed or truncated reads still cannot clear the gate (ompkit-xa5s.36).

### Fixed

- Local release qualification also runs the bundled matcher selftest before creating a tag, so passing fixture coverage alone is insufficient. (ompkit-v66l.27.12)
- Keep Bash calls outside file-durability target validation; native scratch ownership metadata remains handled by the scratch lifecycle. (ompkit-v66l.27.12)
- Kit-update postcheck errors now distinguish unverified or mismatched OMP versions, fast matcher failures and live-test failures instead of returning only a generic postcheck error. (ompkit-v66l.27.12)

## [0.2.63] - 2026-10-21

### Added

- `kit-flywheel-guard` refuses `br update --status blocked` on a bead with no open blocks edge to a non-closed bead, unless the bead carries the `human-gate` label backed by a `HUMAN-GATE: <effect only Joshua can perform>` comment. A closed blocker, a parent-child edge or a related edge is not a fix; an unreadable bead is refused (BLOCK_REFUSED). It also refuses a bead close that would leave a blocked bead with no open blocker, unless the same command releases it with `br update <bead> --status open` (BLOCK_RELEASE_REQUIRED). Its tracker-mutation checks (close, claim, start, blocked) also follow `sh -c`, `bash -lc`, `zsh -c` and `dash -c` strings up to three levels deep, so wrapping `br` in a shell skips none of them. Stock-runner parity: with no `br` binary on the seat, or outside a beads tracker (`NOT_INITIALIZED`), the blocked check stands down and the seat sees the tool's own error; a live tracker that cannot answer stays fail-closed.
- `omp-kit doctor --scope secrets` enforces the no-ambient-secrets guard (ompkit-3h11): it FAILs, naming names only and never values, on a literal secret-shaped export in `~/.zshenv`, `~/.zshrc`, `~/.zprofile`, or `~/.config/zsh/*.zsh`; on a secret-shaped name in `tmux show-environment -g`; and on a non-allowlisted secret-shaped name in the live process environment, reporting how many local omp processes still run on a pre-guard environment until respawned from a fresh shell. Test seams (`OMP_KIT_SECRET_SCAN_RC_FILES`, `OMP_KIT_SECRET_SCAN_PROCESS_ENV`, `OMP_KIT_SECRET_SCAN_PROCESS_COUNT`, `OMP_KIT_SECRET_SCAN_ALLOWLIST`) drive planted-fixture tests with synthetic values only.
- Every agent write is now attributed (ompkit-52p3 OWN1-LEDGER). On a successful write/edit/ast_edit tool result with a confirmed byte change, `kit-save-guard` appends `{repo, relpath, agent, session, ts, blob}` to a per-repo append-only JSONL ledger under the kit state dir (`$XDG_STATE_HOME/omp-kit/write-ledger/`, never in the repo) via the new `extensions/kit-write-ledger.ts`. The census (`censusDirtyPaths`) attributes a dirty path to its last ledger writer while that writer is live, else to the owner of record by rule; paths with no entry stay unattributed. The save guard demands a save only for paths whose last ledger writer is the current session, so a peer's leased edit (the 2026-10-17 QuietBadger case) produces no save demand. Ledger appends measured at 0 ms p95 over 200 writes (budget 5 ms), and a ledger failure returns `ok:false` without ever blocking the tool call. (ompkit-52p3)
- README.md now states the current release in a generated `kit-release` block (`Current release: vX.Y.Z`) that the release train restamps on every version bump, so each tag's README names its own version; readme-check exempts the block from the version-literal rule and goes RED when the stamped version disagrees with `package.json`. (ompkit-fp72.135.1.6)
- SHAFIND1 (ompkit-fp72.19.1.22): `omp-kit sha <sha>` resolves a cited commit across every fleet repo (omp-kit, omp-kit-companion, `~/.claude`, project repos), printing each holding repo with its subject and origin/main containment; exit 0 found, 1 absent everywhere. Graders must run it before declaring a commit missing, and `grade_apply.py` refuses a REWORK verdict that cites a missing commit without the verb's `SHA-ABSENT-EVERYWHERE` output.
- MP6 cross-session registry: one machine-local row per fleet session
  (`src/session-registry.ts`), seeded from
  `uds/registries/upgrade_policy.toml` (holds, no-upgrade windows) and each
  session mission record's blast radius (owner pane, shared binaries with
  version floors, blast radius), every field with its source recorded.
  `validateSessionRegistry` refuses rows missing a field or a source,
  `findOverlaps` flags multi-owner binaries/paths/session-scopes for MP2,
  and `checkHoldViolations` reports installed binaries below a pinned floor
  (e.g. jev's br 0.7.4). Live seed: 5 sessions enumerated; omp-test and jev
  complete; uds (no mission record), localbench and cfsios (no owner pane
  declared) reported incomplete with named errors. uds-lane cutover reads the
  generated `session-registry.json` instead of the embedded checkout copy.
  (ompkit-rc-epic-land-fix-release-dogfood-rz5.98)
- Add a scheduled tag-release gap sweep with receipt artifacts and planted detection/quiet controls.
- Add a post-publication release verifier that checks the published asset inventory, exact sizes and SHA-256 digests, Sigstore attestations, isolated-HOME offline `--version`/`--help` smoke, and unchanged release/tag identities. Missing assets, tampering, and moved tags return typed refusal reasons.
- `extensions/kit-mail-wake.ts` (MAILWAKE1): Agent Mail sends get a wake path. `beforeSend` resolves each recipient to a live Tern seat (pane identity `~/.config/agent-mail/identity/<sha1(repo)[:12]>/tern-<block>` matched against `tern inspect --json` live blocks) and refuses an `ack_required` ask to a recipient with no wake path (no live seat, or a background/task agent) with `NO_WAKE_PATH`, naming the parent seat or director (fleet-roster.json, an "under <Name>" task description, or the repo's fleet-watch director). Nothing is sent. After a successful send, `afterSend` queues `MAIL <id> from <sender>: <subject>` to each seated recipient through `omp-kit send <tab> tern:<block> ... --until-delivered 600`, so a busy seat gets it at its next turn boundary. Each outcome is written to `~/.local/state/omp-kit/mail-wake.jsonl`, keyed by message id, and appended to the sender's tool result in the same turn (`WAKE_DELIVERED`, `WAKE_QUEUED`, or `UNSIGNALED` with the reason). FYI mail to a recipient with no wake path is still delivered, with an `UNSIGNALED` notice. The server's `signaled` flag stays false because only the server can append a signal receipt, and it does so only when `NOTIFICATIONS_ENABLED` is set. The module takes effect once kit-agent-mail-guard calls both entry points; that wiring lands separately. (ompkit-uk9wn)

### Changed

- Preserve quarantined live-agent work during expiry: fresh unowned mtimes and live seat leases now veto deletion (ompkit-6knq2).
- SCRATCHROOT1 (`ompkit-774u.9.13`): `scratch new` now refuses a non-repository working directory before creating `var/agent-tmp`, so a directory can never be created from a cwd that `scratch release` cannot discover.
- TESTSCOPE1 adds a stock Bun runner regression with a planted failing test under `var/agent-tmp/**` and a passing control, proving repository scratch copies stay excluded.
- DISKSTAGE-WIRE1 wires statvfs staged admission into the real heavy entrypoint and adds the wave-log open gate; STOP/CRITICAL stages emit named refusal receipts and request reaping.
- Paused: idle uncommitted work of inactive seats saved as a [pending] commit before the 2026-10-20 token pause (ompkit-bu1i3).
- PLANPORT1 (bead ompkit-f1zn5): `omp-kit planning score` finds a repo's
  comprehensive plan from `<repo>/.omp/plan.toml` `[plan]` (`name`, `path`,
  `reviews`), the config the omp-kit plan tooling reads, and scores it as
  mission `<name>`. Its `plan_rounds` counts review rounds from the review
  files (distinct `round<label>-*.md` names plus `findings.jsonl` `round`
  fields), falling back to `plan(<name>): review round N` commit subjects
  only when the review dir has none; `plan_last_diff` is the plan's change
  in the commit that recorded the latest round. `OMP_KIT_PLAN_CONFIG=PATH`
  scores a repo against a plan config kept outside it. On omp-kit the
  comprehensive plan now scores 41.67 (plan_present PASS, 749 citing beads;
  plan_rounds 5 from review files 1, 2, 3, 4, 4b; plan_last_diff 0.0036)
  instead of being invisible; the other missions' scores are unchanged.
  A missing override, malformed config or plan path outside the repo is
  `UNKNOWN` naming the reason. Pinned by three tests in
  `tests/cli/planning-score.test.ts`. (ompkit-f1zn5)
- New kit skill `skills/fleet-restart`: one repeatable fleet restart (snapshot, align, gated `/restart` with per-pane verify, handoff, chief restart, flywheel re-dispatch, callback check). Its `scripts/fleet_restart.py` is plan/dry-run by default; `send --apply` needs an operator approval bound to the manifest sha256. It refuses busy panes, launch commands that differ from the live process flags, sends without the fleet tmux socket, and restarts while any profile plugin link points at an older release (RELINK1). Agents are detected by their omp process, not by model name. `scripts/selftest.py` runs 41 gates, each with a planted negative or a paired control.
- `service status` now preserves launchctl query failures as `loaded: null` with `query_ok` and a fixed `query_error`, while successful absent-label queries remain distinguishable from parser failures.
- Add the TOKENSCAN1 storage boundary with path/offset-only findings, generated-registry digest receipts, gzip support, and fail-closed missing-screen or unreadable-store handling. (ompkit-fp72.120.16.15.8)
- Add a JSONL CAPA rule pipeline with schema validation, S6 live-proof gating, lexical matching, and repeat/andon P0 escalation. [ompkit-fp72.19.1.30]
- Preserve explicitly untracked repositories as `UNTRACKED` in CI status without turning the overall result into a false failure. (ompkit-fp72.38)
- Product edits, builds, and publication now authorize the canonical companion source root and reject frozen, tracker, and symlink-alias source copies.
- RCHLOCK1: dead-wrapper lease reporting now names `rch` as the sole retirement authority (`terminal_acknowledged` or `recover-consumed-*`). `omp-kit` reports unreapable leases and never deletes or rewrites producer-owned lease state.
- Load `extensions/secret-output-guard.ts` through `package.json` omp.extensions (was shipped but never ran); add `omp.notLoadedExtensions` so every non-test extensions/*.ts is either loaded or explicitly excused with a reason, enforced by `extensions/ext-manifest.test.ts`. (ompkit-fp72.135.1.10)
- INSTALLVER1 (ompkit-fp72.135.1.11): the README install blocks now fail closed when the latest-release lookup fails (empty version exits non-zero naming the GitHub API rate limit with a `gh api` fallback, nothing downloaded), state the `gh auth login`/`GH_TOKEN` prerequisite, use one canonical block with a TMPDIR-respecting temp dir, and the installer attestation refuses name the login instruction. Gate: tests/cli/install-block.test.sh 9/9 (stubbed-403 planted, normal-response control, logged-out-gh planted).
- Bundle the source-pinned DCG fleet-hazard pack 1.3.1 as a manifest-verified configuration asset; activation remains explicit and documented coverage gaps remain unresolved.
- Accept schema-valid omitted optional tracker text and labels during planning conversion; continue rejecting malformed present values, invalid identities, priorities, targets, and dependency cycles.
- `omp-kit doctor --scope secrets`: fetches every readable Infisical value through the operator's identity (infisical-helpers lib.sh + Keychain), keeps only sha256 digests of credential-named values (and user:password URLs), and scans ~/.config, ~/.local/{bin,share}, ~/.omp, ~/.claude, ~/.codex, ~/Library/LaunchAgents, zsh rc files and `--root` repositories' tracked files. FAIL names file + vault NAME, never a value; secret-shaped names in `tmux show-environment -g` also FAIL; Infisical unreachable is UNVERIFIED, never PASS; caps and truncation are reported (ompkit-l8h5).
- `--staged` scans only the index; `scripts/pre-commit-secret-scan.sh` wraps it as a pre-commit hook that blocks a staged vault value and warns (does not block) when Infisical is unreachable. Install: `cp scripts/pre-commit-secret-scan.sh "$(git rev-parse --git-path hooks)/pre-commit"` (Agent Mail chains: `hooks.d/pre-commit/20-omp-kit-secret-scan`).
- New rule kit-no-plaintext-secret: interrupts a bash/write/edit call that puts a literal credential into an rc, .env, JSON/TOML/YAML/shell config or command line; `$(cf-secret NAME)`, `${VAR}`, `!cf-secret` values, placeholders and bare names stay quiet (ompkit-l8h5).
- Provider-config values that are pure lowercase-hyphen slugs stay out of the digest set; token-shaped values under the same names remain covered.
- Public client-key names ending in `_ANON_KEY` or `_PUBLISHABLE_KEY`, and names prefixed `NEXT_PUBLIC_` or `EXPO_PUBLIC_`, stay out of the secret digest set; `_SERVICE_ROLE_KEY` remains scanned (ompkit-l8h5).
- Land the MP6-registry seam for the tracker-health tick: `FleetWatchConfig.registeredTrackers` (repo + owning-director session) is parsed by `loadFleetWatchConfig`, every registered tracker is covered once per tick even without a session entry, and a registered session no configured session names gets a named `NO_OWNING_DIRECTOR` block with zero recover commands. Recovery log actions now carry `repo`. Covered by `tests/cli/fleet-watch-registered-trackers.test.ts` (positive, malformed-config and legacy-absent negatives).
- Add bounded retention to the fleet-watch tracker-health lifecycle: plan and reap owned, dead, completed `.br-wal-index-*` and schema-migration quarantine artifacts beyond the 7-day bound with a per-path reason/receipt, while unresolved, recent, held, foreign, symlinked, ownership-unknown, live-sidecar and cert targets stay byte-identical and reported protected under OWNERSHIP_FINAL_LIVENESS_DECISION. (ompkit-rhy9.15)
- Retire the duplicated per-session tracker recovery branch only after the successor kit cutover passes (`checkTrackerRecoveryCutover`: installed kit ≥ 0.2.63, registry tracker-health job enabled, tracker registered); any missing or stale precondition keeps the local incumbent with zero behavior change. Ships `rules/kit-no-live-tracker-sqlite.md`, which forbids raw live-tracker SQLite readers (shell, read-tool DB URIs, eval-kernel opens, ATTACH) and directs agents to native br/bv or disposable copies; beads_rust#532 stays an unconfirmed mitigation. (ompkit-rhy9.16)
- Restore the guarded fleet-watch cutover consumer and native post-recovery readback; an absent configured registry recovery path keeps the incumbent, and a live holder no longer consumes its next recovery opportunity.
- Route reserved uncommitted work stranded over 30 minutes to its configured director with save-sweep details, persistent episode deduplication and clearing after recovery; leave unknown ownership explicitly unresolved.
- The kit-upgrade notice now tells a fleet seat to restart itself instead of waiting on the chief's loop sentinel. Fleet mode, meaning the self-restart helper is installed at `~/.claude/skills/omp-kit-orchestration/scripts/self_restart.py`, lists three steps in order: (1) save work with `git commit --only` on your reserved paths and publish, or make a `[pending]` commit; (2) run `python3 ~/.claude/skills/omp-kit-orchestration/scripts/self_restart.py`; (3) end the turn with no further tool call. The helper pauses the goal, reloads the seat on the new release and resumes the goal. Without the helper (stock mode), the notice says only how to restart omp (`omp --resume`). The hand-written handoff-ledger step is gone. (ompkit-v66l.33)
- `service run kit-update` now accepts a poll-only config (`OMP_KIT_UPDATE_ENABLED=1`, `OMP_KIT_UPDATE_POLL=github`, `OMP_KIT_UPDATE_REPO=owner/repo`) instead of refusing with `KIT_UPDATE_JOB_CONFIG`; with no static tuple and nothing newer published the tick reports `CURRENT`, and after every `UPDATED` the job re-renders its launchd plist with the new binary so `StartInterval` tracks the code (now 300 s; a stale 3600 plist is rewritten on install).
- Bound the turn-end save retry budget to the demand itself: an unchanged finding (same roots, paths, shared/retired/omitted sets, and working-tree blobs) is not re-demanded on the next wake, while new own bytes re-arm the demand. (ompkit-xa5s.17)
- DELETEEFFECT (bead ompkit-xa5s.23): new canonical `extensions/delete-effect-admission.ts` binds shell-rm and edit-rem protected DELETE to the same valid approval state at the effect level. It classifies `rm` spellings, hashline `REM`, `{path, edits:[{op:delete}]}`, and `*** Delete File:` inputs from exact omp sources without executing anything; missing/denied/pending/stale/mismatched approval or unbounded scope refuses before effect with actor/path/request/action/approval/time custody. `createSlbGuard` accepts the admission as an opt-in second check (unconfigured behavior unchanged: Bash-only). Proven by `extensions/delete-effect-admission.test.ts` (29 tests: same-path specimens across adapters, planted approval negatives, guard-removal wiring refusal, read/PUT pass-through, no-execution proof). Recoverability of the original incident files stays UNKNOWN; no restore/replay/retroapproval. Activation with production protected roots and the SLB approval provider is an owner step.
- Split fleet-protocol rules into opt-in `rules-fleet/` pack: 10 companion rules prescribing fleet protocol (`var/agent-tmp`, AGENTS.md Storing/Pushing, Agent Mail, ntm, director, Josh, infisical) move out of the default `rules/` pack; default `omp-kit apply rules` and plugin installs ship neutral rules only. (ompkit-oq1h.8)
- Add `MANIFEST.fleet.tsv`, `cases/cases-fleet.tsv` (99 fleet cases), and `scripts/check-default-pack-neutral.sh` (`--check`/`--selftest` denylist lint over the default pack); `scripts/build-manifest.sh` now derives and checks both manifests. (ompkit-oq1h.8)
- Reclaim stale `rework` beads to `open` so holderless work returns to the claimable pull. (ompkit-rpfe4)
- UBSTIME1: add a source-bound single-file UBS wrapper with a fixed 120-second module budget; timeout, incomplete output, and missing environment are typed `UNKNOWN` non-verdicts, with control and planted-timeout contract tests.
- OMPDRIFT1: added `omp-recert` test-record persistence and drift decisions.
- Unchanged OMP versions short-circuit with `OK`; patch, minor, and major changes produce `STALE-OMP` and trigger `test --record`. Missing or failed records are never presented as current.
- Added regression coverage, including the planted negative that rejects unconditional recertification.
- Run the README count/command/size rules at commit time: pre-commit member 46-omp-kit-staged-readme judges the candidate index tree whenever staged paths include README.md, skills/**, rules/*.md, src/commands.ts or package.json, so the author of a stale or full README is refused instead of the next pusher.
- Free S1 headroom by moving the Comparison, Troubleshooting and FAQ sections to docs/ with one-line pointers (README 53400 bytes against the 54872 p75 bound); restore the omp-kit-native skill bullet and the custody, intake and doctor --scope land reference rows; fix the scope (36) and rule (26) counts.
- Harden companion Python against hangs (ompkit-xa5s.34.2): route subprocess spawns through pysafe.run_bounded (process-group kill, DEVNULL stdin, hard deadline, byte caps) with timeout+DEVNULL and inline reasons for provable single-process leaves; bound the release-reuse qualification sweep by attempts. pysafe_check over scripts/, checkers/, tests/: 97 to 0 unsuppressed findings.
- Make COMPACTION_REREAD tell small-context agents to read any line range of AGENTS.md while preserving the observed-content requirement (ompkit-xa5s.36).

### Fixed

- kit-flywheel-guard no longer writes a close token that is not a bead id (an unexpanded `$b`, a reason sentence read as an id) into a closeguard record's `bead`. Refused-close records keep the refusal without `bead`, and receipts skip it with a notice, so neither dead-letters at command-center ingest (CLOSEGUARDBEAD1, ompkit-5vi6p).
- New `omp-kit heavy --disk-observer statfs|sbh|auto` overrides `load.json`'s `disk_observer` for one call, and `OMP_KIT_DISK_OBSERVER` sets the same default ambiently for callers that cannot take a flag (the pre-push gate uses it for nested ladders). Without the flag or the env override, admission is unchanged.
- Heavy calls nested inside the save path (`test --full` running under the pre-push gate, where the ladder cannot take a per-call flag) admit on physical bytes too: the gate exports `OMP_KIT_DISK_OBSERVER=statfs`, `heavy` honors it as the ambient form of `--disk-observer` (precedence: flag, then env, then `load.json`), and the isolated-run allowlist carries it into the fixture. Standalone runs leave it unset, where admission is unchanged. An invalid value refuses loudly instead of silently changing admission. The `WARN disk-pressure:` line now also names the three largest scratch owners (`top_scratch=label:size,...`) so the waste loop knows where to start.
- Release tagging now refuses when `package.json` (`.version` and `.omp.version`) does not state the tag version: new `release-train.sh version-match` gate (exit 4, fail-closed on missing/unparseable manifests), wired into the `tag-qualified` authority step, `release-local.sh` and `sign-darwin-release.sh`; `package.json` bumped to 0.2.63 so the next tag carries its own version (ompkit-fp72.135.1.14). The retired `tag-after-green.sh` path (ompkit-fp72.65) was deliberately left untouched.
- The 13 fleet extensions loaded by every named profile now have versioned copies in `extensions/` registered in `policy/extensions.json`, so `doctor` verifies their bytes and profile listings against shipped sources instead of trusting unversioned `~/.omp/omp-extensions` files with no owner, history, or CI. A profile entry pointing at an unversioned file (unknown name, drifted bytes, or unreadable path) is reported as `unversioned_extensions` and the extensions finding goes DEGRADED. (ompkit-fp72.15)
- The ee orient payload is no longer withheld at session start: the versioned `ee-ambient-session-start.ts` raises the output budget from 1200 to 12000 tokens (16000 verbose), covering the observed 9125–11059 token estimates, with an `EE_AMBIENT_CONTEXT_BUDGET` override for operators and tests. Forcing the old 1200 budget reproduces the withheld payload in tests. (ompkit-fp72.15)
- `apply policy --plan` now verifies release rule bytes against MANIFEST.tsv before planning and refuses with SOURCE_INVALID naming the disagreeing file instead of returning a generic refusal. The policy refusal path threads the underlying cause into `errors[0].message` and `data.cause_code`/`data.cause_message` instead of discarding it.
- OWNERWORK1 (`ompkit-gm0v`): the `kit-no-owner-homework` corpus now cites real occurrences instead of shapes. `cases/cases.tsv` swaps the four unverifiable fire/quiet shapes for verbatim rows mined by targeted search over owned checkouts: 5 fire rows covering 7 real handoff occurrences across 2 repos (LilacLeopard mount-source/custody handoff in cfs-vx3zy/cfs-c5sx9, the cfs-9939 mounted-integration-test slice parked on Josh twice) and 5 real correct-escalation quiet rows (emergency-contact human decision, live secret custody, billing total, public-claims/pricing judgment) plus 2 boundary rows, with the two pinned planted rows byte-identical. Full gate PASS (31 rules, 500 cases, 0 quiet-prefix fires), metamorphic PASS (453 cases, 2395 variants, 0 breaks), revert-proof RED with the rule absent. Rule bytes unchanged, so the prior live PASS still binds. Corpus mapping and three analyzed exclusions (correction-text COND2 false positive, Joshua-truncation prefix artifact, trailing-consequence tradeoff) in `docs/evidence/gm0v-corpus.md`.
- Fleet-watch no longer treats a stale or unavailable work-coordination projection as an empty queue: `src/work-projection.ts` classifies the projection against its freshness contract (default 45s bound from the observed producer contract) and forces an UNKNOWN verdict requiring a fresh native `br ready` reread, never dispatching from empty data. A live pane reporting `safe_to_dispatch=false` is never an eligible send target.
- Agent Mail validation reads the secret-scanning rule from its fleet-pack location after the rule move. (commit e0c2796)
- Validated Agent Mail sends can receive the current seat's registration token without overriding an explicitly supplied token. (commit c37d804)
- Fleet hook refresh checks installed hook bytes and reports failed or stale refreshes instead of claiming success. (commit d146d19)
- Expose the hooks doctor scope and preserve launchd query failures as unverified service state. (commit 3e78080)
- Remote-build admission accepts finite, nonnegative worker disk-space telemetry in bytes when gigabyte telemetry is absent. (commit fa3c900)
- Fleet restart derives protected panes from fleet configuration. (commit ed8a913)
- Release packaging accepts clean source exports without an optional scratch directory, bundles the rule-pipeline helper, and separates cross-compiler scratch from package output.
- Run send-verification fire and quiet cases with the fleet rule pack instead of referencing a fleet-only rule from the default release gate.
- Every scratch dir a seated caller makes now names its seat: `createScratch` falls back to the live seat lookup when no seat is injected, so programmatic creations stamp `agent`+`session` exactly like the CLI path, and unseated callers keep pid owners. A new `attributeOwnerSeat` resolves any structured owner to its seat — a seated record through its session lease, a pid-only record through the session leases its holder's ancestry holds — so a live holder always resolves to a live seat and a dead holder resolves to none, which is what makes it reclaimable. Reap verdicts are unchanged. (ompkit-1dnwk)
- Keep Bun compile scratch inside the package build's owned temporary directory, and have the scratch reaper remove stale root-level `.bun-build` leftovers only after an age and open-file safety check.
- BV-verified claims now emit an explicit source marker, and the planning skill requires recording it atomically with the claim transition so weekly self-pick rates can be measured.
- `omp-kit send` binds pause and recipient generation at the mutation boundary: a pause declared (`OMP_KIT_SEND_PAUSED=1`) or a replaced target pane between observation and submission refuses with zero sends instead of sending on a stale snapshot. `service run` and `service run fleet-watch` re-read the off switch and the observed launcher set at the effects boundary, so a pause declared or a second launcher appearing after the pre-lock check refuses with zero effects.
- `apply plugin --apply` no longer reports PARTIAL with empty `errors[]` when the default profile snapshot is incomplete. Pre-apply and post-mutation refusals keep the specific `snapshot_issue` (e.g. `PLUGIN_SNAPSHOT_INCOMPLETE:<path>`) in the row reason instead of collapsing to generic `PROFILE_SNAPSHOT_UNVERIFIED`, and failed rows project to top-level `errors[]` entries naming profile and cause; an incomplete snapshot never reports success. (ompkit-fp72.29)
- Cold-LSP CI diagnostics: the `one alternative root marker` readiness test prints the probe report (status, reason, timeout observation, selected server, omp rc, JSON-RPC trace) only when the status is not `PASS`, so the next cold-start `INCOMPLETE` names its stage. The real cold request stays the positive control; no warm-up, no budget change.
- Kit updates and the installer now require authentic GitHub Sigstore/SLSA provenance bound to the selected source commit before extraction or activation; missing bundles or verification authority refuse instead of falling back to checksums alone.
- Fresh-gate launcher no longer forces a location-dependent `OMP_KIT_CASE_CWD` default: an explicit caller override (e.g. pre-push-gate) is preserved, otherwise the harness hermetic case root applies, so the verdict is identical whether the archive was extracted under `var/agent-tmp` or outside it. The run ledger now resolves the pushing checkout's git dir from `ROOT` directly. Quiet rows 375/376/379 stay quiet and a real scratch-path write still fires.
- The isolated CLI crosscheck now probes OMP before cases and reports a trust-guard refusal as an actionable NOT_RUN stage instead of 429 unparseable matcher errors; trust policy remains unchanged.
- Reject forked restart sessions when `parentSession` appears after OMP's title record.
- `kit-save-guard` canonicalizes paths before attribution, so macOS tmpdir repos no longer silently skip the save demand. `/var` is a symlink to `/private/var`: `$TMPDIR` spells a repo `/var/...` while `git rev-parse --show-toplevel` spells it `/private/var/...`, and `path.relative` across the two spellings escapes with `..`, which the guard read as outside-the-repo (fail-open). Session roots, tool paths, snapshot keys, and discovered git roots are now resolved through the nearest existing ancestor directory (a final-component symlink keeps its identity), making attribution identical for either spelling. (ompkit-so0li)
- Installed integration proofs launch the packaged mock-model server with the executable's embedded Bun runtime, instead of relaunching the CLI and failing before the profile matrix runs.
- Installed live proofs accept a validated caller-owned repo scratch root without moving their sandbox into system temporary storage; unowned, symlinked and foreign-workspace roots remain refused.
- `omp-kit test --integrations` creates its work dir under `OMP_KIT_TEST_WORK_ROOT` when it names a validated caller-owned scratch root, instead of always using the OS temp dir; unowned or foreign-workspace roots fail closed with `INTEGRATIONS_UNAVAILABLE` naming the root. `--keep` is now a registered flag that retains the isolated work dir for inspection.
- Disposal checks charge only the caller's exact scratch ownership and ignore live parent or sibling seats.
- `omp-kit send SESSION tern:<id> MESSAGE` now routes to the verified native Tern delivery with session-file proof instead of the tmux/ntm path that could never land on a Tern seat (LIVE MISS 2026-10-19: two coordinator sends reported NOT_DELIVERED while the raw transport worked). Malformed `tern:` addresses refuse before delivery with `TERN_MALFORMED_ADDRESS` and zero sends; `--cwd` (default: caller cwd) and `--window-key` (default: verified default window) scope the seat binding.
- New `rules/kit-teach-send-verify.md`: bare `ntm send` reminds toward `omp-kit send` (marker proof, one retry, drop-folder fallback); kit send invocations and prose mentions stay quiet.
- The exact-commit fresh gate now boots the compiled CLI with `--version` and every statically registered handler's `--help`, refusing pushes that register a verb without its committed grammar.
- Fleet guard now refuses every raw `git push` from a tool call before effect, whatever the ref spelling (new branch, `HEAD:refs/heads/*`, SHA or HEAD to `refs/agent-candidates/*`, `refs/heads/main`, deletion refspecs, `--tags`/`--all`/`--mirror`), and the branch/worktree refusal now names the private-index landing route. Both refusals point at `omp-kit land --paths <reserved> --message <msg> --apply` with an active exclusive reservation; naming a candidate ref or a prior feasibility proof is not a permit, and the branch opt-out never admits a push. Dry runs (`-n`/`--dry-run`), `git stash push`, reads, and quoted prose stay quiet. Native owner-bound publication (`omp-kit land --apply` converging to `refs/heads/main`) never traverses this tool-call gate, so it is the only publication path. (ompkit-xa5s.11)
- `ompkit-xa5s.2`: rewrote forbidden instructions in 4 skill reference files under
  `~/.claude/skills` to the fleet rule (one canonical checkout on `main`, no rebase or
  stash in a shared checkout, evidence close): `frankensqlite-mega-skill/references/REPO-WORKFLOW.md`
  (negation-first stash line, evidence-close example), `ntm/references/SPAWN.md` (TOC,
  `--worktrees` flag row, and scenario 2 redirect), `ntm/references/TROUBLESHOOTING.md`
  (worktree-identity paragraph), `world-class-doctor-mode-for-cli-tools/references/exemplars/exemplars.md`
  (dcg-redirect exemplar no longer names stash as the shared-checkout alternative).
- Classified the remaining 57 firing files as legitimate with reasons (subject-is-the-act:
  14 `git-stash-janitor`, 30 `git-worktree-branch-rationalization`, `git-worktree-manager`,
  `using-git-worktrees`; guard-policy docs: 5 `dcg`; quoted upstream text: 6 `planning-arc` ledgers).
- Verified with the shipped rule: pre-edit Triggered (1) on all 4 files, post-edit quiet,
  full rescan 61 -> 57 files (only the legitimate list), planted bare `--reason "done"`
  in a temp copy fires. Edits left uncommitted in `~/.claude` (no commit/push per worker contract).

## [0.2.62] - 2026-10-20

### Added

- Intake verb wiring with ROUTE delivery and fleet_report injection (35 pass / 0 fail).
- The scratch plan boundary now pins the 72h unowned-active rule with a literal mid-boundary test: a 60-hour-idle unowned dir with no open fds plans LIVE `unowned-but-active`, so a 48h `QUARANTINE_IDLE_MS` drift mutant flips it to QUARANTINE and fails. The test asserts literals only (no shared-constant import), closing the tautological-constant gap alongside the existing totals-forwarding, open-fd guard, and help-policy kill checks.
- `omp-kit land` qualifies every publication candidate against its actual construction parent before any check or push: the candidate must carry the explicitly named `refs/heads/main` ref, exactly one actual parent equal to the qualified base, byte-identical owned content with no drift since qualification, no restored bytes the actual parent superseded (a caller patch that reverts an owned file to seed content is refused as `LAND_STALE_RESTORE`), only reserved owned paths, and re-proved exclusive custody at publication time. Anything else publishes nothing (`LAND_ACTUAL_PARENT_MISMATCH`, `LAND_CANDIDATE_CONTENT_MISMATCH`, `LAND_FOREIGN_PATH_PUBLISH`, `LAND_CUSTODY_EXPIRED`, `LAND_PUBLICATION_REF_UNNAMED`).
- `omp-kit doctor --scope land` reports the land guard identity: guard `actual-parent-custody-v1`, publication ref, pane-bound owner and owner capability (or `UNKNOWN`), actual-parent read capability (`native-git` or `UNKNOWN`), and decision (`READY` or `UNKNOWN`) with evidence.
- The designated-committer save sweep is packaged: `src/save-sweep.ts` plans each due sweep from the `doctor --scope work --fleet --json` audit boundary, grouping eligible leftover work into logical guarded commits without editing file contents, pushing only when the branch exists on an owned remote, releasing only its own reservations after push, and re-auditing to AM-id holds or UNKNOWNs. One committer per repo is named in the fleet overlay (`fleet.toml` repo `committer`, `sweep_interval_minutes` 60-120); two committers for one repo refuse. Live Agent Mail-id holds strand byte-identical and uncommitted; holds with no AM id or addressed to Josh strand explicitly; removing the reservation/hold validator refuses via its named control. The stale "fleet is idle, force-release" shortcut is not packaged. (ompkit-rhy9.23)

### Changed

- CC14 `service run cc` execs the fleet lanes + HTTP (ompkit-fp72.120.16.18.2).
- `src/service.ts` (new, pure addition): `ccServiceCommand(home,
  adapter)` builds the daemon argv `python3 <fleet_root>/scripts/cc/cc.py
  serve --host 127.0.0.1 --port 7474 --lanes` with `CC_STATE` set to the
  service state dir; `CC_SERVICE_HOST`/`CC_SERVICE_PORT` constants.
- `src/cli.ts` (additive): the daemon run branch routes job `cc` to
  `runCcService`, which holds the one-instance lock for the child
  lifetime, forwards SIGTERM/SIGINT so no orphaned server survives the
  stop, and maps the child exit (0 OK/EXITED, else CC_SERVICE_EXIT; spawn
  failure CC_SERVICE_SPAWN_FAILED). Other daemons keep
  SERVICE_BODY_UNIMPLEMENTED; FLEET_ADAPTER_ABSENT unchanged.
- Tests: `known_jobs_includes_cc_daemon`, `run_cc_resolves_fleet_root`
  (exact argv + CC_STATE); the lock test now execs the fixture adapter
  stub and asserts code 0 job cc EXITED. `bun test
  tests/cli/service-daemon.test.ts` 16/16.
- Remainder (operator-side): `omp-kit service install cc --apply --yes`
  on the fleet host, kickstart, heartbeat-after-restart poll.
- Record at the land owner seam that the `tern:<id>` mapping resolves a declared Agent Mail pane registration (binding=legacy-unverified), not cryptographic or current-native identity proof. (ompkit-kdbz.1.2.1)
- doctor --scope beads now reports a bead_breadth finding for acceptance spanning more than the configured file/component limits, with bead id, measured file/component spans and a concrete per-component split suggestion; planning score carries the same bead_breadth metric from the shared analyzeBeadBreadth decision so both consumers count identical oversized ids and follow limit changes together. At-limit, single-component and repeated-mention beads are not oversized; missing or unparseable breadth evidence is UNKNOWN, never zero. (ompkit-rhy9.21)
- Release packager now bundles `extensions/kit-flywheel-guard.ts` (resolving its `../src/cc-spool.ts` import at build time, same precedent as `fleet-guard`) so the flywheel, save and agent-mail guards load from the installed tree, and refuses to seal any build whose packaged extensions do not all import from the packaged tree (`EXTENSION_LOAD_FAILED` names the file and module).
- Fleet-restart re-dispatch fixes (ompkit-uxr3): every staged director/worker text names its pane and session, names the callback channel (the pane's own output, where the chief's sitrep sweep reads tails), and directors get `ntm health` for every run session, not just their own (cross-session directors). Worker texts hold for the director's dispatch instead of self-assigning from `br ready` (that double-assigned on 2026-10-11). HOLD_CWD panes are proven excluded from restart/respawn manifests and the handoff names the operator relocation step. `scripts/selftest.py` proves each with planted negatives.

### Fixed

- Fleet-restart no longer holds a respawn pane for scratch that carries over on its omp session lease. `skills/fleet-restart/scripts/fr_save.py` parses each owned dir's seat (`agent` + `session`, same record and patterns as the kit owner) and, once the installed kit carries seat liveness (0.2.49+), drops `HOLD_SCRATCH_OWNER` for dirs naming the pane's own session while its lease is held or unprobable; pid-only owners, foreign-seat owners, provably unheld leases and older kits hold exactly as before. The live re-check before each respawn send (`revalidate_respawn`, now fed `run`/`home` at both send sites) applies the same rule, and the save row names carried dirs in `carried_scratch` for the receipt. Proved against installed 0.2.61: a dead-pid idle seat-owned dir reads `LIVE owner-seat-alive` with the lease held and `REAP owner-dead-no-open-fds` with it released, while a pid-only control reaps either way. (ompkit-774u.4.1)

## [0.2.61] - 2026-10-20

### Added

- Contract-safe custody attempt surface in verb test and e2e. (commit c2c7eb5, ompkit-fp72.120.16.2.1)
- Enforcement at every disposal point (Joshua scope 2026-10-20): bead close, hand-off to review, wave close, push and session end each refuse while the session holds an undisposed dir. `disposalGate` refuses on positive evidence only and logs one `flag` audit row per refusal; an unlistable ownership census is fail-open (`unproven`), never a block. `omp-kit scratch gate --at review|close|wave|push|session-end` is the enforcement surface for closers with no native gate (exit 1 with `SCRATCH_OWED` on owed, exit 0 with `UNPROVEN` when unlistable). Holds are owed until discharged: `kit-flywheel-guard` now refuses `br update --status in_review` and `br close` with `SCRATCH_DISPOSAL_REFUSED` (a missing or failing `omp-kit` never blocks), and `land`'s `beforePush` refuses publication on owed dirs after the repo check passes.
- Quarantined holds are vetoed, never deleted: `applyQuarantineExpiry` skips `quarantine-hold-active` while the hold's bead is open or unprovable and `quarantine-hold-expired` once expired (flagged in the reap log, bytes wait for the owner); only a closed bead discharges the hold back to the normal liveness path.
- `omp-kit scratch release DIR --bin throwaway --now` deletes the dir in the same turn after the reaper-grade rechecks (pinned device and inode, unchanged owner text, owner still inside the scratch root, no open files, logged as `release-deleted`). Any doubt keeps the marked dir for the reaper (ok, `now-held-*`); `--now` is refused without `--bin throwaway`, on free-prose owners, and never touches a hold or an already-released dir.

### Changed

- Keepalive re-arm: fire() re-arms for the interval remainder instead of dropping it. (commit 6009c83, ompkit-fp72.120.16.23.1)
- Emit closeguard bead.status receipts with actor, verifier, and evidence ids on successful allowed bead closes, and record refused self-closes as action.result outcome refused; spool failure never blocks the close. (ompkit-fp72.120.16.7.2)
- Split fleet-protocol rules into opt-in `rules-fleet/` pack: 8 companion rules prescribing fleet protocol (`var/agent-tmp`, AGENTS.md Storing/Pushing, Agent Mail, ntm, director, Josh, infisical) move out of the default `rules/` pack; default `omp-kit apply rules` and plugin installs ship neutral rules only. (ompkit-oq1h.8)
- Add `MANIFEST.fleet.tsv`, `cases/cases-fleet.tsv` (95 fleet cases), and `scripts/check-default-pack-neutral.sh` (`--check`/`--selftest` denylist lint over the default pack); `scripts/build-manifest.sh` now derives and checks both manifests. (ompkit-oq1h.8)

### Fixed

- `omp-kit scratch release` on a directory whose `.owner` fails validation now names the first failing owner field and the accepted owner field sets (`pid,process_start,label,repo,created_at,argv0` or `pid,label,repo,created`) in the refusal detail, instead of a bare `bin-needs-structured-owner`. (ompkit-774u.15.1)
- Scratch seat budgets enforced at creation: the reservation ledger refuses `scratch new` past the seat cap, naming dir, owner and budget; releases free the reservation. (ompkit-774u.9.10)
- Bead-gated prompt delete: text-owner dirs with a closed or missing bead delete without the quarantine wait (rechecked at apply; open beads roll back); unregistered scratch verbs no longer crash CLI startup. (ompkit-774u.9.10)
- Kit CC codes fit the contract alphabet: surfaces and instances fold `:`/space separators so ingest stops dead-lettering kit envelopes. (ompkit-fp72.120.16.11.9)
- Test leak fix: inert_without_state removes its state dir in finally; suite runs leave 0 new unowned dirs. (commit 65c456e, ompkit-fp72.19.1.43)
- Free-prose legacy owners parse bead from text with root-repo check. (commit 79c377f, ompkit-fp72.19.1.43)

## [0.2.60] - 2026-10-20

### Added

- Session HEALTH gate (`src/session-health.ts` `reconcileSessionHealth`, bead ompkit-fp72.11): HEALTH judges agent panes only. A stale user or shell pane is a WARNING and the prelude proceeds to INTEGRATE; only a dead or unreachable orchestrator or worker pane BLOCKS. No orchestrator or worker pane observed at all blocks (fail closed). The prelude must call this wrapper and never gate on an `ntm health` exit code (dead surface, ntm retired).
- New `omp-kit custody check --repo PATH [--agent NAME] [--reserve [--ttl SECONDS] [--reason TEXT]] PATH` verb answers "may I edit this path" from git and Agent Mail reservations via the fleet checkout's `scripts/cc/custody.py`, without reimplementing custody logic. One PATH per call (the kit grammar allows a command at most one positional); the moot-share denominator counts calls. Exit codes pass through exactly (0 GRANTED, 10 HELD, 11 DIRTY_UNOWNED, 2 usage/outside-repo, 3 probe failure); an absent adapter refuses `CUSTODY_ADAPTER_ABSENT` exit 3 and never grants. Every call emits one `action.attempt` on surface `kit:custody check`, and 10/11 record result outcome ok. (ompkit-fp72.120.16.2.1)
- `omp-kit land --patch FILE --message MSG --apply --yes` (alias `-m` for `--message`) reconstructs only the caller-selected hunks onto fresh `origin/main` instead of publishing whole worktree paths. The patch must be a standard `a/`/`b/` unified diff (as produced by `git diff` or `git format-patch`); every named file needs the caller's active exclusive reservation, and `--paths` is refused in combination with `--patch`. Reconstruction fetches fresh `origin/main`, applies the patch with three-way merge in a detached scratch worktree parented on the fresh remote tip, and publishes the exact checked candidate with an ordinary non-force push. The shared worktree and index never contribute bytes, so unrelated staged and worktree content stays identical and a stale local `main` is never moved. A non-applying patch or true three-way conflict is refused as `PATCH_CONFLICT` naming the file and conflicting hunks without creating or publishing a commit; origin movement during construction is refused as `LAND_ORIGIN_MOVED` without retry or force. The base-registered `.omp/push-check` admits the exact reconstructed candidate before publication, and a patch that changes the check itself is reported `SKIP`. Consumer: the designated UDS committer drives patch mode with explicit caller patch files; whole-file `--paths` mode is preserved unchanged. (ompkit-rhy9.8)

### Changed

- Admit rch builds by worker memory pressure and build disk, not slot count alone: a worker at or above the memory-pressure refusal threshold, with unknown memory telemetry, or without build disk headroom refuses; the least-pressured admissible worker is chosen. (ompkit-774u.6.1)
- Report a SIGKILLed remote build (exit 137) as an OOM kill naming the worker, never as a plain test failure, and retry it once on another worker. (ompkit-774u.6.1)
- Restore the scratch-owner no-respawn guard: owned work scratch newer than the last push is `HOLD_SCRATCH_OWNER` at save, in `respawn_row`, in run plan/apply (including the chief's printed command), and in live pre-send revalidation, with zero respawns while held. Remove the unapproved unconditional `omp-kit scratch apply` global reaping from apply run. Approved preservation (dirty-repo pin plus held-scratch copy) is retained and is explicitly not successor ownership. (ompkit-rhy9.7)
- Add byte-compatible TS spool writer `src/cc-spool.ts` (`ccSpool`) mirroring cclib.Spool: identical make_id, canonical JSON, envelope fields, newest-day append, tail termination, and looksSecret U-redaction; inert without fleet state and never throwing into the caller. Covered by golden, unit, and e2e proof. (ompkit-fp72.120.16.11.3)
- Every `omp-kit` verb now emits `action.attempt` before dispatch and `action.result` after (plus one `source.tick` per invocation) to the `kit` spool producer, covering the heavy early-return path and launchd `service run` jobs as their own surfaces; byte-identical stdout/stderr/exit codes, inert without fleet state. (ompkit-fp72.120.16.11.4)
- Kit supervisor gains a long-running `daemon` job kind (CC14 .18.1): launchd `KeepAlive { SuccessfulExit = false }` + `RunAtLoad`, `ThrottleInterval` 60; systemd `Type=simple` with `Restart=on-failure` / `RestartSec=60` and no timer/path trigger. `service run` for daemons holds a one-instance flock on `<state>/jobs/<name>.lock` (second instance exits 75 `ALREADY_RUNNING`); daemon install/run refuse `FLEET_ADAPTER_ABSENT` unless the fleet checkout holding `scripts/cc/cc.py` resolves. New SVC1 contract checks `contract-daemon-keepalive` and `contract-daemon-lock`. Minimal `cc` job entry scaffolds .18.2. (ompkit-fp72.120.16.18.1)
- GOALKEEP1 resume boundary: a seat whose goal was restored by a
- session resume now re-learns goal state from the latest
- `mode_change` transcript entry on session_start/switch, so the
- 120 s idle timer arms even when no `goal_updated` ever arrives
- (live miss: active-goal seat idle 14+ min, no wake).
- (ompkit-fp72.120.16.23.1)
- INTAKE1 route slice (`src/intake-route.ts`): resolve seat roles from the fleet-watch roster, print DO for role-owned work and ROUTE down one rung otherwise, refuse self-do without Joshua's quoted words.
- INTAKE1 deliver slice (`src/intake-deliver.ts`): br assignee update plus agent mail plus tern delivery with a session-file marker proof (one retry, drop-folder fallback), deterministic markers for idempotent redelivery, hourly fleet_report intake counts from the record ledger.
- Refuse a fleet seat blocking its turn on its own background work (WAIT_REFUSED): the `wait` tool, non-async bash sleep-poll loops (for/while/until, do/then/else tails), `sleep` totalling >= 30 s across the call, and eval/python `time.sleep` looped or >= 20 s. Every refusal names the next downtime action; async bash jobs and short single sleeps pass (ompkit-fp72.19.1.24).
- Supervise every background agent a seat launches: the bg-supervisor registry records pid, parent seat, bead, task digest, checkpoint path, deadline, restart policy and starting release; a killed agent restarts from its checkpoint, one that fails maxRestarts times is reported to the director instead of looping, upgrade notices never reach a registered agent, and results arrive as an inbox/aside event so the seat never polls. (ompkit-fp72.19.1.27)
- Port the mission anchor planted negatives missing from the companion: ANCHOR_DOC_INIT_TEMPLATE markers plus check in missionAnchorStatus, with init-template and unregistered-record regression tests (tests/cli/mission-anchor.test.ts 11/11 green). (ompkit-fp72.9)
- Add docs/mission-anchor-mapping.md: the documented mapping deriving the single anchor from the live-doc Mission statement and the .omp/mission.toml record, adapted to this repo (ROADMAP-first candidates, numbered headings, repeat-per-repo CLI). (ompkit-fp72.9)
- Atomic worker parking and one-active claim in kit-flywheel-guard (ompkit-kdbz.1.1): releasing a live held claim must write OPEN plus a cleared assignee under the seen revision in one call, by the holder; bare, unguarded, or third-party half-parks refuse before mutation with an argv plus before-revision ledger. A second implementation claim while the actor holds an active bead refuses naming the held id; repair releases of ownerless or already-open beads and nonauthor reviews pass untouched.
- Add a `readiness_waits_elapsed_bounded` probe check refusing readiness waits with a missing or negative `elapsed_ms` (demotes PASS to INCOMPLETE); the cold test and the planted slow/never-ready fixture pin numeric non-negative elapsed per attempt. (ompkit-l9kv)
- Identity doctor keeps binding strength: `resolve-pane` results carry project, source, seat, and verified/unverified strength instead of collapsing to a bare name; only qualified live-pane `agent-mail:resolve-pane` bindings verify a sender. (ompkit-fp72.95)
- `doctor --scope identity` evidence reports the checked/unchecked denominator (`checked_panes`/`unchecked_panes` over `live_panes`) with distinct collision/missing/stale/unverified findings; name-only, legacy-unverified, adopted-dead, and director-seat-substituted bindings stay unverified with the missing field named.
- Identity doctor reports self-custody readback: `doctor --scope identity` evidence lists every observed project/name binding per live seat (`seat_rows`), classifies each known reservation holder relative to that seat as `held-by-this-pane`, `peer`, or `unresolved` (seat-wins over bare names; ambiguous or invented names never verify), and `attributeAckSender` binds an acknowledgement only to the exact acking-seat binding, else UNKNOWN. (ompkit-fp72.96)
- Remove per-user `/Users/josh` literals from the shipped fleet-restart and fleet-round skills: socket hints, setup examples, HEALTH text, and selftest fixtures now use `$HOME`/`~`/bare tool names or the shared-docs path, so `git grep -n /Users/josh -- skills` is empty. (ompkit-oq1h.9)
- Stage the director HEALTH clause from PATH-resolved tools: a missing flywheel or ntm is omitted from the message, never reported as run; no health tool on PATH yields an explicit record-by-hand line.
- Gate the watcher stage on macOS: off-darwin `watchers` commands and run plans report UNSUPPORTED with the launchd reason instead of calling a missing launchctl.
- Document the Linux/systemd (or manual) path for the fleet-round barrier timer next to the launchd template.
- Require the full-suite verdict for the exact candidate tree before every publication: `scripts/full-suite-verdict.sh` runs the complete declared suite against the exact-commit archive and caches the verdict by candidate tree hash with check/runtime identity bound to the entry; `scripts/pre-push-gate.sh` enforces it after the focused gate. Repeated identical trees reuse the recorded verdict without rerunning; changed trees, check bytes or runtimes rerun. (ompkit-rhy9.12)
- Qualify the corpus report's privacy and honest boundary: the no-egress test now observes the complete descendant tree (compiled CLI plus real matcher child) with a loopback honeypot and a direct-dial planted control through the same child runtime, and `corpus --plan` states that a fire rate is not a false-fire rate and does not establish blocking or calibration. (ompkit-rhy9.2)
- Omit tool-backed verbs (land, send, rch lease, fleet *, tern-ref *, planning convert, drain tracker verbs) from capabilities when their native binary (am, ntm, rch, tern, br, tmux) is absent from PATH; invoking one refuses with a named *_UNAVAILABLE code and exit 3 before any spawn. (ompkit-oq1h.6)
- doctor --scope work now reports stranded-work rows at the fleet JSON boundary: per-repo stranded/conditions discriminators for unpushed, dirty, stashes, linked worktrees, branch absent remotely, no-remote and unreadable; unreadable repos are explicitly UNKNOWN, never clean. New --fleet (canonical roots) and --stranded-only flags reuse inspectWorkFleet and the existing bounded discovery limits. (ompkit-rhy9.22)
- Seal a deterministic SPDX 2.3 SBOM sidecar per release archive naming the exact archive, binary, Bun runtime, and every manifest file with SHA256, and optionally sign archive plus SBOM with an operator Ed25519 key via --sign-key; scripts/verify-release.sh verifies detached signatures and SBOM-archive binding on a non-builder host, refusing planted tampering, wrong keys, and missing sigs. (ompkit-rc-epic-land-fix-release-dogfood-rz5.59.3.1)
- Calibrate rule noise with sampled false-fire rates: `doctor --scope rules --corpus-report/--labels` reports per-rule Wilson intervals with sample sizes, flags rules whose interval lower bound exceeds the threshold, and lists dead rules; invalid counts and schemas refuse with named errors. (ompkit-rc-epic-land-fix-release-dogfood-rz5.63)

### Fixed

- Clean-export startup crash fixed: removed send-import lines landed without their implementation; missing custody grammar already committed. (ompkit-371sl.1)
- Ownership lint is green again: the rch socket baseline writer and the report inject writer register their atomic-write temp files (`rch-baseline-atomic-tmp`, `report-atomic-tmp`), and both writers sweep stale crash-orphan tmps before writing. (ompkit-774u.12)
- Ownership registry: the rch socket baseline writer and the report
  inject writer register their atomic-write temp files and sweep stale
  crash-orphan tmps before writing (ownership lint green again).
  (ompkit-774u.12)
- Test suites no longer leak temp dirs: cli-actions and custody-verb fixtures track every mkdtemp dir under var/agent-tmp and remove them in afterAll; suite runs leave 0 new unowned dirs. (ompkit-fp72.19.1.43)
- `omp-kit scratch new --label L [--bead B] [--export COMMIT]` is the one writer agents use (JSON .owner, exact-commit export); the reaper parses legacy `key: value` text owners and reaps pid-less ones with no open fds and a closed or missing bead. AGENTS.md flips to the verb when the kit carrying it is installed. (ompkit-fp72.19.1.43)
- `omp-kit scratch new` CLI verb wired (branch, registration, registry entry); missing `custody` grammar committed (unbreaks clean-export startup); `omp-kit sha` fleet lookup (SHAFIND1) included from the tree. (ompkit-fp72.19.1.43)
- Made the kit-no-gh-poll VAR-star spans possessive via lookahead-capture plus backreference, cutting adversarial streaming cost with no verdict change (fire/quiet, G2/G3, selftest, and 498/498 native crosscheck green).
- `kit-flywheel-guard` now refuses bare custody writes (`br update <id> --assignee ...` with no classified status) on a live held claim before mutation (PARTIAL_RELEASE_REFUSED). Clearing the assignee without parking the status leaves an ownerless `in_progress` bead — the genuine BuildNext3/ompkit-fp72.95 shape (`assignee_changed BuildNext3 -> None`, status untouched, 2026-10-19T23:28:30Z) — and reassigning outside claim/park splits custody from the one-active check. Third-party custody writes are refused; repairs of ownerless or already-open beads still pass.
- Planning conversion no longer silently skips a changed acceptance under an existing `<mission>:<slug>` contribution token. When the stored acceptance boxes differ from the plan item's, the run refuses with a `STALE_ACCEPTANCE` finding naming the slug, bead id, missing boxes and stored boxes, before any write in that group.
- `omp-kit planning convert --apply` accepts `--amend-acceptance` to append only the missing acceptance boxes through the existing native `update --if-unchanged` revision gate; concurrent target changes are still refused, manually authored boxes are never deleted or rewritten, and stored boxes absent from the plan are reported as superseded so an old PASS on them is not counted.
- Fleet-watch native nudge never grades a parked deferred bead: jev-shaped nudge specimen proves no Grade directive names the deferred row while a legitimate in_review row is still assigned exactly once to a non-author and the free author-pane pulls the ready leaf instead.
- `extensions/kit-upgrade-notice.ts` (AUTOUPGRADE2 rework, ompkit-v66l.22.2): headless print-mode runs never receive the upgrade notice — the check returns early when stdout is not a TTY or no session identity exists, without consuming the per-release marker. Fleet seats (interactive, session-identified) behave exactly as before.

## [0.2.59] - 2026-10-19

### Added

- `kit-flywheel-guard` now refuses timed waits in fleet seats (`NO_WAIT_REFUSED`, J-2026-10-18-43): a bash call running `idle_wait.py` or `sleep` totalling 30 s or more (bare, chained, wrapped, or in `sh -c`) is blocked, and the reason names the downtime list (held beads, others' `in_review`, bead DAG repair, `/skill:reality-check-for-project`, `/skill:profiling-software-performance` then `/skill:extreme-software-optimization`). `sleep` under 30 s and sessions without a fleet identity pass. Planted refusals, passing controls, and a mutant run with the check unwired (wired test fails) cover the gate. (ompkit-fp72.19.1.13)

### Changed

- Wake an idle fleet goal seat with a typed downtime turn (`deliverAs: aside`) after 120 s idle, bounded to one wake per 10 min per seat; after 3 consecutive wakes whose turns made no tool call, stop waking and record GOAL_IDLE_ESCALATE so the sentinel mails the director and logs a prompt review (ompkit-fp72.120.16.23.1).
- INTAKE1 record slice (`src/intake-record.ts`): append joshua rows, work search-or-bead-args, rule DO.
- Add `kit-rea-runtime-shipped` (never interrupts): `lldb`/`dtruss`/`fs_usage` against a shipped target (`/Applications`, `.app/Contents/MacOS`, `/opt/homebrew`, `/opt/local`, `/usr/bin`, `/usr/sbin`, `/sbin`, `/System/Library|Applications`) routes to REA `capture_process_scenario`/`observe_native_calls`; own-code debugging, bare OS diagnostics, pid-only attaches, and `/usr/local` stay quiet. Seven matcher cases (three constructed fire probes, one real corpus quiet row, two constructed quiets, one planted near-miss) pass G2+G3. Corpus shows no real fire row yet; rule qualification pending ompkit-gbkj.2.9.
- Add a gated stale git-lock reaper (index.lock and next-index-*.lock older than 120 s with no lsof holder and no live git cwded at the repo are renamed aside, never unlinked, with a receipt in the fleet ledger), run it on every fleet-watch tick, expose it as `scratch index-lock --reap --yes`, and add a per-checkout `scripts/kit-commit.py` wrapper that serializes `git commit` with flock, retries transient lock collisions, and reaps its own leftover lock when killed.

### Fixed

- `kit-update` now re-runs the hook installer for every pull-enabled fleet repo after a successful install, recording each member's before/after sha256. Repos that track their hooks path (e.g. `core.hooksPath=.githooks`) report `PENDING_COMMIT` with the refreshed paths so the owning director commits them under a reservation; kit-update never commits them itself.
- `omp-kit doctor --scope hooks` lists, per fleet repo, the hook members whose digest differs from the active release.
- Heavy help text documents disk admission with exit codes: exit 75 when deferred, 69 when no disk observer is available (commit e775202).
- `kit-tool-result-is-not-json` ships fire and quiet fixtures in `cases/cases.tsv` again, so the kit-update postcheck's ttsr coverage gate passes on the shipped pack: a `JSON.parse` on tool-result text fires, `br show <id> --json | jq '.title'` stays quiet, and deleting either fixture fails the gate loudly instead of passing vacuously. The `omp-version` postcheck stage failure in the same incident needed no kit change: `runFullTest` short-circuits with `omp_version: null` while fast-test fails, and `kit-update.ts` surfaces that null as the `omp-version` failed stage, so it clears with the fast-test fix. (ompkit-v66l.27.12)
- `scripts/release-local.sh` runs the postcheck's ttsr coverage gate (`ttsr-harness --gate-json` on the exact-commit source) as stage `rule-gate` before the tag stage, in dry-run and real releases alike, and refuses (exit 4, nothing remote written) when a rule ships with zero fixtures. (ompkit-v66l.27.12)

## [0.2.58] - 2026-10-19

### Added

- `omp-kit rch lease` pre-build gc failure is pinned: when no slot is free and the pre-build `rch gc` fails, the cycle is `REFUSED rch_pre_gc_failed` and nothing is submitted, even if a later status read would admit (planted fixtures in `tests/cli/rch-cycle.test.ts`; the post-build side was already pinned: a failing post-build gc keeps a passing build at `UNREADY`, never `COMPLETE`).
- Registered `src/diagnostics.ts` (rch socket baseline pid-suffixed temp) in the `kit-temp-names` ownership entry; the pid names only the temp file, no owner is inferred.
- `fleet-restart`: `selftest.py` embeds the 2026-10-11 flag-loss replay (bead ompkit-fp72.19 AC [b]; handoff `omp-kit/docs/handoffs/fleet-restart-20261011.md`, step-1 defect): the six screen-built commands that carried an omp argv (uds--burn-down:0.2-0.6, zestroku:0.1) are refused `FLAGS_NOT_FROM_LIVE_ARGS` while the live flags are accepted, and uds--burn-down:0.1's worker-daemon argv is never an agent. The original `restart-plan.json` snapshot was reaped with that day's scratch, so the replay is reconstructed from the handoff text. Independent re-run: 228 PASS, 0 FAIL; each forced-open gate mutant (screen always IDLE, align always ok, flags always equal, TMUX env always ok) turns it red; `check.sh` CHECK: PASS.
- Kit-owned held-path custody guard (`src/fleet-guard/custody.ts`, ompkit-m3qu): the project director can add one `ownerHandoffs` row from inside the project via `br handoff add --path P --commit C --bead B`, admitted only when the worktree blob equals `git rev-parse <commit>:<path>`. Worker identities, drifted blobs, foreign repos/DBs, and import/export flags are refused; manifests, guard module, and `trackerRowExceptions` stay denied to every in-project tool call. Hashline edit payloads are parsed into `[PATH#TAG]` + `MV` targets (opaque payloads denied); `ntm wait` and `ntm <sub> --help` are read-only while send/spawn/kill stay denied; `br list/show/ready` and `bv --robot-*` need no lease while `br update/close` do. `createCustodyToolCallHandler` is the guard probe (new row ALLOWED, unrelated held path DENIED); `applyProjectGuard` replaces guard code/policy on a director-signed expected sha256 with before/after digests and undo; `doctorStaleGuard` reports panes running an older guard than disk.
- `scripts/install-commit-msg-bead.sh` installs a `pre-push` member (`41-omp-kit-pushed-vlevel`, byte-equal to the canonical omp-kit `scripts/pre-push-verification-level.sh`) that refuses a push whose range holds a non-exempt commit with no verification level in its subject; `--check` names it missing or stale. `rules/kit-no-shared-merge.md` and `rules/kit-skill-forbidden-instruction.md` carry the `GIT_INDEX_FILE=<same idx> git hook run commit-msg -- <msgfile>` step that private-index (`commit-tree`) landings must run before `commit-tree`, since plumbing skips the commit hooks. (ompkit-xa5s.37)
- `extensions/kit-upgrade-notice.ts` (AUTOUPGRADE1, ompkit-v66l.22.1): the seat's own kit extension detects the gap between the installed omp-kit release (the `~/.local/opt/omp-kit/bin/omp-kit` symlink target) and the release its process loaded (its own path under `releases/<v>/extensions/`) and injects exactly one notice per release per seat with `pi.sendMessage` (`deliverAs` `nextTurn` when idle, `aside` when busy): `omp-kit <installed> is installed; this seat runs <loaded>; upgrade now`, plus the three seat-duty steps (save with `commit --only`, write the handoff, end the turn idle for the sentinel's `respawn_seat --reload --resume-goal`). Sent markers persist per seat under `~/.local/state/omp-kit/`; any failure is fail-open (skipped with one warning) so version I/O can never block a seat. An up-to-date seat gets no notice; a behind seat gets one, never repeated.

### Changed

- Add kit-owned pre-emission tool-output protection (extensions/secret-output-guard.ts): gh token shapes become SHA-256 fingerprint prefixes, `security find-generic-password` password values redact before truncation, `cf-secret --list` captures reduce to key names only, and registration_token/sender_token plus equivalent binding fields redact before truncation/rendering. Synthetic sentinels only; 15 planted tests with guard-removal negatives. (ompkit-fp72.87)
- Record elapsed per LSP readiness attempt on the probe report (`readiness_waits`: one entry per issued status call with attempt, elapsed_ms, ready) and emit it in the B10_LSP_TIMING block; add a planted slow-to-ready / never-ready fixture proving the recording and the deterministic never-ready failure. (ompkit-l9kv)
- kit-flywheel-guard refuses the goal tool's `drop` and `complete` in fleet seats (`GOAL_END_REFUSED`, J-2026-10-18-44): a seat never ends its own goal; directors and chiefs change goals with `/goal set` (arm_seat.py --set), which never reaches the tool hook, and sessions without a fleet identity are untouched.
- kit-flywheel-guard refuses a raw `/goal` line typed into any pane from a fleet seat (`GOAL_SEND_REFUSED`, J-2026-10-18-45): goals change only through arm_seat.py --set, which sets stamped prompts only; identity-less sessions pass.
- Emit bounded redacted `B10_LSP_TIMING` case evidence (platform, status, elapsed_ms, known-positive discriminator, per-call timings with status readiness polls) from the cold LSP positive control on CI, and pin isolated cold-refusal inputs as distinguishable non-PASS outcomes with retained receipts. (ompkit-rc-epic-land-fix-release-dogfood-rz5.43.1)
- Make advisor restoration crash-safe: persist pre-send intent and WATCHDOG hashes, reconcile on resume without duplicate `/advisor on`, and report failed restoration.
- Track the v18.12 status bar (`π-<profile>` idle prompt) so badge/source parsing stays live; native harness skips the multi-page setup wizard to reach isolated panes.
- Refuse send_message to a recipient not registered under project_key before a phantom is created (AM_PHANTOM_REFUSED names the projects where the name IS registered, most-recently-active first, or says it is registered nowhere); refuse a sender_name naming another runtime's registration (AM_SENDER_COLLISION); warn-but-allow when the recipient lives in several projects and the target is not the most active (AM_PROJECT_AMBIGUOUS). An unreadable roster fails closed (AM_ROSTER_UNAVAILABLE). (ompkit-xa5s.16)
- Refuse structurally invalid corpus rows without losing parse-error tolerance: a syntactically valid session header declaring a non-numeric version/v schema shape exits as a named invalid-schema refusal, and a recognized assistant/toolCall record with the wrong required shape (non-array content, non-string tool name) exits as a named invalid-record refusal, both with exit 2 and no partial counts. (ompkit-rhy9.1)
- Keep malformed/truncated JSON counted as parse_errors, valid unrelated event types ignored, and the existing unknown numeric-version refusal unchanged; the corpus --plan contract now publishes the structural-vs-JSON-syntax distinction before reading sessions.
- Tracker recovery rejects symlinked run entries and wrong-type recovery artifacts before admission, returning `RECOVERY_BLOCKED` with zero native calls (commit 60c7e60).
- The flywheel guard now refuses a close whose authorship probe fails (garbled probe args, nonzero exit, unparseable output) under SELF_CLOSE_REFUSED instead of LOOKUP_REFUSED, so a garbled probe can never skip the self-certification check and let the close proceed. (ompkit-xa5s.13)

### Fixed

- The isolated regex budget no longer gives path-scoped rules a vacuous PASS. `scripts/regex-budget.ts` now sweeps a committed write/edit live-stream fixture (`scripts/fixtures/rx-write-edit-stream.md`, match / no-match / long-near-miss regions for `kit-regex-engineering`) in the same 16-byte prefix deltas as the bash stream, under its own named 500 ms budget (`WRITE_EDIT_STREAM_BUDGET_MS`). The full gate reports `write/edit stream: PASS ... median=91.0ms / 500ms` with `kit-regex-engineering#0` at a nonzero median of 29.4 ms; the bash stream section is unchanged (`median=178.9ms / 500ms`, same membership). A deleted fixture file fails the gate loudly instead of passing vacuously. (ompkit-13s6l)
- Every per-push extract is removed on every exit path, at the time and not later (GATESCR1, ompkit-fp72.40). The pre-push gate now runs its body in the background and waits, so SIGHUP/SIGINT/SIGTERM run its handler at once instead of after a hung suite ends; the handler stops every process the gate started (its whole descendant tree, snapshotted first, plus any process group one of them leads, with a 5 s grace before SIGKILL), removes the extract and keeps only the red `.owner` + `gate.log` record (exit 129/130/143). `scripts/fresh-gate.sh` does the same for its `WORK` dir, which is now pid-named (`fresh-gate.<pid>.*`) with `process_start` in `.owner` and its traps set before it exists.
- A start-up sweep at the beginning of each pre-push gate removes the extracts a SIGKILLed gate left in that repo's `var/agent-tmp`: only the gate's own naming class (`pre-push-gate.<pid>.*`, `pre-push-gate-base.<pid>.*`, `fresh-gate.*`), only when the recorded pid is no longer that process (dead, reused per `process_start`, or recorded before this boot) and `lsof +D` (bounded at 30 s) finds no holder, logging each removal as `gate-sweep: removed extract …`. A live gate's or a held extract is kept.
- Gate stdin is closed: after the ref line, the hook and fresh-gate run every checker contract and suite on `/dev/null`, so a test that reads stdin (the `readPipedInput` class) sees EOF instead of blocking on a pipe whose writer stays open. Contract: nine new cases in `tests/cli/pre-push-gate.test.sh` (TERM, HUP, INT, process-group timeout, green/red, SIGKILL then held then swept, live/reused owner, open-writer stdin, fresh-gate TERM/SIGKILL). [test]
- Scratch reaper: session dirs skipped for owner-label mismatch or an invalid label now age into quarantine (dead owner, no open files, 72 h idle) instead of stranding; failed quarantine/rename/delete actions record the exact path, action and OS error on stderr and the run receipt and fail the run, while expected safety refusals are counted and exit 0. (ompkit-3tgm)
- `kit-loop-guard` extension (ompkit-xa5s.18): counts consecutive same-signature tool errors in one turn; injects a named fix at 3 (JSON_PARSE errors point at the jq/subprocess method) and notifies the pane's director once at 6; any success resets the count.
- `kit-flywheel-guard` extension (ompkit-xa5s.22): every Bash deadline/service refusal now attributes the native job id, the server-side session owner, the command digest, and the effective deadline, and names the owning-session native async-job cancel route; tool input cannot spoof the owner and the guard issues no kill.
- `omp-kit rch lease` reports a bound wrapper whose native call failed without any recorded remote exit (an SSH transport timeout such as `RCH-E104`) as `UNREADY rch_transport_unavailable` instead of `BUILD_FAILED native_return_failed`. The installed package now ships the write/edit-stream budget fixture so installed runs find it.

## [0.2.57] - 2026-10-19

### Added

- `kit-save-guard` blocks `session_stop` while `scratch mine` reports an undisposed dir (labels + release command; binning restarts the retry budget); a missing/failing/unparseable `omp-kit` never blocks.

## [0.2.56] - 2026-10-19

### Added

- `omp-kit scratch apply --file-gaps` files each guarded gap class to its owning bead (one `br` comment per bead, only dirs no earlier run filed, logged as `gap_filed`); without the flag the exact commands are printed and nothing is filed.
- `createScratch` accepts `budgetBytes`, recorded as `budget=` in `.owner` (absent means unbounded; zero/negative/non-integer refused); `scratch mine` reports bytes, budget and `overBudget` per own dir with a count, and the gap report marks reclaimed dirs past budget.
- `scripts/release-local.sh` (LOCAL-RELEASE-V1) cuts a Developer ID signed and notarized release on the signing Mac without the CI pipeline (J-2026-10-18-30). It preflights the source, version and signer, builds the three ship targets from an exact-commit export, signs, notarizes and checksums them, then tags and creates a draft. `release.yml` attests and publishes the draft, and the driver verifies the result from the public URL with the consumer's own verifier. `--dry-run` stops before any remote write. `scripts/release-signing.json` now sets `darwin_signing` to `developer-id`.
- `release.yml` `attest-local` job and `mode` input. The job re-checks a draft against its `SHA256SUMS` and index, attests SLSA provenance and SBOMs with the workflow's OIDC identity at the tag ref, verifies every archive with `installer/install.py`, and publishes the draft. The installer's and updater's attestation policy is unchanged. `mode` defaults to `local-attest`; every qualify, native-matrix and signing job now requires `mode=ci-pipeline`, which the train's dispatches pass explicitly, so enabling the workflow cannot start the expensive pipeline.
- Release signing: the local signer's notary credential defaults to the profile `omp-kit-notary`, stored inside the signing keychain (unlocked from the uds password file), so notarization works with the screen locked. A rotation procedure is in `docs/release-signing.md`.
- `skills/omp-kit-native`: a situation-to-native-verb table for fleet agents (waiting with `idle_wait --max 600`, background verifiers per J-2026-10-18-12, publishing with `git_converge` and `CONVERGE_BUSY`, `omp-kit ci status`, `omp-kit scratch release`, `arm_seat` with drop-then-set on error, `omp-kit send`, scoped doctor, mission anchor, planning convert, `receipt.py`), each row citing the misuse rate it replaces, measured over 24 h on four live seats. It also adds the gap rule: every gap becomes a bead that turn, and kit gaps also go to the chief as a one-line GAP. `scripts/check_rows.py` confirms every taught verb and flag against the installed kit; its `--selftest` fails a row naming `omp-kit scratch mine`, an unknown flag, an unmeasured row or a missing situation.
- `scripts/pysafe.py` is a stdlib-only (Python 3.9+, macOS and Linux) cancel-safe runner shipped in every release: `run_bounded(argv, timeout, input=None, cap_bytes=...)` starts the child in its own session with stdin `/dev/null` unless input is given, reads output under one deadline with a per-stream byte cap, and on timeout or cancellation kills the whole process group (SIGTERM, grace, SIGKILL) and returns a typed `TIMEOUT`, so no grandchild outlives the call or keeps the caller waiting on its pipe. `urlopen_bounded` (socket timeout, total deadline, body cap), `read_stdin` (deadline and cap; never reads a terminal), `read_capped`, and `cancel_on_signals`/`run_main` (SIGTERM/SIGINT kill live child groups, run lock-release cleanups and exit 128+signal) complete it. Measured on CPython 3.9: `subprocess.run(timeout=)` returns at the timeout but leaves the grandchild running, and the documented `communicate(timeout)` then `kill()` then `communicate()` pattern blocks until the grandchild exits. (ompkit-xa5s.34)
- `scripts/pysafe_check.py` flags Python that can hang or read without bound: subprocess calls without a timeout, timed subprocess calls that orphan descendants, children that inherit stdin, network calls without a timeout, `join`/`get`/`acquire`/`wait`/`result`/`select` without a timeout, stdin reads without an `isatty()` guard, unbounded reads of pipes, sockets and responses, and `while True` loops with no deadline-bound exit. A finding is silenced only by an inline `# pysafe: <reason>` (or `# pysafe(rule): <reason>`); a reasonless or unused suppression is itself a finding. (ompkit-xa5s.34)
- A commit whose staged `.py` files add a new finding is refused at commit time. `scripts/install-commit-msg-bead.sh` installs a `pre-commit` member (`scripts/check-staged-pysafe.sh`, with `pysafe.py` and `pysafe_check.py` beside it) that judges the staged index, including the temporary index of `git commit --only`, against HEAD; findings already in HEAD do not block. The checker runs under a 60-second process-group deadline, so the member cannot hang a commit; a missing checker or a python3 older than 3.9 refuses rather than passes. CI applies the same rule to every changed `.py` file. (ompkit-xa5s.34)

### Changed

- The pre-push gate runs the affected bun tests in K parallel workers (`bun test --parallel`, K a quarter of the cores, 2..4, `FRESH_GATE_TEST_WORKERS` overrides), slowest files first from CI's `.github/core-test-timings.json`. A failure in any worker refuses the push.
- Tests that cannot be hermetic on a dev Mac are listed in `scripts/gate-ci-only.tsv` (path, kind, bead, expiry, reason). The pre-push gate excludes them, prints each exclusion, and reports `VERDICT PARTIAL ... deferred=...`; CI runs them. `ci-only` rows have no expiry. `hermeticity` rows are test bugs that must expire within 14 days, and an expired row runs again. A malformed manifest refuses with `CI_ONLY_MANIFEST_INVALID`. Product code whose only reaching tests are CI-only is refused with `NO_LOCAL_TESTS`. Listed tonight: `kit-update.test.ts` and `external-live.test.ts` (ci-only), and `package-release.test.ts` (ompkit-v66l.27.8) and `repair.test.ts` (ompkit-v66l.27.9) (hermeticity, expiring 2026-11-01).
- A selection whose predicted wall on K workers (CI per-file timings, 10 s for untimed files) exceeds 6 min (`FRESH_GATE_TEST_BUDGET_SECS`) runs nearest-first: the changed test files always, then the nearest importers while they fit. The rest are printed as `focused: deferred ...` and the verdict is `PARTIAL ... deferred=...`; CI runs them.

### Fixed

- RCHSOCK1 follow-up (ompkit-774u.6.4): doctor now detects a daemon socket path replaced by a different socket. `lsof` reports no inode for a unix socket, so path-existence checks read a replaced socket as RUNNING; the doctor now records the socket inode it sees on a healthy read in the kit state root (`rch-socket-ino.json`: `{path, ino, at}`) and compares it on later reads.
- A fresh, stale (> 7 days), moved-path, or corrupt baseline is refreshed on the next healthy read and reports RUNNING with a baseline note, never FAIL on first sight; an inode mismatch (or a missing / non-socket path against a live baseline) reports `SOCKET_UNLINKED` with the queue-gated `launchctl kickstart` restore text.
- The comparison runs on the injected `statSocket`/`lsof` fakes in `tests/cli/diagnostics.test.ts` (replaced-socket, same-ino, missing-after-baseline, first-sight-then-compare, state-file round-trip); callers without a baseline store keep the legacy path-existence behavior.
- The post-compaction reread gate (`COMPACTION_REREAD`) now reads the tracker a command actually runs in. A `br show <id> --json` clears it from the bash tool's `cwd`, after a leading `cd DIR`, or with `--db`, so a seat whose session cwd is not its tracker repo is no longer latched. An empty `br list --assignee <you>` clears it only when no other tracker the session used holds an in-progress or rework bead assigned to you; the guard checks each with its own bounded read and keeps blocking if a read fails (ompkit-xa5s.35).

## [0.2.55] - 2026-10-19

### Changed

- test(quarantine): `tests/quarantine.json` plus `scripts/test-quarantine.ts` add an expiring flaky-test quarantine after pi_agent_rust's: every entry names its test, category, owner, bead, CI evidence, repro and exit condition, and lasts at most 14 days. `check` fails on a malformed or expired entry; `run --junit FILE -- bun test ...` runs the suite once (never retrying) and fails on any unquarantined failure, an unexplained bun exit, or a stale entry, while a quarantined test still runs and is reported as QUARANTINED-FAIL/PASS. The registry starts empty.
- CI runs every `bun test` step (each core shard, package release, kit update, memory readiness and the macOS service contracts) through `scripts/test-quarantine.ts run`, once, with no retry, and checks the quarantine registry once per run; a quarantined test still runs and is reported, any other failure fails the step as before, and each step's JUnit and quarantine reports are kept as run artifacts.
- `bunfig.toml` no longer sets `[test] timeout = 120000`: Bun 1.4.3 ignores that key, so every test already ran under Bun's 5000 ms default; test timeouts are unchanged, and only the `--timeout` flag sets a longer one.

## [0.2.54] - 2026-10-19

### Added

- `omp-kit rch lease` reports dead-owner leases on the selected worker (`--plan` and `--apply`): a journaled lease whose native `wrapper_alive` is false and `owner_presence` is `absent`, that is neither terminal-acknowledged nor retired, and that either stopped heartbeating 15 minutes ago or shares its pid with a live wrapper of a different process start time appears in `deadLeases` with `outcome: "unreapable"` and a `reason` naming the missing native capability, and as `dead_leases=N reap=no_native_verb` on the `LEASE` line. It does not attempt to reap them: on a real host (rch 2.1.34) `rch jobs recover` exits 1 for these leases (`same-id remote execution has no durable completion yet`; `source-authority lock ... invalid claim record`) and rchd's own dead-client lease recovery fails identically on every retry, and `rch jobs` has only attach, cancel and recover. Slots a dead lease holds are therefore not claimed freed; the cycle refuses for capacity when they are the shortfall. Live or unknown owners, other workers' leases and this process's own pid are never reported; reporting never changes the overall result. Upstream gap: rch has no native verb that retires a dead-owner lease whose remote completion was never recorded. Seen on a real host: stale `running`/`finalize` leases held by dead wrapper pids kept pool slots for days.
- `omp-kit doctor` adds an `rch_gc_roots` finding when rch is installed: the rch config's `remediation.pooled_target.gc_extra_roots` must list `<home>/rch-build/rch-remote`, otherwise rch gc never reclaims the proof-overlay directory (84 GB reclaimable under critical worker disk, measured 2026-10-03). A config without it is `DEGRADED` `GC_ROOTS_MISSING` and the finding prints the exact line to add (existing roots kept); `~` forms, other tables and other paths do not count; an unreadable or invalid config is `UNVERIFIED`, never `OK`. Doctor edits nothing. The CLI `--scope rch` flag is not wired yet, so the finding appears in the unscoped `omp-kit doctor` run.
- `omp-kit doctor` adds an `rch_workers` finding that compares the daemon's per-worker health with a direct `rch workers probe --all` probe, run only when the daemon marks a worker degraded or unreachable. When the probe finds those workers healthy the finding is `DEGRADED` `DAEMON_PROBE_DISAGREE` with a cause (`STALE_DAEMON_HEALTH`, `DAEMON_CIRCUIT_NOT_RECOVERED` or `DAEMON_HEALTH_UNEXPLAINED`) and the documented recovery from docs/rch-lease.md (`rch status --jobs`, then the `launchctl kickstart` restart, then rerun `omp-kit doctor` to confirm the `rch` finding is `RUNNING`, i.e. the socket exists). It never recommends `rch daemon restart`, which removed the socket on a real host. When the probe agrees a worker is down the finding is `WORKERS_UNHEALTHY_CONFIRMED` and advises no daemon restart. The row is produced only when the daemon is reachable (`rch` state `RUNNING`). Not verified: that the documented kickstart keeps or recreates the socket on a live host; the post-restart recheck is how an operator confirms it.
- `omp-kit doctor --scope mission` lists every repo the fleet works in that builds through rch and whether its gate calls `omp-kit rch lease`; a repo-local lease script is a finding naming the file. The repo set is the fleet-watch registry until the Mission Protocol registry (MP6) exists.
- `omp-kit doctor --scope rch` is accepted by the scope grammar (the `rch_gc_roots` and worker-health findings already existed).
- When a session ends, the fleet-guard extension releases that session's own scratch dir (`var/agent-tmp/omp.<pid>`, `bin=throwaway`) so the reaper can delete it. A respawn is skipped through the chief skill's `respawn-intent.<oldpid>.json` marker (matching pid and process start, unexpired); a subagent's end releases nothing.
- `omp-kit scratch mine` reads the process table and the caller's session leases once per listing (it took minutes over a fleet repo's owner files, now seconds) and no longer counts a hand-made `pid=1` owner as the caller's: pid 1 heads every ancestor chain, so ten unrelated dirs were listed as mine. `scratch release` shares the same ownership check.
- `omp-kit scratch mine --at review|close|session-end` appends one `flag` row to the scratch reap log when dirs are owed, and the kit-flywheel-guard extension adds a `SCRATCH_OWED` advice (never a block) to `br update --status in_review` and `br close`, listing the caller's unreleased dirs.
- `fleet-restart`: `fleet_restart.py states` classifies every ntm and herdr omp seat against the login-shell target from the omp child's running executable (the pane shell's zsh txt is never a state): `CURRENT`, `STALE` (respawn), `NO_OMP` (shell) or `UNKNOWN_EXE`, with the chief marked `SKIP_CHIEF`. The run manifest records the herdr seats too.
- SKILL rules 17-19 from the 2026-10-14 restart: a pane already on the target build is not done until this run replaced its process or the approval named it for same-pid `/restart`; every leftover (stale seat, dead ntm mapping, skipped herdr pane, shell) is printed before any "fleet restarted" claim; old context on screen means the restart did not happen. Herdr relaunches use `send-text` then Enter, never `send-keys /exit`.
- `fleet-restart`: the advisor restore writes an fsynced `ADVISOR_INTENT` with the pre-run badge, source and WATCHDOG hashes before `/advisor on`. A run that crashes after the send resumes without resending: it reports `ADVISOR_RESTORED` when the badge comes back, else `ADVISOR_FAILED`. `report.json`/`report.md` carry per-pane advisor evidence.
- `fleet-restart`: `selftest.py` keeps its scratch in an owned repo `var/agent-tmp` TMPDIR and refuses (exit 2) without one, instead of writing under `~/.local/state`.
- Claim boundary: signing proves origin and integrity, not that the kit is safe or correct. `tests/cli/release-train.test.sh` now pins the signed-release shape: the publish job downloads each platform's SBOM and refuses a release missing one, and the attest-index job signs `release-index.json` with the workflow keyless identity. Removing either guard from the workflow turns its row red. (ompkit-rc-epic-land-fix-release-dogfood-rz5.59.3.4)
- The push-check contract test expects the realpath of the shebang interpreter that `omp-kit land` records, so it passes on usr-merged Linux runners where `/bin/bash` resolves to `/usr/bin/bash`.
- Release (dark, off by default): Developer ID signing and notarization of the macOS archive by a local signer, DEVID-SIGN-V1 (`docs/release-signing.md`). Releases ship unchanged while `scripts/release-signing.json` says `"darwin_signing": "adhoc"`. Setting it to `developer-id` (one commit; see the flip procedure in the doc) changes three things. The publisher tags but no longer dispatches tag-ref signing, and the train reports `TRAIN=awaiting-developer-id` instead of holding its lock. `scripts/sign-darwin-release.sh`, run on the maintainer's Mac, then signs the qualified darwin binary. It unlocks the dedicated signing keychain in-process (the password never reaches argv or logs, and the keychain re-locks on exit), proves the notary credentials, and selects the identity by SHA-1 (the key never leaves the keychain, and CI holds no Apple credential). It checks the qualified artifacts against GitHub's recorded digests and the publisher's own `verify-final` gate. It signs each Mach-O with hardened runtime, a secure timestamp, the identifier `ai.zeststream.omp-kit` and the Bun JIT entitlements, then notarizes, verifies and executes it. Finally it uploads the archive to a draft and dispatches signing exactly once, behind a crash-recovery receipt; `--dry-run` makes no remote write. The signing run's new `developer-id` job (macos-15) runs `scripts/devid_release.py` to prove that the draft's archive is the qualified archive plus a Developer ID signature before anything is attested. Every other member must be byte-identical, and the binary byte-identical up to its code signature. The team, runtime flag, timestamp, identifier, entitlements and Gatekeeper's `Notarized Developer ID` must all match, and the job runs the binary. Provenance and SBOM attestations, the signed-consumer journeys and the publisher then operate on the final bytes, with every existing gate unchanged.

### Changed

- Tern delivery proves a send only with a complete USER entry past the pre-send cursor in the bound session file whose earlier bytes are unchanged, whose text hashes to exactly what was sent, and which descends from the pre-send active leaf; stale, quoted, assistant/tool echo, wrong-session, rewritten, partial and other-branch entries stay unproven. A send journaled as a steering entry is reported as `PROVEN_STEERED`.
- `/goal set BODY` reaches a Tern seat exactly as written (no marker) and is OK only when a new active goal `mode_change` with objective BODY lands after the attempt; a USER echo, transport success or a progress update of an older goal is `GOAL_NOT_ADOPTED`. Other slash controls are refused (`SLASH_UNPROVABLE`) because nothing in the journal proves them.
- A Tern dispatch that fails or crashes is reported as `PENDING_CONSUME`/`SEND_AMBIGUOUS` with the attempt kept and still reconciled from the journal, instead of `NOT_DELIVERED`; the attempt record is fsynced before the effect.
- Tern sends refuse text the OMP composer would run as a command (`!`, `!!`, `$ `, `$$ `), naming the SENDGATE1 rule when the command is destructive, and refuse destructive text to a pane not proven to run OMP. The configured pane must match the observed one, and the eligibility snapshot must be the one observation hashed.
- `deliverToTernSeat` takes `untilDeliveredMs`: a seat still BUSY at the bound gets `NOT_DELIVERED` with a drop file and nothing typed. The native turn now also ends itself when Tern reports the pane busy or exited.
- The Tern native admission turn now reaches the live OMP editor: `tern ctl` strips quotes from whitespace-delimited quoted tokens, so the block id travels as byte codes, and the editor id scan matches the real `"id":` tag scoped to the editor node. Before this, every Tern send ended in the turn with nothing typed.
- test(package-release): the installed fast-proof and oversized-files tests install their candidates concurrently in `beforeAll` and run their independent CLI checks concurrently in separate pristine homes; each now takes ~2.2-2.4 s (was 4.8-5.9 s, at bun's 5000 ms limit) with every assertion kept.
- Add a launch-constraint probe for kit LaunchAgents (`tests/e2e/svcpin-launch-constraint.sh`) and its 2026-10-18 evidence. After a kit release, each kit agent loses exactly one spawn to an AMFI launch constraint pinned to the old ad-hoc cdhash, and the next spawn recovers. The probe reports INCONCLUSIVE when Background Task Management never pins its disposable label.
- The stale-worktree commit-msg hook blames each changed path once, restricted to the removed lines, instead of running a full `git blame` per removed line. A 7-row close commit on a 27 MB tracker drops from 230 s to under 3 s; verdicts are unchanged.
- The stale-worktree hook skips the blame entirely when no rule can refuse the path: a loss-free tracker export or a message with no `Bead:` trailer, on a worktree file no older than the newest commit in HEAD's history. Closing an old tracker row no longer costs a 32 s blame; a stale worktree is still blamed and refused.
- The `kit-update` job no longer strands a verified activation. After a PARTIAL apply it checks the kit's own postimages as `update --reconcile` does (stable-link target and binary sha). If they match, the receipt ends RECONCILED, every profile's plugin link is relinked through `apply plugin` with its receipt, and the service is reconciled. If they do not, the job reports `PENDING`, the receipt stays pending, and nothing is relinked. It no longer reports `UNDONE` or says "automatic undo completed" when nothing was undone.
- The job record keeps a failed postcheck's `postcheckReason` and `postcheckDetail` (failed stages, changed operator paths, first 20 failures). A failed postcheck, relink or service reconcile after a verified activation is now overall `FINDINGS` with exit 1, not `OK`.
- The job no longer passes its service cwd (HOME under launchd) as a project. Doing so made the postcheck snapshot all of `~/.omp`, `~/.agents` and `~/.claude`, which live sessions write and which exceed the snapshot's 20,000-entry cap.
- The release poll is idempotent. A `poll-V` directory left by an interrupted tick is reused only when its index and archive verify against the indexed digest; otherwise gh re-downloads it with `--clobber`. The attestation bundle is refetched by digest and replaced atomically, so a leftover file no longer fails every later tick with "already exists".
- FLEETUPG1 (ompkit-v66l.22): `omp-kit doctor --scope plugin_release` reports, per OMP profile, the linked kit plugin version against the latest published release (CURRENT, STALE, or UNKNOWN when gh is unavailable; never CURRENT then), and per running seat whether it started before its profile's link last moved (STALE on loaded). `bun src/plugin-release.ts` runs the same producer standalone.
- CIGATE1 (ompkit-v66l.27.1): the pre-push gate now runs the tests a push affects, every time, on the exact-commit export. Before, every push on this Mac ran 0 tests: each focused suite went through `omp-kit heavy --no-wait` with heavy's default disk observer, sbh reported its percentage floor (`disk low: sbh check --need 10G reports pressure`, with 108 GB free), heavy exited 75, and the gate printed `deferred to CI` and went GREEN. A suite that took longer than 25 s was deferred the same way, and any `src/` change asked for the whole `tests/cli` directory, so it always deferred. `scripts/affected-tests.ts` selects changed test files, tests whose static import graph (Bun's own parser) reaches a changed path, and tests that name a changed file. It covers bun, shell (`*.test.sh`) and python (`*_test.py`) suites. The suites run to completion under heavy at nice 10, admitted on physical bytes (SAVEFIRST1 statfs), waiting for a slot instead of skipping. Below the 10 GiB floor the gate refuses at once with `FRESH-GATE: REFUSED reason=DISK_BELOW_FLOOR need=10G ... free_bytes=...` (`scripts/gate-disk-floor.ts`).
- Every gate now ends in a typed verdict, never a bare pass: `VERDICT TESTED files=N ran=M`, `VERDICT DOCS_ONLY` when no product code changed, or `REFUSED reason=NO_AFFECTED_TESTS code=...` when product code changed and no test reaches it. A bun selection that reports no test run is refused. The 180 s budget still judges the gate's own machinery, and the affected tests' run time is reported beside it as `tests=`. Each gate appends `{commit, base, selected_files, tests_ran, rc}` to `.git/omp-kit/fresh-gate-runs.jsonl` in the pushing checkout.
- perf(harness): the `--gate-json` and `--selftest` admission cases build their isolated Git fixtures four at a time (fixture Git setup is now asynchronous) and are consumed in corpus order, so both reports are byte-identical; the gate drops from ~1.6-1.9 s to ~0.7-1.0 s and the selftest from ~1.7-1.8 s to ~0.55-0.6 s, which brings the packaged-CLI fast-proof tests (`runFastTest`, `runMatcherObservation`) from 2.5-2.9 s to 1.6-2.0 s under load 16-20, away from bun's 5000 ms limit. A planted-barrier test fails if the fixtures run serially again.
- Release workflows install the Bun pinned in `.bun-version` (1.4.3) through `bun-version-file` in every setup-bun step, as CI and OMP certification already do: release.yml (validate-tag, signed-consumers), release-train.yml (train, publish) and release-intel-probe.yml (native-probe). Before this, those five steps installed whatever Bun was latest at run time. `tests/cli/ci-bun-pin.test.ts` now covers the three release workflows.
- CI: on push and pull_request the core CLI contract suite (the 12.0 min p50 critical path; 562 s serial over 172 files on run 39185830559) runs as four parallel `bun test --shard` legs balanced by the measured per-file durations in `.github/core-test-timings.json`. `cli-contracts` stays the single summary check and now also fails unless `scripts/ci-shard-coverage.py` proves from the shards' junit reports that every core test file ran exactly once (a dropped leg, a shard-count mismatch, a duplicated file or path drift is red). Schedule and release runs keep one core leg per OS, so macOS job counts are unchanged.
- CI: the concurrency group includes the event name, so the daily scheduled run never queues behind or cancels the push run of the same `main` SHA; `resolve-omp-versions` and the `cli-contracts` summary, the two jobs without one, get a 5-minute `timeout-minutes` (both measured at 3-5 s).
- CI and OMP certification install the Bun in the new `.bun-version` (1.4.3) through `bun-version-file` in every setup-bun step, instead of whatever Bun is latest at run time; `tests/cli/ci-bun-pin.test.ts` fails on any unpinned, `latest` or inline-pinned step in those two workflows.
- OMP certification runs nightly at 06:41 UTC (and on `workflow_dispatch`, e.g. right after an OMP release) instead of hourly: hourly runs started a full certification with three macOS differential legs for every OMP release, 26 full runs in 8 days, 22 of them red.
- A `br show <id> --json` of a bead with a long description now clears the reread gate: OMP cuts long lines to 768 bytes in the tool result, so when the shown row does not parse, the guard confirms ownership with its own bounded `br show <id> --json` in the call's cwd and clears only for an owned in_progress or rework bead. A failed, timed-out or unparseable confirmation keeps the gate blocked, and plain-text `br show` is never confirmed.
- The compact-reread native harness no longer reads a write the model never issued as a guard outcome: each write step re-prompts up to 3 times, a step with no write call makes the run INCONCLUSIVE (exit 3), never PASS; the prompts and fixture AGENTS.md no longer invite the model to refuse, and the fake br row exceeds 768 bytes so a PASS requires the guard's own ownership confirmation.

### Fixed

- RCHSOCK1 (ompkit-774u.6.4): the live-unix-socket negative no longer skips silently. Its first non-author replay ran from a checkout deep enough that the fixture socket path exceeded the 103-byte sun_path limit (110 bytes) and the test printed `SKIP` and went green, so a mutant that dropped the open-path exclusion survived. The fixture dir now falls back to an `omp-*` dir under the real `$TMPDIR` and throws, never skips, when no root fits.
- RCHSOCK1 AC2 is now exercised end to end: `omp-kit scratch apply --apply --yes` over a stale dir holding a socket bound by a live listener reports `SKIP owner-released-but-open-fds-present` and leaves the bound socket connectable; the identical dir with the listener gone is quarantined (the control that proves the live socket caused the skip).
- RCHSOCK1 AC3: `docs/rch-lease.md` now carries the restore runbook for `SOCKET_UNLINKED` (queue-gated `launchctl kickstart -k gui/<uid>/com.rch.daemon`, verified by `rch status`), the state table, and the lsof limit that a path replaced by a different socket is not detectable.
- The replay's other red, `scratch.test.ts:860` (`holder_pid` null in the manual BUSY test), was an obsolete fixture planting a legacy `scratch-reaper.lock/pid` claim after 24b1c3abc6 made the keeper single-flight; it was fixed in 028c915def. It was not caused by SCRATCHBIN1 (7aa660ec4e, two days later).
- `land`'s published data schema now matches what `src/land.ts` emits: `overall` is `PUSHED`, `REFUSED` or `UNRUN` with a `check` object (`PASS`/`FAIL`/`SKIP`/`UNRUN`); a refusal before any commit carries only those, and a `PUSHED` land must carry `commit`, `candidate_sha`, `pushed_sha`, `owner`, `paths`, `base` and `convergence`.
- Exit code 77 is published as `not_run` in the CLI grammar (`land` with an unavailable repo check; `rch lease` on native refusal).
- LSP readiness honors a validated `OMP_SRC` source tree when the launcher binary has no source layout beside it (e.g. a compiled manager binary), and refuses mixed identities where both resolve differently. Binary-only launchers no longer report opaque defaults when a matching source tree is configured.
- The real-request LSP tests add the hermetic `OMP_SRC` tree only for a binary-only launcher; an npm-installed launcher with its source beside it (CI) is used as is, instead of tripping the mixed-identity refusal.

## [0.2.53] - 2026-10-19

### Added

- `omp-kit rch lease --apply` reaps dead-owner leases on the selected worker before admission: a journaled lease whose native `wrapper_alive` is false and `owner_presence` is `absent`, that is neither terminal-acknowledged nor retired, and that either stopped heartbeating 15 minutes ago or shares its pid with a live wrapper of a different process start time is recovered with the native `rch jobs recover` (no custom deleter), re-read, and reported `reaped` or `reap_failed` in `deadLeases` and as `dead_leases=N reaped=M` on the `LEASE` line, then admission re-reads worker slots. Live or unknown owners, other workers' leases and this process's own pid are never touched; a reap failure never changes the overall result; `--plan` reports the dead leases and calls no recover. Seen on a real host: stale `running`/`finalize` leases held by dead wrapper pids kept pool slots for days.
- `omp-kit scratch mine` lists the caller's own scratch dirs (unreleased, released, held, hold-expired) with their bin, read-only, and `scratch apply --json` now prints the reap gap report as `data.gapReport`.
- A session's own scratch dir (`var/agent-tmp/omp.<pid>`) now names `bin=throwaway` in its `.owner` from creation, so it is binned by declaration. Nothing is disposed at session end yet.
- Fleet guard now applies the hot-path TTL cap (default 30 min, paths in `.omp/hot-paths`) to the `am file_reservations reserve` and `am file_reservations renew` CLI route as well as the MCP tools: `--ttl` (default 3600 s) on an exclusive reserve and `--extend-seconds` / hold age on a renew are refused with a message naming the cap and the hot path. Calls without `--shared` are judged exclusive; quoted or echoed `am` text is ignored; non-hot paths are unaffected.

### Changed

- `scripts/dispatch-check.sh` compares `bv --robot-next` with the top of `br scheduler` over the same claim-admissible set (open, ready, unassigned) instead of `bv --robot-triage`, and still fails closed with `BV_TOP_MISMATCH` (exit 3) on any disagreement.

### Fixed

- The TTSR harness gate again fails when the mechanical admission guard returns a different verdict on a second call from the same cwd: every admission case now takes exactly one extra dispatch on its fixture (the one-dispatch-per-chunk-width saving is kept), and `--selftest` carries a flipping-guard plant. The determinism test covers every `scratch-is-not-a-home` row of `cases/cases.tsv`, not just one fire and one quiet case.
- `omp-kit rch lease` reports a bound wrapper whose native call failed without any recorded remote exit (an SSH transport timeout such as `RCH-E104`) as `UNREADY rch_transport_unavailable` instead of `BUILD_FAILED native_return_failed`: the build never reached a verdict. A recorded nonzero remote exit stays `BUILD_FAILED native_remote_command_failed`.
- `omp-kit doctor --scope sessions` shows each session's launch profile (`profile=<name>`, or `profile=<default>`) and names a pane launched without `--profile` in its reason, so a spawn that silently runs the default profile is visible. The code the ompkit-dodx close cited (f3516676de) reaches main with this change.
- Release packaging stamps the `--version` value into the archived `package.json` (`version` and `omp.version`), and kit-release verification refuses an archive whose `package.json` disagrees with its release manifest (`PACKAGE_VERSION_MISMATCH`). (ompkit-fp72.3)
- Doctor compares each profile's plugin lock version against the installed release manifest instead of the unstamped `package.json`, and reports `DEGRADED` with the stable code `versionMismatch` (`<lock> vs <installed>`) in both the `plugin_links` and the `effective_rules` findings. (ompkit-fp72.3)
- `omp-kit mcp test` reports `CALL_TIMEOUT` naming the bound and the `--call-timeout-ms` flag that raises it when a tool call outlives its bound, and records the bound used (`bound_ms`); a call that fails fast with an error stays `CALL_FAILED`.

## [0.2.52] - 2026-10-19

### Added

- `omp-kit rch lease` recovers a bound lease whose wrapper exited in `running`/`finalize` without a recovery record (seen on a real host after a passing `cargo check`): it runs `rch jobs recover` and re-reads the lease instead of reporting `UNREADY native_remote_completion_not_observed`. A transport timeout (`RCH-E104`) on a bound wrapper is still reported `BUILD_FAILED native_return_failed`; the lease does not yet separate it from a real build failure.
- `omp-kit rch lease` reads rch build ids as exact decimal strings. Real ids are 64-bit (about 3.0e16, above `Number.MAX_SAFE_INTEGER`), so the lease reader rejected every real build's journal row and neighbouring ids rounded onto one value; this was the cause of `build_exit=unknown`, `cleanup=unknown` and `UNREADY` on every real build in three replays.

## [0.2.51] - 2026-10-18

### Added

- The reap log records the bin on each `release` event (`unbinned` when the owner named none), so the daily scratch measurement can count releases by bin.

## [0.2.50] - 2026-10-18

### Added

- `omp-kit rch lease` corrects three classifications found in the real-machine replay: a passing remote `cargo check` whose retired, sources-released lease records exit 0 is now `COMPLETE` (execution is proven by the recorded exit code, not only `execution_started`); a native admission refusal (no bound wrapper, no execution, nonzero native exit) is `REFUSED rch_capacity_unavailable` instead of `BUILD_FAILED native_return_failed`; and a remote command that ran but whose artifact return was refused is `BUILD_FAILED artifact_return_refused` with `build_exit` from the lease.
- `omp-kit doctor --scope ownership` counts, per fleet integration point that leaves state behind a process, the persisted records, the ones with no live owner and the ones with no tracked outcome, with the oldest age. It is read-only; a class it cannot count is UNKNOWN with the reason, never zero. The registry (`src/ownership-registry.ts`) names every such point with its owner key, whether that key survives a respawn, its cancel, crash and respawn paths, its terminal outcome and the bead that owns repairing it; the census is `src/ownership-doctor.ts`. A lint (`src/ownership-lint.ts`) refuses a source file that persists its own pid without a registry entry and a seat-scoped record keyed by a pid.
- Scratch bins. A scratch directory's `.owner` may name where its content goes when its work ends: `bin` (`throwaway`, `evidence`, `promote` or `hold`), `purpose`, `bead` and `expires`. A hold needs a bead and an expiry no later than 14 days after creation; it stays `LIVE held-by-bead` past the death of its owner, and once expired it is flagged `hold-expired-unbinned` and never reaped. `omp-kit scratch release DIR --bin BIN [--ref file:PATH|bead:ID]` records the bin in the release marker; `evidence` and `promote` must name a git-tracked file in the owner's repository or a bead that `br show` finds. A record without `bin` is unbinned and still counted. See `docs/scratch-bins.md`.
- A scratch reap now reports what it found. For each dir `scratch apply` reaps or quarantines that its owner did not bin, the result carries a gap row with the agent, session, label, role, bin, class and the guard that should have stopped it (`NO GUARD: file one` when none exists), counted per agent and per class, and the same rows are written to the reap log as `gap` events. A dir released into a bin is not a gap.
- `ownedScratch` (library only for now; the `scratch mine` verb and the disposal-point flag follow) lists the caller's own scratch dirs by seat or pid with their state (unreleased, released, held, hold-expired) and bin, and never another owner's.

### Changed

- `tests/e2e/compact-reread.e2e.sh` is the committed native harness for the reread gate: an owned `omp --mode=rpc --no-extensions -e <guard>` child proves the post-compaction block, that plain-text `br show` keeps it, and that `br show <id> --json` (fake br) clears it; it reports false blocks and startup ms and exits 77 when omp is absent.

### Fixed

- Disk pressure no longer blocks saving work. The pre-push fresh gate's compile and harness steps admit on physical bytes (`omp-kit heavy --disk-observer statfs`, the 10 GiB floor), so sbh's policy floor no longer refuses a push while the disk has room. When sbh reports pressure, the gate prints one `WARN disk-pressure:` line naming sbh's free percent and pointing at waste management (ompkit-774u.15), then continues. A disk that is truly below 10 GiB free still refuses, and the gate names the step heavy refused.
- New `omp-kit heavy --disk-observer statfs|sbh|auto` overrides `load.json`'s `disk_observer` for one call. Without the flag, admission is unchanged.
- The gate's 180-second budget no longer counts time spent queued for a heavy slot behind another agent's job. Each heavy step prints `heavy admission wait: Ns`, the final line reports `queued=Ns`, and only the gate's own work is judged.
- A waiting `omp-kit heavy` job re-reads the disk settings in `load.json` on every poll, so a changed observer or floor reaches it before its deadline instead of after up to 15 minutes.

## [0.2.49] - 2026-10-18

### Added

- `omp-kit rch lease --slots N [--worker ID] [--project PATH] [--plan | --apply --yes] -- COMMAND` wraps the native `rch` build lifecycle: it observes worker capacity and disk, admits only healthy or warning workers with enough slots, refuses with a typed capacity reason otherwise, runs the command, and reports next-agent readiness, so any repo that builds on `rch` can use one admission path instead of its own lease script.
- `kit-agent-mail-guard` checks each seat's Agent Mail calls before they run, in repos that opted into the fleet (`.omp/fleet.json`). It refuses `send_message` and `reply_message` whose `sender_name` is not the seat's `AGENT_NAME` (`AM_IDENTITY_MISMATCH`), a `send_message` subject outside the `DONE`, `CLOSED`, `REWORK`, `PROGRESS`, `NO-WORK`, `REPORT`, `QUESTION`, `BLOCKED`, `APPROVAL`, `DECISION`, `HANDOFF` vocabulary (`AM_SUBJECT_VOCAB`), `ack_required: true` unless the subject starts `QUESTION`, `BLOCKED`, `APPROVAL`, `DECISION` or `HANDOFF` and names a bead id `br show` resolves (`AM_ACK_SUBJECT`, `AM_ACK_NO_BEAD`, `AM_ACK_BEAD_UNRESOLVED`, `AM_ACK_REPLY`), a body over 1,800 characters (`AM_BODY_TOO_LONG`; long evidence goes in a bead comment) and a body the `kit-no-plaintext-secret` scanner flags (`AM_BODY_SECRET`). It refuses bulk read tools (`AM_BULK_READ`) and a second `fetch_inbox` from the same seat within 60 s (`AM_INBOX_RATE`). It does not yet inject the seat's `sender_token`: no per-seat token store exists.
- `doctor --scope fleet` now verifies retained gate evidence: a DONE or close comment that cites a native full-test `result_ref` (`result_ref: {json}`) is checked against its retained log bytes and git-tracked bead pointer. A DONE that reports failures (for example `20 fail`) with no `result_ref` is `DEGRADED` `INCOMPLETE_EVIDENCE`; tampered bytes or a mail-only pointer are `FAIL`; unreadable inputs are `UNVERIFIED`; a complete citation or an unrelated no-result close is not flagged.
- `kit-flywheel-guard` refuses `br update --status blocked` on a bead with no open blocks edge to a non-closed bead, unless the bead carries the `human-gate` label backed by a `HUMAN-GATE: <effect only Joshua can perform>` comment. A closed blocker, a parent-child edge or a related edge is not a fix; an unreadable bead is refused (BLOCK_REFUSED). It also refuses a bead close that would leave a blocked bead with no open blocker, unless the same command releases it with `br update <bead> --status open` (BLOCK_RELEASE_REQUIRED). Its tracker-mutation checks (close, claim, start, blocked) also follow `sh -c`, `bash -lc`, `zsh -c` and `dash -c` strings up to three levels deep, so wrapping `br` in a shell skips none of them.
- An ownership registry and a read-only census behind the coming `omp-kit doctor --scope ownership` (the scope is not yet reachable from the CLI). The registry (`src/ownership-registry.ts`) names every fleet integration point that leaves state behind a process, with its owner key, whether that key survives a respawn, its cancel, crash and respawn paths, its terminal outcome and the bead that owns repairing it. The census (`src/ownership-doctor.ts`) counts, per point, the persisted records, the ones with no live owner and the ones with no tracked outcome; a class it cannot count is UNKNOWN with the reason, never zero. A lint (`src/ownership-lint.ts`) refuses a source file that persists its own pid without a registry entry and a seat-scoped record keyed by a pid.
- `verifyEvidenceReference` (`src/evidence-reference.ts`) checks a native full-test `result_ref` against the bytes it names instead of trusting it: the retained stdout and stderr logs (bytes and sha256), a git-tracked copy at the cited commit, an Agent Mail message id, and a git-tracked bead comment or commit message that carries the bead id, the log sha256 and that message id together. It reads only through the doctor's existing `readFile` and `git` seams. Each check reports `PASS`, `FAIL` or `UNVERIFIED` with a stable code and the source it could not read; a missing log, an unreadable repository, a producer-redacted repository path, or incomplete metadata is `UNVERIFIED` and never clean. A result is `VERIFIED` only when every check passes, and a verified failing run stays a suite `FAIL`. Integrity and retention only: it does not prove suite correctness, and it does not read the Agent Mail archive or check that the commit was pushed.
- `omp-kit land` runs repository `commit-msg` hooks and the unchanged, base-registered `.omp/push-check` against the exact publication candidate before no-force publication; it reports `PUSHED`, `REFUSED`, or `UNRUN` distinctly.

### Changed

- Route completed CI and candidate events by their canonical workflow path, not a dynamic run name, so valid qualification can reach the independently verified publisher.
- Add full-test result references for actual executed argv, observed child exit and pipe EOF, complete decoded/redacted UTF-8 stream byte counts and hashes, and source-revision build metadata when available. Existing runner status, timeout, duration, cause, privacy, signature and byte checks remain unchanged.
- Preserve complete available streams in existing owned scratch while keeping bounded public failure previews. Missing fields, interrupted capture, unknown test-count protocols and mismatched stream identities remain explicit; ladder-stage totals are never substituted for test totals.
- Name structural completeness `execution_capture_complete`: it describes the observed execution capture only, never completion of unstarted stages or authenticated retention.
- Report source-owned per-case outcomes separately from stage, gate and proof verdicts. Missing or partial case reports remain unknown; later `NOT_RUN` scopes are not counted as skipped tests.
- Follow sourced shell helpers from the selected archive in pinned, local and trusted-base ShellCheck runs. Portable script-relative source configuration enables the same analysis without changing the admitted gate; helper findings still refuse publication.
- Select exact-source packaging fixtures from the archive's expanded commit instead of assuming a checkout `HEAD`; manifest controls load the producer from that selected revision.
- Carry JSON-array stream citations through `OMP_KIT_FULL_TEST_REFERENCES`: common fields are `kind`, `stream`, `bytes`, `sha256`; git locators add `repository`, full `commit`, `path` and optional `bead`; Agent Mail locators add `project_key`, `message_id`, `attachment`. Locators must match captured redacted-stream identity but remain `CITED_UNVERIFIED`, never durable or externally authenticated; no posting or retrieval occurs.
- Keep the release manifest schema closed and unchanged: source stamps live only in already-hashed `package.json`, preserving existing strict receiver checks. Exact-source unsigned native fixtures exercise passing, named-failing and interrupted captures; these are not native-release, installed-session or overall-health proof. Independent original-acceptance review and every-agent adoption remain separate.
- Keep the runner's "child exit unconfirmed; private scratch retained" diagnostic out of the child's captured stderr: it is now the separate `supervisor_note` on the interrupted run and on the result reference, so the reported stderr bytes, hash and capture identity are exactly what the child pipe delivered. The original interruption cause, in-flight stage, `INTERRUPTED` execution, missing producer exit and nondurable citations are unchanged.
- A scratch owner is now the agent and its omp session, not a bare pid. An owner record may carry `agent=` and `session=` (both or neither; old pid-only records parse and behave as before). `omp-kit scratch plan` and the reaper keep such a directory LIVE while a process still holds that session's lease (`~/.omp/run/session-owners/<session>.lock`), even after a respawn changed the pid or the tool shell that wrote the record exited; a seat that cannot be probed is never reaped (`owner-seat-liveness-unproven`), and a dir whose seat is gone, whose pid is dead and which has no open files is reaped as before. `omp-kit scratch release` accepts a successor seat (same agent, same session, new pid) and still refuses a different agent or session. The fleet guard records the host agent name and the session id in the seat directory `var/agent-tmp/omp.<pid>/.owner` on the first tool call of a session; `createScratch` records them when the caller identity is supplied.
- `omp-kit scratch plan` and `scratch apply` now inspect every repo named in the fleet-watch configuration, not only `~/Developer/<project>/var/agent-tmp`. The scratch roots are `OMP_KIT_SCRATCH_ROOTS` alone when set; otherwise `~/Developer/*`, each `sessions[].repo`, `herdr[].repo` and `chief.repo` of `fleet-watch.json` (`OMP_KIT_FLEET_WATCH_CONFIG` or `~/.config/omp-kit/fleet-watch.json`) that has a real `var/agent-tmp`, the fleet test base and the `omp-*` temp dirs. A repo named through a symlink alias and its real path are one root. Each entry of `rootMetrics` now carries `sources`, naming where the root came from (`override`, `developer`, `fleet-watch:<session>`, `herdr:<session>`, `chief`, `fleet-test-tmp`, `temp`, `system-work`). Without a fleet-watch file, or with one that does not parse or names no usable repo, the roots are exactly the earlier list.
- Keep RCH diagnostic cache writes in a private temporary HOME/XDG tree while preserving the caller's selected configuration and daemon socket.
- Preserve caller HOME metadata when TMPDIR is nested inside it, including when RCH is unavailable, by using the validated private runtime scratch boundary.
- Integration checks now refuse extension paths escaping HOME, including symlink escapes and unresolved links, before reading or hashing extension source; profile, global and plugin extensions within HOME remain supported.
- The Agent trailer hook now refuses a commit whose message already carries an `Agent:` trailer that names someone other than the bound caller (`AGENT_TRAILER_MISMATCH`) or more than one `Agent:` trailer (`AGENT_TRAILER_AMBIGUOUS`), leaving the message and the branch untouched. A trailer that names the caller is accepted once and a missing trailer is still appended. Without `AGENT_NAME` the message is never touched and nothing is judged. The contract now drives real commits in a disposable repository through an installed `hooks.d/prepare-commit-msg` chain, including that the other chain members still run.
- Withdraw optional fleet-health release claims pending original CLI acceptance: actual health JSON must visibly report explicit, non-judged `NOT_APPLICABLE` for absent prerequisites, while present-drift and explicit missing-scope negatives remain failures. No overall-health OK claim is made. (ompkit-oq1h.5)
- Library or diagnose observations do not qualify `doctor --scope rch`. Its actual `src/commands.ts` grammar and the existing `5vph` prerequisite remain pending; no unqualified Linux RCH rider, installed-native success, or release credit is claimed. (ompkit-oq1h.5)
- Create historical qualified release tags in an isolated, main-only `release-tag` job using the admitted repository deploy key. Bind the loaded key to its public fingerprint, pin GitHub's host key, and unload and stop the private agent before signing. Only an exact new-ref acknowledgment followed by a direct SHA check may dispatch signing; existing, conflicting, concurrent-loser and unknown outcomes never confer creator ownership. Keep the already-certified source, bytes, owner/attempt checks and signed-consumer publication path unchanged (commit 208ca68).
- Reconcile qualified release work periodically through the existing single-flight train, in addition to completion events, so newly provisioned release identity and missed events need no manual recovery dispatch; scheduled checks explicitly defer while identity configuration is absent.
- Follow an already-active native publisher during release recovery instead of dispatching a duplicate signing path; unknown or foreign publisher identities remain refused (commit e3fc94c).
- Reserve every public release version, including prereleases whose tags are absent, without treating prereleases as the stable upgrade baseline.
- Grant the initial signing dispatch only to the publisher that atomically creates the exact qualified tag; duplicate publishers preserve existing tags and require signer reconciliation instead of blindly repeating a possibly acknowledged dispatch (commit 8780246).
- Retain authenticated, command-local Git reads for the already admitted private companion publisher without persisting checkout credentials or exposing the isolated SSH tag key.
- Release trains started by the 5-minute schedule fallback can now own a release allocation. Before, every scheduled train that allocated refused its own allocation and the qualification it dispatched ("allocation issuer is not this repository's exact main train run/attempt"), which stopped publication after v0.2.48.
- Release qualification no longer times out on the fast test: the harness dispatches the scratch admission guard once per case instead of once per chunk width. Every requested chunk partition must still reassemble to the exact tool arguments, and the guard's determinism on one fixture now has its own test, including a planted nondeterministic guard that must fail. Locally, `--gate-json` drops from about 2.0 s to 1.2 s with byte-identical output.
- `omp-kit test` (fast) starts the harness gate and its selftest together instead of one after the other; they run in separate private roots and their results are still read gate first, so the report is byte-identical. One fast proof drops from about 2.1 s to 1.1 s locally.
- The post-compaction reread gate now decodes OMP's native tool-result envelope (text blocks in `result.content`), treats `details.truncation.truncated` as a partial read, accepts native `br list --json` `{"issues":[]}` as no held bead, and its reminder names the `--json` commands that clear it, so successful rereads unlock the session instead of leaving it blocked until respawn.
- An empty `br list --json` now clears the reread gate only when its `--assignee` names the session's identity; a session with no host identity pins a self-declared one from its first owned `br show --json` row or empty `br list --assignee X --json`, and later compactions compare against that pin.
- The block reason of the post-compaction reread gate now names the `--json` commands that clear it (`br show <id> --json`, `br list --status in_progress --assignee <you> --json`) instead of plain `br show`, whose text output can never clear the gate; plain text stays a pinned non-clearing case.

### Fixed

- The RCHRO1 doctor tests now pass on a stock macOS runner, where `tmpdir()` is a symlinked path. They give the rch probe a canonical owned work root, so the probe runs instead of being refused.
- Public `test --full --json` now includes bounded, redacted failed-stage output beside its measured duration: up to 2,500 characters each of stdout head and tail, and 1,000 of stderr. Failed ladder-level streams are bounded too; complete redacted artifacts and passing output remain available. Native certification consumes that public failure record, and a missing stage-start marker reports unavailable output instead of mislabeling an earlier stage.
- `omp-kit scratch release DIR` now releases a scratch dir whose `.owner` was rehomed to a successor process by a respawn. It refused with `directory-owner-mismatch` because the directory name still ends in the creator's pid; the name is no longer release authority. The caller must still be the owner (its pid or a descendant, or the seat that holds the recorded session), and the release marker still pins the owner text and inode. A verified owner release is honoured at plan and apply time whatever the directory's name, so a released dir moves to quarantine instead of waiting out the 72-hour mismatch rule.
- Fleet scratch checks now leave process control, agent messaging, and tool-device routes to their native authority checks instead of treating them as cwd-relative files. Filesystem URI targets remain scratch-checked after decoding; session-local targets use the caller's actual backing root and fail closed when it is unavailable.
- `omp-kit update --plan` now reads the local archive and compares its SHA-256 with the index digest before it prints a plan. A tampered archive is refused with `ARCHIVE_DIGEST_MISMATCH` and a missing or unsafe one with `LOCAL_SOURCE_REQUIRED` or `UNSAFE_KIT_SOURCE`, instead of a green plan that echoed the index's digest unobserved. Nothing is written for a refused plan, and an intact archive plans exactly as before; apply still verifies the bytes again under its own lock.
- The fleet guard no longer refuses every redirected `git commit --only`: a redirection (`>`, `>>`, `2>`, `&>`, `<`, `2>&1`) and its target are dropped before path analysis, and the `&` of a redirection no longer splits a command segment. Quoted `>` text, an unreserved path after a redirection, and a real `&&`/`&` second command are still refused. (ompkit-xa5s.27)
- Scope fleet tool and save enforcement to the nearest repository's explicit `.omp/fleet.json` containing `{"enabled":true}`. Stock repositories, including nested repositories without their own marker, retain normal OMP behavior without fleet-tool lookups or repository scratch creation. Malformed opted-in policy fails closed instead of silently disabling enforcement.
- Replace the static `scratch-is-not-a-home` path matcher with native tool admission using actual repository index and materialized working-source facts, including clean CRLF source. Disposable unmatched inputs remain writable; canonical path/blob copies, reusable shell scripts and instruction-shaped artifacts remain refused in opted-in fleet scratch. Native edit inspection includes move destinations. Ordinary Markdown reports are not instructions merely by extension. Unknown required ownership, source or edit facts do not become synthetic quiet.
- Decode native Bash `input.command` through the existing shared command helpers and inspect compound commands and subshell groups for blanket staging. Preserve inert quoting, escaped parentheses and explicitly scoped staging; refusal messages no longer point at a personal home-directory rules file.
- Keep native TTSR registration separate from tool-admission conformance and preserve final-dispatch, chunk-invariant guard checks. Retire the old managed static matcher through the existing ownership-aware retirement markers; unmanaged rules and real profile/configuration activation remain untouched by this source change.
- Case TSV now requires exactly eight columns, ending in `reference_facts` (explicitly empty or a validated tracked-source map). Update seven-column corpora by appending the empty field; malformed headers, shifted metadata and extra columns are refused rather than treated as synthetic inputs. Shipped corpus producers and frozen-witness serializers use the same schema.
- Reuse each case's real Git fixture across its final-dispatch chunk checks, while re-reading production facts for every admission. This removes repeated setup without caching verdicts or widening matcher-test deadlines.
- External live marker proofs reuse the bundled caller-owned scratch-root validator and retain that validated root through nested execution. Missing or mismatched ownership, escaped paths, symlinks and nonprivate workspaces remain refused; explicit caller scratch never falls back to system temp.
- Differential conformance uses the same strict eight-column parser and checks every obligation in its actual enforcement domain. TTSR cases retain the independent native worker; admission cases use an independent input-derived contract reference rather than a retired rule file, expected-verdict echo or the production predicate twice. Both domains and unavailable/error outcomes are explicit.
- Correct the independent admission reference’s path grammar: prompt/packet segments apply below the owned session root, while `rules` classifies only immediate `.md` children. Keep production admission and corpus outcomes unchanged, with real-Git fixed-outcome directory, basename and suffix regressions.
- Keep stock Git repositories editable after compaction when no repository `AGENTS.md` or executable `br` is available. Require only applicable rereads; successful AGENTS-only reads clear their gate without impossible tracker commands.
- Preserve owned-bead and failed/foreign-result refusals for available local, ancestor, and explicitly configured trackers. Bound AGENTS discovery to the nearest Git repository and keep discovery errors fail-closed.
- Add a separate non-shipping stock-CI compaction control that restores both unconditional reread flags and must fail the real extension behavior suite; preserve the existing callback assertion control.
- Use an owned stock Git fixture for the registered-handler calling context instead of macOS-only `/private/tmp`, preserving the mapping and refusal assertions on Linux.
- Complete stock-plugin acceptance for the shared repository-local `.omp/fleet.json` opt-in: absent markers admit temporary writes and ordinary Git operations, leave dirty-session stops nonblocking, and create no consumer fleet scratch state. Existing opted-in enforcement remains intact.
- Exercise both missing policy-directory and missing marker-file paths with real owned temporary-file, disposable-branch and index effects. System `/tmp` targets are admission-only probes, never test writes outside owned scratch.
- Add a separate non-shipping `fleet-default-on` CI control that changes only the two absent-marker defaults, preserving explicit false and malformed-policy behavior as well as the callback and compaction controls.
- Preserve the release tag creator's native acknowledgment before requesting signing, so a later publisher can resume the same qualified cut without treating an existing tag as creation authority (commit 87cecd9). Missing creator evidence and foreign tags still refuse recovery.
- `fleet flush-pending` no longer sends Enter on a queued-message band it cannot read whole: empty, gapped, duplicate-label or inconsistently counted bands are refused, so a malformed capture can never authorize a flush.
- `omp-kit test` no longer reports `BUNDLED_RUNTIME_UNAVAILABLE` on a Mac whose first Git call is slow. The admission proof gives each Git call 2 s, and on macOS the first `/usr/bin/git` call after a boot can take longer while xcrun finds the toolchain. The fast test now runs `git --version` once, with a 60 s limit, before the proof starts. When Git is missing it reports the new blocker `GIT_UNAVAILABLE` with an install remedy (commit feced13).

## [0.2.48] - 2026-10-18

### Changed

- Allow observe witnesses with Tern-managed OMP binaries when their bytes match the manager's recorded digest and their exact-version registry source has a matching cache receipt; reject substituted launchers and inconsistent receipts.
- Release CI now feeds an actual packaged shipping-stage refusal through the source-bound candidate aggregation CLI and requires it to produce no index, without replacing any passing receipt or relaxing certification and publication checks.
- Resume the rolling release train when a main-branch rehearsal finishes, so a rehearsal that overlapped green CI cannot strand qualified production work; rehearsal artifacts still cannot authorize publication.
- Keep focused workflow-lint failures red in the pre-push gate and pass only existing `.yml`/`.yaml` inputs to actionlint; unchanged lint, source-integrity and gate budgets still apply.
- Refresh Agent Mail's generated custody hooks through `am guard install --prepush` when reinstalling the kit pre-push gate; preserve refusal to overwrite a non-chain hook.
- Editing and committing must honor current file reservations. Publishing an already-committed shared-main snapshot must instead preserve peer work and judge committed history and source integrity. Agent Mail 0.3.36 still incorrectly applies live editing reservations to publication; native generator qualification remains required. Publication alone does not certify runtime behavior or an installed upgrade.
- Measure fleet-round regex scaling with process CPU time rather than scheduler delay, retaining the fourfold growth limit, input cap and iteration count. A genuine superlinear matcher and exact-boundary negative keep the growth detector effective; runtime matching and separate wall-latency budgets are unchanged.
- Forward only caller `GH_CONFIG_DIR`, `GH_TOKEN` and `GITHUB_TOKEN` to the shared source-attestation verifier; preserve provenance checks without passing unrelated operator or provider secrets.

### Fixed

- Reconcile an already owner-authorized cut before waiting on unrelated native probes. Only a new allocation waits for the native lane; after the existing bounded wait it refreshes tags, publication and the green source, and refuses a racing active run rather than waiting repeatedly or allocating a stale version. Source, owner, attempt, signature and consumer checks are unchanged.
- Preserve an already public prerelease as a terminal publication rather than automatically recovering it into the stable lane after a demotion. Stable ancestry and Latest still exclude prereleases; unpublished drafts retain normal authenticated recovery.
- Resolve installed-template imports through explicit, digest-bound project mappings in the judged commit tree. The hook installer activates only supplied reviewed declarations; candidate drafts cannot authorize themselves, and ordinary dangling imports, missing mapped sources and undeclared destinations remain refusals. Reinstallation retains reviewed data and read-only checks report drift; existing source-only resolution stays unchanged.
- Parse actual static, type-only and literal dynamic imports with the host TypeScript compiler instead of matching quoted fixture text. Inert strings/comments/JSX/template text no longer block ordinary source commits; genuine dangling imports and parser failures still refuse. The installer admits host Node/global TypeScript before effects and preserves read-only stale-check rc3.
- Keep relocated CLI contract fixtures aligned with the bundled matcher and verified OMP source-cache format; retain the admitted installed SDK cache and caller workspace across fixture HOME isolation without relaxing launcher identity or scratch-path checks.
- Make missing-native matcher fixtures genuinely native-absent under OS containment despite real hoisted dependencies, declare Linux core containment setup, and fence baseline matcher tools without changing production dependency discovery or negative assertions.
- Select the failed stage's marked output before bounding it; long earlier passing stages can no longer crowd its verdict out of the retained head. (ompkit-fp72.63)
- Require stock Ubuntu extension tests with br, am, ntm, and tmux absent from PATH; retain native claim coverage in the tool-equipped fleet suite and provide a separate non-shipping callback assertion failure control.

## [0.2.47] - 2026-10-18

### Changed

- Publish an already source-verified release tag with `--verify-tag`, without supplying an unused historical tag-creation target that requires workflow-write permission. Keep the exact tag/source, signed-byte, native-upgrade and safe-Latest checks; no broader credential or tag replacement is used.
- Normalize attempt-named SBOM artifact members to their canonical SPDX release filenames before final publication. The publisher reuses the same signed candidate and retains all complete-asset, signature and upgrade checks; no rebuild, re-sign or tag replacement is needed.

### Fixed

- A refused native `full` run no longer hides its cause behind long stage output. The failure detail now keeps the head of a failing stage's output (up to 2,500 characters; `regex-budget` prints its verdict first and a report of hundreds of kilobytes after it, so the tail alone never named the cause) with the output's total length, a measured duration for every stage that printed a start marker including the failing one, and a `verdict: failing stage NAME after N ms` line before the JSON dump. Everything retained stays bounded (2,500 + 2,500 + 1,000 characters). (ompkit-fp72.63)
- Native certification also checks the refusal console with an owned stage that exits 1 before running the unchanged positive certification. The planted refusal cannot create or replace a passing receipt. (ompkit-fp72.63)
- An unscoped `health` or `doctor` on a fresh install without fleet tools is no longer failed by the two fleet-only rows: the packaged planning skill is judged only when you keep a local copy to drift from, and the `rch` row is included only when rch is installed. `doctor --scope kit` still reports a missing planning-skill copy as drift, and the `rch` diagnostic scope still reports `RCH_UNAVAILABLE`. (ompkit-oq1h.5)

## [0.2.46] - 2026-10-18

### Fixed

- Dispatch non-shipping Intel checks as a separate run from the verified qualification publisher. The detached consumer binds the exact native run and attempt before probing the certified archive; both OMP tracks and failure receipts remain visible without placing their runtime on the three-platform publication path. Tagless rehearsal event probing remains supported, and all shipping, signing and upgrade-consumer gates remain mandatory.
- A terminally failed tag-ref signing run no longer poisons every future source. For an owner-authorized cut whose canonical native signing run failed or timed out and is unchanged when re-read (same attempt and conclusion), recovery records the old failure (`RETAINED=signing-failed` with source, version and run), never rebuilds, re-signs or retags that source and version, and admits the newest genuinely different qualified source with a new derived version. Cancelled, in-flight, non-canonical, foreign, changed-attempt and unbound failures keep the diagnose-forward refusal.
- Service claim admission uses a nonblocking sole-writer reservation and rollback-only lock release. Passive SQLite readers no longer block ownership or cause a commit refusal after a filesystem claim; live-owner, incarnation and inode fencing remain unchanged, with no added wait, retry or relaxed single-owner assertion.
- Statfs pressure is proven natively: on a real sub-10 GiB filesystem (Linux `/dev/shm`) the real CLI defers 75 with `disk low (statfs)` and never starts the command, a healthy `sbh` still decides under `auto`, and `disk_observer: "statfs"` ignores it. A test-only `--preload` forces the statfs reading healthy to show the same command then runs, and a mutant table shows each statfs mutant (always healthy, always pressure, floor ignored, unreadable-as-healthy, sbh-only) is killed by exactly the cases that guard it. (ompkit-oq1h.1)
- A fresh install without fleet tools no longer fails `health` or reads `UNVERIFIED` in `doctor`: an unscoped inventory judges the packaged planning skill only when you keep a local copy to drift from, and includes the `rch` row only when rch is installed. `doctor --scope kit` still reports a missing planning-skill copy as drift and `doctor --scope rch` still reports `RCH_UNAVAILABLE`. (ompkit-oq1h.5)
- The `rch` reachability check finds the daemon pid on Linux (the single `rchd` process of your user; several matches stay `PID_UNKNOWN` rather than guessing) and gives restart advice that is not launchd-only. (ompkit-oq1h.5)
- `ttsr-harness --observe` reads and hashes the three large runtime bindings it reports (the native addons, the bun runtime and the OMP launcher, about 180 MB) concurrently instead of one after another. The reported digests are byte-identical, and a new test pins each one to an independent hash of the same bytes. This removes the largest controllable share of the observe command's cold-start cost; the one-second budget, the final-witness shortcut and every semantic and negative witness are unchanged.
- Signed native consumers stage the release index beside the exact candidate archive, satisfying the updater's local-source requirement without copying or rebuilding archive bytes or relaxing verification.

## [0.2.45] - 2026-10-17

### Fixed

- Release recovery no longer resumes a qualification forever when its immutable tag-ref signing run finished green with the mandatory attestation or signed-consumer jobs positively skipped. The decision requires the immutable owner allocation and the canonical native signing run (repository, tag-ref workflow, dispatch, tag source, version, train, terminal success), and reads the exact attempt's complete job snapshot fenced by an unchanged attempt before and after; an absent group, incomplete or foreign snapshot, failure, cancellation or changed attempt classifies nothing. Such a cut is retained as evidence, its tag and bytes are never moved or re-signed, and the train allocates the newest qualified source that can still be signed. That source is never reallocated; healthy in-flight, failed-signing, fully executed and unbound cuts are unchanged.
- Service launcher, receipt and notification contracts use fixture-owned OMP metadata and explicit healthy admission instead of workstation dependencies or incidental host load; a separate overload case still refuses before launcher execution. Main-push and pull-request CI now include the macOS service contract family in the required CLI result, while the complete release suite and production admission gates remain unchanged.
- A successful qualification whose publisher never started (runs dispatched with the workflow token produce no workflow_run delivery) now wakes the same independent publisher once, after a two-minute delivery grace and only when no signing run or Publish run exists. The train no longer holds the allocation lock until its deadline waiting for a delivery that cannot arrive; failed, fresh, already-delivered and already-signing qualifications dispatch nothing.
- The publisher creates the release tag through the Git Data API at the already-qualified commit instead of pushing it with `git`, because GitHub refuses a workflow-token tag push for an older commit whenever the workflow files differ from the branch tip. The tag must still equal the qualified source SHA (an existing tag at other bytes still refuses), and the tag-ref signing dispatch and every release gate are unchanged.
- Signing jobs explicitly require successful source/platform admission while surviving the intentionally skipped build ancestor on archive reuse. A required signing result rejects skipped or failed attestations and real signed consumers instead of reporting an empty signing run as green; final artifact and installer authority checks remain unchanged.

## [0.2.44] - 2026-10-17

### Added

- Public release archives now include the canonical executable receipt CLI at `scripts/receipt.py`.
- `scripts/check-suite-runtime.sh`: cli-contracts runtime guard. Times the suite command, prints `SUITE_RUNTIME_SECS=<n>`, exits 1 with `RUNTIME_REGRESSION` when elapsed meets the 20-minute budget (a run near the limit is a regression, not a pass), otherwise propagates the command's exit code. No timeout is raised. Contract: `tests/cli/suite-runtime.test.sh` (6/6). [test]

### Changed

- Add the native-first `omp-kit tern` command family, context-specific Luau bindings, source-inventory drift checks, and the native plugin sources. Forwarding, declaration coverage, and offline fixtures remain separate from native semantic and installed-fleet qualification.
- Stamp the selected release version into archived package metadata before manifest hashing, and refuse package versions that disagree with the release manifest.
- Preserve executable permission for the packaged receipt CLI through both versioned staging and standalone installation, without trusting arbitrary archive executable modes.
- Stop surviving owned descendants after their stage leader exits, before waiting indefinitely for inherited output pipes; retain captured stage evidence and the leader's exit status.
- Report invalid Tern doctor limits and endpoints as input refusals rather than native dependency unavailability.
- Keep the selected verified OMP source-cache namespace across isolated HOME changes, so standalone launchers retain the same matcher source without weakening mixed-identity refusal.
- Frame ladder verdicts on their own lines even when a bounded child report ends without a newline; retain strict ordered-stage validation.
- Run focused gate suites as literal relative paths, preventing same-named tests in unrelated checkout archives from entering the selected suite.
- Check native CASS freshness in the existing managed fleet-lessons report by comparing its index watermark with a post-status session metadata scan instead of trusting `fresh=true`.
- Require database-fingerprint binding and retain unavailable, partial and busy coverage explicitly. Report the declared lexical rebuild PID and age, with a bounded last-24-hour filenames-only ripgrep fallback.
- Preserve the read-only report path and registered intake/planning failure semantics. This source change does not rebuild indexes, activate the learning service or qualify a skill promotion.
- `doctor --scope memory` adds read-only CASS status and static LaunchAgent declarations separately from retrieval qualification; a schedule or status result never claims usable recall.
- `omp-kit doctor --scope omp` reports the PATH-selected OMP launcher, whether it is Tern- or Bun-managed, and the independently observed Tern and Bun installed versions; missing or inconsistent manager evidence remains unverified. Diagnostics do not modify either installation. (ompkit-fp72.106)
- Add stable lesson record references and append-only `CORRECTION` records. Preserve superseded advice as history; dangling targets, missing applicability and cycles remain unresolved.
- Connect currency to the managed lesson report, remediation survey and read-only `fleet-lessons` CLI. Keep parsed-row/history counts, full history and invalid-line diagnostics visible; document anchors prove file existence only.
- Retire the obsolete acceptance-in-the-body lesson through the public append path without rewriting earlier log bytes. Source-path verification is not installed-release qualification; compiled mutation and normal full-gate acceptance remain pending disk admission. (commit 5198cb1c942d3ca9f8c22a4e18e5e56a40684f1d)
- `scripts/ladder.sh --selftest-interruption <stage>` emits a real stage-start marker on stderr, then hangs on an owned sleeper, so timeout receipts prove a genuinely hung stage; existing run_stage/bridge streams and refusal/probe-tail behavior unchanged. Merges TurquoiseSummit AM56984 probe_tail/verdict hunks + 2 controls. (ompkit-fp72.34)
- Require native own-caller registration/readback before `agent-spawn-env.sh` exports an actor or installs the existing br PATH shim. Match the actual project, tmux socket/pane/process ancestry and canonical `verified-live` binding; a supplied name alone is no authority. Use `projection=$(scripts/agent-spawn-env.sh --agent NAME) && eval "$projection"` after native registration; `--project REPO` selects an explicit project instead of the current Git root.
- Confine native identity resolution with macOS's built-in sandbox: no persistent writes or network access except the actual tmux Unix socket; `/dev/null` remains available for native probe stderr. This prevents the nominally read-only AM resolver from adopting a dead alias before it reports its binding. Missing confinement, other carriers, weak or unavailable evidence refuse explicitly; no alias adoption, live rollout or authenticated cross-session handoff is claimed.
- Correct existing doctor advice to distinguish native registration from projection. Keep executable regression coverage in the existing test: `sh tests/cli/agent-spawn-env.test.sh`; with native AM/br/tmux/lsof and the supported macOS boundary, `--native` exercises the ordinary tracker comment plus actor/pane/project/lease and weak/dead cases. `--native --mutant-binding` removes only the binding guard in memory and must fail the same weak/dead consumer assertions without changing source or identities.
- `omp-kit land` reports candidate construction, remote publication, and local catch-up separately as applied, not applied, or unknown, so interrupted or ambiguous runs do not become false no-effect or retry claims. (ompkit-rhy9.11)
- Unscoped inventory (status, health, doctor, repair, test) never executes the OMP launcher; the launcher-version cross-check runs only under explicit `doctor --scope omp`, with the launcher check reported NOT_RUN otherwise. (ompkit-v66l.8)
- Restrict save reminders to current byte-attributed writes on freshly checked native open beads, keep whole-file saves separate by bead, route foreign reservations and later-writer omissions without commit demands, report upstream-retired files as archive-or-drop, and name cached CI blockers without authorizing publication. (commit 06ab9ee)
- Restore native bead attribution from complete tracker pagination envelopes as well as older array responses; incomplete, shifted, inconsistent, or ambiguous pages never authorize a save.
- Save recipes use literal Git pathspecs for both exact-path add and per-bead commit, introducing only eligible untracked files without adding tracked or foreign paths.
- Fleet Watch now refuses tracker recovery when the one-family artifact bound is met, reports `WAL_QUARANTINE_GROWTH`, and leaves artifacts for safe cleanup; beads_rust#532 remains unconfirmed.

### Fixed

- Fetch required Sigstore bundles during online installation and document the offline bundle and verifier requirements.
- Supply controlled attestation inputs to installer tamper regressions so digest, manifest and member-type checks run without weakening authority refusal.
- Fetch digest-bound attestation sidecars when polling published kit updates, before strict planning and activation.
- Keep plugin relink and undo regression fixtures independent of the installed OMP environment and preserve real receipt values across matcher assertions.
- The shared tracker policy template admits present, unchecked acceptance criteria into independent review, while requiring completed criteria at closure. Reviewer gates, author self-close refusal and bypass prohibition remain intact. Live tracker policy adoption remains a separate authorized operation.
- An interrupted push gate no longer loses its failure log: on SIGINT/SIGTERM the gate marks the run red before cleanup, shuts down its owned pipeline children (TERM-only), removes the extract tree, and keeps exactly `.owner` plus `gate.log` naming the dead gate pid, with exit 130/143. Contract: new `term-interrupt-keeps-log-not-tree` case in `tests/cli/pre-push-gate.test.sh` (28/28 under sh and dash). [test]
- Keep the updater's unavailable-authority regression isolated from installed GitHub CLI binaries and credential helpers; retain fail-closed activation, receipt and stable-link checks.
- Make compiled health regression fixtures report a consistent Tern-managed OMP identity, so healthy-install and unsafe-state-root checks exercise their intended outcomes without changing health precedence.
- Stale Git index-lock handling is dry-run-only: only `dryRun: true` reports `WOULD_MOVE`; omitted, false, null, or other values return `APPLY_REFUSED` before filesystem access. `scratch index-lock --apply` is always refused because the pathname check cannot prove writer quiescence.
- Release scheduling no longer treats an unpublished tag as a global lock or as the source-history floor. Tags reserve version numbers without being deleted or reused; published ancestors bound source selection and release notes, while authenticated native qualification runs control recovery. An unrelated higher tag cannot hide an in-flight candidate. Active or unresolved native runs still prevent competing allocation, and source qualification, artifact authority, signing and publication gates remain mandatory.
- Recovery and promotion use published main-ancestor outcomes rather than off-main or unpublished tag reservations. Latest selection uses stable GitHub publications, so abandoned tags cannot suppress an otherwise eligible release and a genuine newer publication still cannot be displaced by older recovery.
- Published versions remain reserved even when their Git tag is missing, so an absent old ref cannot block native recovery or cause version-number reuse.
- Heavy disk admission works without sbh: OS-native statfs default on the cwd with sbh as an auto-detected adapter; CI no longer installs sbh and asserts its absence. (ompkit-oq1h.1)
- Statfs verdict is a pure injected-boundary decision (no environment seam); unit matrix covers it hermetically.
- Native candidate qualification now stages validated archive bytes in its owning workflow's private temporary tree instead of calling the published installer before tag/signing. Receipt readers bind staging to the current workflow run and keep public installation explicitly unverified; published installation still requires genuine provenance before extraction or activation.
- Updater relink qualification uses a canonical temporary fixture root so macOS temporary-directory aliases do not produce a false plugin-relink failure.
- G4 live checks use the selected packaged executable in private staging; published stable-link activation remains a signed-install/upgrade check.
- Automatic releases select the newest actually qualified main source instead of discarding green snapshots whenever main advances. The active train retains its version through certification and publication; final-version archives certify before tagging and are signed at the tag ref without rebuilding. Source-bound notes, both pinned OMP tracks, all three shipping platforms, artifact hashes and existing Sigstore authority remain mandatory.
- Release allocation is authenticated by immutable owning-run artifacts and the native qualification ID, including explicit same-run retry policy and complete attempt-bound artifact snapshots. Existing releases are verified and repaired only with missing exact certified assets; an index-only match is not publication success. Optional Intel probes follow the selected source independently of the workflow execution head.
- Execution-code trust now checks owner and qualification SHAs against the actual full main branch, including shallow-checkout recovery, rather than trusting a branch label that can also name a tag. Acknowledged dispatch identity is persisted before eventual metadata reads, terminal unbound failures cannot poison future trains, and published versions missing from the tag floor cannot be reused.
- ShellCheck follows repository-owned CLI test helpers in read-only archives, retaining helper diagnostics instead of suppressing the source-following warning that blocked publication.
- Memory-readiness selftests resolve version-matched source for standalone Tern OMP binaries and exercise hash-pinned fixture source without treating it as installed runtime-health evidence.
- Release-note coverage recognizes source-owned direct-commit notes already folded into versioned changelog sections, without borrowing notes from newer main or waiving missing provenance. Uncovered direct commits are reported together rather than blocking the train one historical commit at a time.
- Push hooks and main-push CI share the release-note checker instead of maintaining a second shell interpretation. Missing push bases fall back to published source ancestors, never an unpublished numeric tag; a later publication cannot move the notes floor past the immutable source being checked.
- Tagless qualification stages the exact source/run-bound archive without claiming published installation. After signing, all three native shipping platforms must prove public installation and a compiled upgrade from a genuine published release before publication or asset recovery; public signature checks stay mandatory and certified archives are not rebuilt.
- Pre-tag admission compares the selected source's signing workflow, CI, release controller, native staging producer and signed-upgrade runner with the admitted main inputs. Stale signing code cannot borrow an unchanged protocol label; no manually bumped signer label is needed to admit the next green source.
- A refused native full qualification now keeps the failing stage's bounded producer stdout and stderr tails in its receipt, so a failed ladder stage names its own cause instead of only the stage and missing scenarios. Passing results add nothing.
- Release-train bump commits now name the release-train bead without changing their subject or release-evidence inheritance. The generated commit is checked by the canonical bead-existence hook; source-changing and extra-package-field bumps remain refused evidence inheritance.

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
