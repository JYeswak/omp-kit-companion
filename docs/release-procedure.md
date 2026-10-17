# Release procedure

How any fleet repo cuts a versioned release (PUB1c). The companion repo is
the reference implementation; uds adopts this same procedure next.

## 1. Fragments, every commit

`CHANGELOG.md` has the upstream oh-my-pi shape (can1357/oh-my-pi AGENTS.md
"Changelog"): `## [Unreleased]`, then `## [X.Y.Z] - YYYY-MM-DD` sections with
`### Breaking Changes|Added|Changed|Fixed|Removed` buckets, one user-facing line
per entry; released sections are immutable. Notes reach `[Unreleased]` through
`changelog.d/<bead>.md` fragments (bullets, optional first line
`### Category`, default Changed), so concurrent agents never edit one file.

Each change ships with a fragment, or a `[no-changelog]` reason in the commit
message. The release workflow enforces it:

```sh
sh scripts/release-notes.sh check --base-tag vX.Y.Z --head REF
```

A commit touching shipped paths without coverage fails the check. The pre-push gate
(`scripts/check-pushed-notes.sh` via `fresh-gate.sh`) calls this same checker with
`--base-ref` for its exact pushed range; it does not maintain a second parser.
A fragment folded into source-owned `CHANGELOG.md` entries still covers its commit.

When a remote push base is absent, the gate checks from the newest available stable
published ancestor of the immutable source. Main-push CI checks the full unreleased
range from that published ancestor before it can become green. Both use the release
controller's published-ancestor selection: draft, prerelease, unpublished reservation
tags and publications after the checked source cannot narrow its coverage. A missing
published floor or unavailable metadata refuses validation; neither silently skips it.

## 2. Optional changelog bookkeeping (not a release prerequisite)

```sh
sh scripts/release-notes.sh fold            # preview: fragments -> [Unreleased]; --write applies
sh scripts/release-train.sh bump --version X.Y.Z --date YYYY-MM-DD
```

`bump` runs `release-notes.sh promote --write` (fold, rename `[Unreleased]` to
`## [X.Y.Z] - DATE`, open a fresh `[Unreleased]`, set package.json `version` and
`omp.version`) and commits `chore: bump version to X.Y.Z`, the upstream
`scripts/release.ts` commit. With no entries and no fragments it refuses
(exit 4): there is nothing to release and no empty release body is ever cut.
`release-notes.sh notes --version X.Y.Z [--floor X.Y.Z]` prints the GitHub
release body from the CHANGELOG section(s), like upstream
`scripts/ci-release-notes.ts`, and refuses an absent or empty section.

These are explicit repository-maintenance commands, not the automatic train's
preparation step. The train never rewrites main or manufactures a bump on an
older green source. It selects immutable source `Q`, assigns artifact version
`V`, and renders only new notes since the preceding published ancestor:

```sh
sh scripts/release-notes.sh source --base-tag vPREVIOUS --head SOURCE_SHA --version X.Y.Z --output NOTES_PATH
```

The release manifest is authoritative for the installed version; source
`package.json` need not equal the selected artifact version. An unchanged
executable hash does not imply a misversioned archive.

## 3. Qualified semver promotion (manual fallback uses the same gates)

Tags are `vX.Y.Z` on the exact qualified source, created only after the final
version's three-platform/both-OMP-track candidate is successful and its archive
hashes and source-bound nonempty notes verify. Do not manually tag an uncertified
source. For an intentional cut when automatic triggering is unavailable:

```sh
gh workflow run release-train.yml --ref main -f sha=SOURCE_SHA -f version=X.Y.Z
```

The controller verifies actual main push CI and the ancestry-selected qualified
frontier; this is not an override for red/running/older sources. Version overrides
must meet the remote tag and changelog floor. Repository history stays shared
and unchanged; no branch rewind, side-history push or main freeze is needed.

### 3a. Rehearse before spending the version

A tag cannot be rebound. Rehearse before an intentional cut, without spending
its real version:

```sh
gh workflow run release.yml --ref main -f version=X.Y.Z -f rehearsal=true
```

The rehearsal runs changelog coverage, full native candidate certification,
platform validation and SBOM generation on `X.Y.Z-rehearsal.RUN.ATTEMPT`.
It refuses spent versions, creates no tag/release, and performs no signing.
It is not publication proof and cannot be relabeled as final-version evidence.
Production qualification uses final `V` from the start. A post-certification
signing/publication failure recovers from that same successful candidate run
(`candidate_run_id` on the train); it never rebuilds archives or moves a tag.

## 4. Build platform archives with sha256

```sh
sh scripts/package-release.sh --version X.Y.Z --platform darwin-arm64-none --out ABSOLUTE_DIR
```

Repeat per platform. `release-index.json` lists every archive with its
sha256; the installer (`installer/install.sh --version X.Y.Z --index URL
--prefix DIR`) verifies the hash before installing and refuses on mismatch.
Release candidate indexes contain exactly `darwin-arm64-none`, `linux-arm64-gnu`,
and `linux-x64-gnu`. `darwin-x64-none` is a non-shipping CI probe and is
excluded from published indexes and attestations. Release runs certify it
after the candidate (`intel-probe` in release.yml): reported, never gating, and
holding no macOS slot while the ship targets certify. Release-mode candidate
generation requires both minimum and certified OMP receipts for all three
ship targets; a missing or refused ship receipt blocks attestation.

## 5. Signing (delegated)

The existing release workflow signs the archives, SBOM and release index.
Qualification first produces final-version bytes without a tag. After the
promotion gate creates `vV -> Q`, the same workflow runs at that tag with
`certified_run_id`, downloads and verifies the qualified archives, and signs
them without rebuilding. The source installer/updater policy requires the GitHub
Actions OIDC issuer, exact `release.yml` signer and source digest `Q` fences.
Checking out `Q` in a workflow executing at newer main `H` is not sufficient
signing identity. Source policy is not proof that a fleet installation has adopted it.

## 6. Publish and install-check

Publish the GitHub release from the tag, then install from the published
index on a machine that did not build it (fresh HOME where possible).

### Pending update receipts

If an update ends PARTIAL on a false postcheck while the new release is in
fact active, later updates refuse with PENDING_RECOVERY and no command
clears it. Inspect `omp-kit audit --json` and both component postimages,
then run `omp-kit update --reconcile RECEIPT --yes`: it rescans the active
kit symlink, release bytes and the receipt's recorded postimages and marks
the receipt RECONCILED only when all three match, recording what was
verified. The install prefix is derived from the receipt postimage itself,
never from the running binary (which predates the command on a stuck
machine); pass an explicit `--prefix PATH` only to point at a relocated
install, and it is validated the same way, by matching. A mismatch refuses
and the receipt stays pending; undo or a real
fix is the way out, never a forced install.

## 7. Release train (RELTRAIN1, automatic; manual cut is the fallback)

Each CI main push completion wakes the existing controller. It reconciles
the newest qualified source by main ancestry, not the event's order or current
branch head. A red/running descendant does not invalidate an eligible green
ancestor; an actually newer green supersedes pending older sources.

- The `release-train-active` **job** lock is held from selection/version allocation
  through candidate certification, tag-ref signing and publication outcome.
  New commits never cancel an active release. The next admitted train re-reads
  qualification after waiting; three queued greens collapse to the newest.
- The publisher uses its own `release-train-publish` job group. There is no shared
  workflow-level concurrency group that could suppress publication or deadlock
  against the waiting train.
- Qualified source `Q` is in main history and has real completed successful push
  CI from `ci.yml`; OMP-certification, schedules, failed/cancelled/latest-running
  attempts and fabricated manual verdicts do not qualify it.
- Final artifact version `V` is allocated above stable tag reservations,
  actual stable GitHub publications and changelog floors. The changelog floor
  comes from the immutable fetched admission-main SHA
  (`next-version --changelog-ref`), not a stale controller checkout. A missing
  tag cannot make an already-published version reusable or globally block
  native recovery. No main bookkeeping bump is required. Empty source-range notes skip
  before dispatch. The owning train first uploads immutable `release-allocation-N`
  (native owner run/attempt, `Q,V`, notes floor/digest and retry policy), then uses
  the native dispatch response to upload `release-qualification-N` binding the
  exact qualification run ID. That acknowledged ID is atomically persisted
  before observer-state writes or eventual child metadata reads; binding upload
  runs even after a later dispatch-step failure. Code identity is independently
  resolved from the bound native run, with a bounded read-availability window.
  Qualification cannot authorize itself with inputs, a title or an unrelated
  active train. Promotion reloads owner authority after the original owner ends.
- `release.yml` first qualifies exact `Q,V`. Promotion verifies producer
  repository/workflow/ref/attempt, all three ship targets, both pinned OMP tracks,
  archive hashes and notes before tagging. A second, tag-ref run signs **those
  same bytes**, and publication verifies real Sigstore authority before creating
  the release. A recovered older release cannot take Latest from a newer
  published version; an unrelated unpublished tag is not a publication outcome.
- Non-superseded successful unfinished candidates are resumed rather than allocating their
  untagged in-flight version again. Failed exact-source qualification requires
  diagnosis forward, not an automatic rerun or a weakened gate. Unpublished tags
  reserve their version numbers without locking the scheduler or hiding an
  authenticated in-flight candidate. Native active or unresolved runs prevent
  competing allocation; eligible source history and notes use a published
  ancestor floor, not the highest unpublished tag. No tag is deleted or reused.
- Same-repository workflow names and `head_branch=main` are not code trust: a tag
  can also be named main. Shared authority validation fetches literal
  `refs/heads/main` from the expected repository into a dedicated full ref,
  completes shallow history, then proves both owner and qualification execution
  SHAs (and selected `Q`) are ancestors of that actual main tip. Historical
  main code remains valid; neither caller main SHAs nor caller-controlled origin
  or ambiguous short-main lookup can grant authority.
- A native-confirmed failed/canceled terminal run with no binding is not signing
  authority and cannot poison a new allocation. Inflight, successful-unbound,
  or unknown states stay conservative; lost authority is never reconstructed
  from a candidate's own selection or title.
- Explicit `same-native-run` retry authorization preserves the immutable dispatch
  inputs and execution head; it never authorizes a second qualification run ID.
  Every accepted latest successful attempt needs a complete unique artifact
  snapshot: attempt-qualified names, native producer IDs and creation timestamps
  within the actual native attempt. Missing/mixed attribution or a newer
  running/failed attempt refuses. Signing still copies certified bytes, not builds.
- Publication creates a draft until all mandatory archive/SBOM/index assets and
  Sigstore authority verify. An existing matching index alone is not completion.
  Existing required assets must all match before repair; only missing exact
  certified bytes may be uploaded, without clobbering. Upload races are re-read
  and verified. The train waits for the exact native publisher run's success,
  not merely for a version to appear in the release list.
- The optional Intel consumer reads bound source `Q` separately from execution
  head `H`, checks its exact producer attempt, and remains non-shipping evidence.
- Bootstrap requires the first green descendant containing `ROLLING-RELEASE-V2`;
  older historical workflow definitions cannot safely consume the signing-only
  protocol. They are not rebuilt or granted relaxed signer authority.

This correctness cutover removes starvation and the duplicate full bump/candidate
build. It does not claim instantaneous publication or alter native certification,
installer authority, rollback, or the original measured acceptance criteria.

The native handoff uses the documented
[workflow dispatch REST contract](https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10#create-a-workflow-dispatch-event)
with `X-GitHub-Api-Version: 2026-03-10`, a `ref` and `inputs`. HTTP 200 must return
`workflow_run_id`, `run_url` and `html_url`; HTTP 204, missing/duplicate/malformed
identity fields or inconsistent URLs refuse. There is no run-title/nonce fallback.
Owner artifacts are immutable and expire under their retention policy; missing
authority is an explicit repair prerequisite, never reconstructed from candidate claims.

Install on publish (existing `kit-update` service, no new daemon):

- With `OMP_KIT_UPDATE_ENABLED=1`, `OMP_KIT_UPDATE_POLL=github` and
  `OMP_KIT_UPDATE_REPO=owner/repo`, each service tick fetches the newest
  published release; only a version newer than the live install is
  downloaded (index plus platform archive into one private directory)
  and applied under the existing update receipt and reconcile path
  (`src/kit-update-job.ts`, covered by `tests/cli/kit-update-job.test.ts`).
- After an update the service relinks the kit plugin package with the new
  binary itself (`apply plugin --apply`) and reports one line. A failed
  postcheck leaves the prior version active and reports the undo; a
  failed relink keeps the good update and reports BLOCKED with the
  receipt. The service ticks every 300 s, so a published release lands
  within minutes.

Budgets remain acceptance targets, not source-level claims: two natural green
pushes must publish without a human command, commit-to-published must be measured
under 20 minutes, and the actual Mac update/plugin receipt must arrive within
10 minutes with the prior version preserved on failed postcheck. Local fixture
success is neither a deployed train outcome nor installed-fleet proof.
