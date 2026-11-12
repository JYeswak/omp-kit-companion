---
status: current
---

# Release signing: Developer ID on a local signer (DEVID-SIGN-V1)

Bead `ompkit-v66l.27.4` (DEVIDSIGN1); decision J-2026-10-18-23: Developer ID signing on a
local signer on the maintainer's Mac, the dsr/sbh pattern, so the signing key never leaves
the keychain.

## Why

Until this protocol, the macOS binary in each release was ad hoc and linker-signed by the
Bun compiler. Measured on v0.2.52 `bin/omp-kit`: `Identifier=a.out`, `flags=0x20002(adhoc,linker-signed)`,
`TeamIdentifier=not set`. Every release therefore changed the cdhash that launchd pins
for each kit agent, and the first spawn after an activation was killed (SVCPIN1,
`docs/evidence/svcpin-launch-constraint-20261019.md`). Gatekeeper also treats the binary
as unidentified. A Developer ID signature with a stable identifier and team turns the
launch requirement into "this team, this identifier", which survives a release.

The 2026-10-19 spike (omp-kit `var/agent-tmp/devid-spike.1532`) signed a copy of 0.2.51
with `Developer ID Application: Joshua Nowak (XGL9CXRCT5)`, `--options runtime --timestamp`
and the Bun JIT entitlements in `packaging/macos/omp-kit.entitlements.plist`. The binary
executed with rc 0, and notarization was Accepted in 55 s.

## What changes, in one sentence

CI still builds, tests, qualifies and tags exactly as before. Between tagging and the
tag-ref signing run, a local signer replaces the darwin archive with a Developer ID
signed and notarized derivation of the qualified bytes. The signing run proves that
derivation before it attests anything, then attests and installs the final bytes, and
the existing publisher finalizes the draft.

## The switch (dark launch)

`scripts/release-signing.json` sets `darwin_signing` to `adhoc` (the shipped default) or
`developer-id`. Every stage reads it from the cut's own source commit: `tag-qualified`,
`recover-tag-creation`, the train's watch, the signer, and `release.yml`'s `validate-tag`
(output `developer_id`). A source without the file is `adhoc`. The file is also one of the
train's signer inputs, so a source is only allocated when its mode equals main's. In
`adhoc`, the run graph is today's: no `developer-id` job (it is skipped, and
`signing-complete` requires exactly that), `darwin_sha256` must be empty, and attestation
reads the qualified candidate and index from the same artifacts as before.

### Flip procedure (one commit)

Preconditions: (i) a release has published through the `adhoc` path since this switch
landed; (ii) `scripts/sign-darwin-release.sh --dry-run` completed end to end on the signing
Mac, including notarization.

1. Change `"darwin_signing": "adhoc"` to `"developer-id"` in `scripts/release-signing.json`
   and commit only that file (`Bead: ompkit-v66l.27.4`), then publish it.
2. The train allocates the flip commit (or a later source) as the next cut. After
   `tag-qualified` logs `SIGNING=awaiting-developer-id`, run
   `scripts/sign-darwin-release.sh` on the signing Mac.
3. Watch the signing run (`developer-id`, `attest`, `signed-consumers`, `signing-complete`)
   and the publisher. Then check the installed binary: `codesign -dv` must show
   `TeamIdentifier=XGL9CXRCT5` and `flags=0x10000(runtime)`.

Rollback is the same one-line change back to `adhoc`. A cut that is already tagged keeps
the mode its source declared. Once Developer ID releases are proven, a follow-up removes
the `adhoc` darwin path, so the dual path is not permanent.

## Pipeline (developer-id mode)

1. **Qualify (unchanged).** The train allocates a version; `release.yml` `qualify`
   builds and certifies the unsigned archives on every shipping platform.
2. **Tag (changed only in what it dispatches).** The publisher's `tag-qualified` job
   creates `v<V>` as before, then skips the signing dispatch and logs
   `SIGNING=awaiting-developer-id`. `recover-tag-creation` follows the same rule. The
   train's watch returns `TRAIN=awaiting-developer-id` (exit 0) instead of holding the
   release lock while the signer is offline. The next train tick resumes the same pending
   cut; it never allocates past it.
3. **Local signer (new), `scripts/sign-darwin-release.sh`, on the maintainer's Mac:**
   1. Preflight, before anything is downloaded or signed: macOS tools present. The
      dedicated signing keychain (`uds-signing.keychain-db`, the one the uds lane uses) is
      unlocked in-process from the uds lane's password file through Security.framework
      (`devid_release.py keychain-unlock`). The password never reaches argv, stdout or a
      log, and an EXIT trap re-locks the keychain on every exit path. The codesigning
      identity is selected by SHA-1 from that keychain and must name
      `Developer ID Application: Joshua Nowak (XGL9CXRCT5)`. Its certificate must not have
      expired (a warning fires inside 30 days, as sbh does). Notary credentials are proven
      with `xcrun notarytool history --keychain-profile <profile> --keychain <keychain>`.
   2. Select the cut: the newest successful `qualify` run whose tag exists at its source,
      whose source declares `developer-id`, and that has no signing run. `--version`
      selects one explicitly. Git authority reads come from a blobless mirror of `main`
      under the state directory, because the shared checkout can be shallow.
   3. Fetch the qualified darwin candidate, the candidate index and the release
      selection from the qualification run. Each artifact zip must hash to the digest
      GitHub recorded at upload. `release_reuse.py verify-final --phase qualify` (the
      same gate the publisher ran before it tagged) binds the index to the native
      receipts, and `verify-archive` binds the archive to the index.
   4. `scripts/devid_release.py prepare` validates the archive with the installer's own
      parser (`installer/install.py`) and extracts every Mach-O member. Each one must have
      a pinned identifier (`bin/omp-kit` is `ai.zeststream.omp-kit`); an unknown Mach-O is
      refused.
   5. Sign each Mach-O: `codesign --force --sign <SHA-1> --options runtime --timestamp
      --identifier <id> --entitlements <plist from the source tag>`.
   6. Notarize: `xcrun notarytool submit --keychain-profile <profile> --wait`; the status
      must be `Accepted`. A bare Mach-O cannot be stapled; Gatekeeper finds the ticket
      online by cdhash.
   7. `devid_release.py repack` rebuilds the archive byte-for-byte except the signed
      Mach-O members and `release-manifest.json`, and writes the final index (only the
      darwin `sha256` and `manifest_sha256` change).
   8. `devid_release.py verify --execute`, the same verifier CI runs (below), on the
      result. It also executes `bin/omp-kit --version` in an isolated HOME: it must exit 0
      and print `omp-kit <V>`; 137 is reported as a kill.
   9. Draft: create the draft release `v<V>` with the selection's notes if none exists,
      and upload the signed archive under its final file name. An existing asset of that
      name must be byte-identical; nothing is ever clobbered.
   10. Dispatch the tag-ref signing run with `darwin_sha256=<signed archive digest>`.
       A crash-recovery receipt is written before the POST. The dispatch is refused if
       any signing run for the cut already exists, or if an earlier receipt has no
       recorded run.

   `--dry-run` runs steps 1–8, including notarization, then prints the remote effects
   it would have made. It makes no draft, upload or dispatch.
4. **Tag-ref signing run (`release.yml` `sign`, extended).** A new `developer-id` job
   (macos-15) re-downloads the qualified darwin archive and index from the certified
   qualification run and the signer's asset from the draft, and requires the asset's
   SHA-256 to equal `darwin_sha256`. It then runs `devid_release.py verify --execute`:
   - the qualified archive verifies against the qualified index (installer parser);
   - the final index equals the qualified index except the darwin digests;
   - the signed archive verifies against the final index (installer parser);
   - member list, order and USTAR headers are identical except the size and checksum of
     the Mach-O members and the manifest; every other file is byte-identical, and the
     manifest changes only the Mach-O digests;
   - each Mach-O's bytes before its code signature are identical to the qualified
     binary's. Only the `__LINKEDIT` size fields and the `LC_CODE_SIGNATURE` size may
     differ; the signature must end the file;
   - `codesign --verify --strict`; `TeamIdentifier=XGL9CXRCT5`; the leaf authority;
     `flags` include `runtime`; a secure `Timestamp`; the pinned identifier; entitlements
     equal to the source's plist;
   - Gatekeeper: `spctl --assess --type open --context context:primary-signature` must
     report `source=Notarized Developer ID`. (`--type execute` does not apply: it
     rejects every bare Mach-O as "does not seem to be an app", including notarized
     ones);
   - `bin/omp-kit --version` on a clean runner exits 0 and prints `omp-kit <V>`.

   Only then do `attest-platforms`, `attest` and `attest-index` take the final darwin
   bytes and the final index. They attest SLSA provenance and the SBOM over the final
   digests, so the installer's and updater's unchanged `gh attestation verify
   --signer-workflow .../release.yml` accepts them. The mandatory `signed-consumers`
   journey (public installer plus compiled upgrade) then runs on the final bytes, and
   `signing-complete` requires `developer-id` as well.
5. **Publish (unchanged).** The publisher's `verify-final --phase sign` and
   `repair-release` check every asset against the signed index and its attestations. The
   signer's draft asset verifies byte-for-byte; the missing assets are uploaded and the
   draft is un-drafted.

Nothing is public until step 5. A failure in the local signer leaves at most a draft,
which is invisible to the installer, `releases/latest` and `gh release list` for anyone
without push access. A failed signing run is terminal for its cut, as before.

## Trust boundaries

- **The key never leaves the keychain.** Nothing exports it, and CI holds no Apple
  credential: no certificate, p12, password or App Store Connect key. Notary
  authentication uses the profile `omp-kit-notary`, stored in the signing keychain itself
  (override with `OMP_KIT_NOTARY_PROFILE`), so it works while the screen is locked. The identity is selected by SHA-1
  (`OMP_KIT_DEVID_SHA1`, discovered when unset) and must name the expected certificate.
- **CI never trusts the signer's bytes.** The signer uploads with the maintainer's own
  GitHub credentials, so the attestation would be worthless if CI attested whatever was
  uploaded. CI proves that the archive is the qualified archive plus a valid signature
  by this team before it attests. A forged or tampered upload fails `developer-id`, and
  nothing is attested or published.
- The `developer-id` job holds `contents: write` only because a read-only token cannot
  see draft releases. It downloads and never writes.

## Why dsr does not host the signing step

The dsr rule is to use the substrate before hand-rolling; it was checked against the
installed dsr v0.2.3 (`~/.local/share/dsr-v0.2.3`):
- dsr has no Apple code-signing or notarization step: `codesign` and `notarytool` appear
  nowhere in `dsr` or `src/`. sbh does it in its own repository script after
  `dsr build` (`storage_ballast_helper/scripts/dsr_release.sh`, `step_sign` and
  `step_notarize`); this repository follows that pattern.
- `dsr build` cannot build this repository today: `~/.config/dsr/hosts.yaml` is still
  the upstream template, and `repos.d/omp-kit-companion.yaml` forbids publishing a dsr
  build without native-candidate receipts. Our archives come from the qualified CI run
  instead.
- `dsr release finalize` finalizes only a draft that dsr created itself, from its private
  POST-response receipt, against its own manifest and minisign inventory. `dsr release
  verify --fix` re-uploads from dsr's artifact directory. Our draft's asset inventory is
  defined by the Sigstore-attested `release-index.json`, and publication must stay behind
  `repair-release`'s attestation checks. Two finalizers would mean two authorities for
  the same release.

What is adopted from dsr: draft → verify → finalize (the signer drafts, `developer-id`
and `signed-consumers` verify, the publisher finalizes), and a crash-recovery receipt for
the one non-idempotent effect, the signing dispatch, so a lost POST response is never
replayed. The fail-closed Sigstore attestation stays: it is stronger than ntm's
`continue-on-error` attestation.

## Tags with no release (v0.2.45, v0.2.47)

Those tags exist because their tag-ref signing run failed after the tag was created.
This protocol narrows that window but does not close it. The tag still precedes signing,
and a failed signing run is still terminal for its cut. What it does change: nothing is
attested until the signed derivation verifies, the signer runs the same verifier locally
before it dispatches, and the signer's draft stays private, so a failure leaves a draft
rather than a public partial release. Making a tag without a release impossible needs a
sweeper that finishes or supersedes every `v*` tag newer than the last release
(CIStudyRelease Top 10 #2; dsr `release verify --fix`). That is not part of this change.

## Operating it

```bash
# preflight, select the cut, sign, notarize and verify; print the remote effects only
scripts/sign-darwin-release.sh --dry-run
# the real thing: draft, upload, dispatch the signing run
scripts/sign-darwin-release.sh [--version 0.2.60]
```

Scratch goes under `$TMPDIR` (set it to an owned directory first); each run keeps its work
directory as evidence. Environment: `OMP_KIT_DEVID_SHA1` (identity), `OMP_KIT_NOTARY_PROFILE`
(default `omp-kit-notary`), `OMP_KIT_SIGNING_KEYCHAIN` (default `~/Library/Keychains/uds-signing.keychain-db`),
`OMP_KIT_SIGNING_KEYCHAIN_PASSWORD` (the uds lane's password file, default
`~/.config/uds/signing-keychain.pw`), `OMP_KIT_REPO` (default `JYeswak/omp-kit-companion`) and
`OMP_KIT_DEVID_STATE` (dispatch receipts and the `main` mirror, default
`~/.local/state/omp-kit/devid-sign`).

Notary credential (resolved 2026-10-19): an App Store Connect API key dedicated to notarization
(Key ID `USMDATPK89`, team `XGL9CXRCT5`) is stored as the notarytool profile `omp-kit-notary`
inside `uds-signing.keychain-db`, which the signer unlocks from the uds password file. A
profile stored the default way (`store-credentials` without `--keychain`) lives in the
data-protection keychain, which can't be read while the screen is locked, and that is why an
unattended run failed with `No Keychain password item found`. To rotate the key, create a new
one in App Store Connect, unlock the signing keychain, run
`xcrun notarytool store-credentials omp-kit-notary --key <p8> --key-id <id> --issuer <team issuer> --keychain <signing keychain>`
(it validates with Apple before saving), re-lock the keychain, revoke the old key, then rerun `--dry-run`.

The train releases one cut at a time, so while a tagged cut waits for the signer, no newer
version is allocated: releases pause until the signer runs. A cut must be signed within the
7-day retention of its qualification artifacts, which the signer and the signing run both
read. After that the signer refuses it (`artifact ... missing, expired or ambiguous`), and
the cut can only end as a terminal signing failure, which the train retains before it moves
on. Run the signer soon after each `SIGNING=awaiting-developer-id`; nothing schedules it
yet. A dispatch receipt whose run never appears (`OUTCOME_UNKNOWN`) means the POST may have
created a run: find that run in the Actions list before you delete the receipt.

Revert: set `darwin_signing` back to `adhoc` (see the flip procedure). Reverting the whole
DEVID-SIGN-V1 change is safe while the switch is `adhoc`.

## Local release without the CI pipeline (LOCAL-RELEASE-V1)

While J-2026-10-18-30 suspends the CI pipeline ("signed releases skipping ci like jeff"),
`scripts/release-local.sh` cuts a release on the signing Mac (bead `ompkit-v66l.27.11`). The switch
is `developer-id` since that bead. The consumers' trust root is unchanged: the installer and
`omp-kit update` (`installer/install.py` `verify_attestation`, `src/kit-update.ts`
`authenticateUpdateArchive`, `src/kit-update-job.ts` `pollPublishedRelease`) still require a
GitHub Actions OIDC SLSA provenance from `release.yml` at the tag's source digest. So one small
GitHub job remains, and it never builds anything.

1. `bash scripts/release-local.sh --version X.Y.Z` (or `--next`, patch+1 from
   checkout HEAD) prepares and cuts in one invocation. On `main`, with clean
   `package.json`, `README.md` and `changelog.d/774u.md`, it updates both package
   versions, the release stamp and fragment, then commits exactly those paths
   with `--only`, subject `chore(release): prepare X.Y.Z ompkit-774u [test]` and
   `Gap-Bead`, `Bead`, `Agent` trailers. Foreign staged, unstaged or untracked
   changes on those paths refuse before any edit; unrelated staged work is
   excluded. Commit hooks and push hooks remain active.
2. It pushes main, reads back that the prepare SHA is on origin/main, and
   invokes `release-verdict.sh --commit <prepare-sha> --no-fetch` when either
   exact-tree verdict is missing. A verdict lock acknowledgement is not PASS:
   it waits (bounded) for both main and CI-only records from that exact export.
   A producer failure or recorded FAIL refuses before signing.
3. The existing cut then builds the ship set from `git archive`, signs and
   notarizes, checksums, checks TTSR, pushes the immutable tag, uploads a draft,
   dispatches `release.yml mode=local-attest`, waits for verified publication,
   and downloads and verifies the public bytes, attestations and Gatekeeper.
4. Real cuts default to `--install` (`--no-install` explicitly stops at released).
   The existing kit at `~/.local/opt/omp-kit/bin/omp-kit` (override prefix with
   `OMP_KIT_INSTALL_PREFIX`) updates from the exact verified public index/archive
   and their fetched attestation bundle. It applies all profile plugin links,
   including default, to `releases/X.Y.Z`, runs that release's
   `skills/fleet-restart/scripts/fleet_restart.py align` with the explicit target,
   and reads back the installed CLI version. No seat is restarted.
   The one automatically reconciled update failure is the updater's own
   live-browser-state-only PARTIAL: matching target, passing matcher/live,
   no operator-path changes, failures or cause, and the exact receipt-bound
   reconcile command offered by the updater. Reconciliation still verifies
   recorded postimages; any other failure refuses.
   Stage/substep clocks cover update, optional reconcile, relink, alignment and
   version readback. Only then does the receipt say `installed:true` and include
   `push_to_installed_seconds`; it also retains push-to-released time.
   Receipts persist in a kitlib-owned `release-receipt.*` directory printed in
   the JSON output's surrounding run context, while build scratch is removed.
   These clocks measure the four-minute goal; they do not claim it has been met.

`--dry-run` without `--source` **creates the local prepare commit**, but does
not push it, create a tag/draft or dispatch. It still qualifies, builds, signs
and notarizes. To preview an already prepared published commit without editing
metadata, use `--source <full-sha> --version X.Y.Z --dry-run`; the same explicit
source form resumes a real cut. After an unsuccessful prepare push, publish
through the normal convergence route and resume with that printed SHA, rather
than preparing another version. `--next` cannot be combined with `--source`.
Dry runs never install or relink, even when `--install` is specified.

A cut stranded after its draft (tag and draft exist, attest-local failed, e.g.
a transient runner verifier outage) resumes with
`--resume-from-draft --version X.Y.Z` instead of re-tagging. The resume adopts
the remote tag only after the `version-match` gate proves it names a commit
whose `package.json` states the version, and adopts the draft only after
downloading every asset and proving it equals the signed bytes (`SHA256SUMS`
plus the checksum-stage index/archive checks). It then re-dispatches
attest-local and continues through the unchanged verify, install and
next-version stages. A draft whose assets differ, or a tag naming another
version, refuses before anything is dispatched.

### Former manual steps (0.2.86) and ownership

| Former lead action | Current status |
|---|---|
| Choose patch and hand-edit two versions, README stamp and fragment | Automated by `--next` or explicit `--version`; metadata-only fragment does not invent release-content claims |
| Prepare exact-path commit and trailers | Automated, `--only`; custody refusal before edits |
| Publish and identify immutable source | Automated push plus origin ancestry readback |
| Run/wait for full suite and CI-only export verdict | Automated on exact prepare SHA; cached matching PASS reused, queue acknowledgement never accepted as PASS |
| Check unused tag/release, version, admission, tools, GitHub and signing credentials | Existing preflights retained; credentials/certificate must already be provisioned by their owner (vendor login/key issuance cannot be manufactured by the release) |
| Build, sign, notarize, checksum, rule gate, notes, tag, draft, attest, public verification | Automated by the cut, with stage/substep timings and a receipt |
| Allocate owned scratch and set TMPDIR | Caller still supplies the scratch lease: its capability/lifetime belongs to the caller, not an inferred shared directory |
| Freeze candidate / hold competing pushes and heavy lanes | The commit pins bytes automatically; scheduling other agents remains the fleet director's authority, which a source-release script cannot safely assume |
| Install certified release and relink/check every profile | Automated by default `--install`: receipt-backed update, narrow live-browser-only reconciliation when offered, all-profile relink, real fleet align and installed-version readback |
| Fetch the released tag into companion | Automated after exact remote tag readback, for this source checkout's launch-check consumer |
| Check installed hooks on every hooked repo | Fleet deployment check, not a source-cut mutation: `install-commit-msg-bead.sh --check` per registered repo; reconcile through its owning installer |
| Restart seats, close train beads | Remain director/non-author actions: a release cannot interrupt busy/paused seats or award its own acceptance |

This command installs the certified kit and aligns profile links, not an npm
publication or a seat restart. Those retain their separate credentials and
runtime safety/approval gates.

`release.yml`'s only trigger is `workflow_dispatch`, and its `mode` input defaults to
`local-attest`. Every qualification, native-matrix and signing job requires
`inputs.mode == 'ci-pipeline'`, which the train's dispatches (`release_reuse.py`) pass
explicitly. Enabling `release.yml` therefore cannot start the expensive pipeline. A failure
after the tag keeps the tag and the draft. Fix it and redispatch `attest-local`; never re-tag.

`attest-local` uses the same bounded, three-worker archive verifier as the local
public check (`scripts/release-public-verify.py`). Each archive still fetches its
own attestation and runs the embedded consumer verifier; every result is joined.
Any failed fetch or consumer proof refuses the job. The index attestation check
still follows all three archive proofs, and publication follows the index check.

### Release latency investigation (RELEASE4MIN, 2026-11-03)

The 0.2.86 cut used source `26cdd547a1c44fe8170fbea620a0dc78babe0a11`.
`cut086.log` records draft **112 s**, attest **100 s**, verify **105 s**:
**317 s** of the approximately 406 s cut. Its receipt reports 405 s; stage
clocks use whole seconds. This is cut time, **not** push-to-installed time
including tests. No sub-four-minute round-trip result has been demonstrated.

Read-only evidence:

- Local log: tracker checkout `var/sitrep/cut086.log`, lines 41–66.
- [Attestation run 41671758689](https://github.com/JYeswak/omp-kit-companion/actions/runs/41671758689):
  `gh run view 41671758689 --repo JYeswak/omp-kit-companion --json createdAt,startedAt,updatedAt,jobs`
  and the same command with `--log`.
- [Release asset metadata](https://api.github.com/repos/JYeswak/omp-kit-companion/releases/tags/v0.2.86):
  `gh api repos/JYeswak/omp-kit-companion/releases/tags/v0.2.86`.

Historical times below distinguish recorded intervals from unavailable splits.
Asset `updated_at - created_at` bounds the server's asset-processing interval;
it is not a separately instrumented client upload duration. Concurrent rows do
not add together.

| Stage / sub-step | Recorded seconds | Evidence / limitation |
|---|---:|---|
| Draft total | 112 | Local stage clock |
| Upload darwin archive, 76,055,040 bytes | 86 | Asset timestamps 16:10:27–16:11:53 UTC |
| Upload linux-arm64 archive, 98,296,320 bytes | 105 | 16:10:27–16:12:12 |
| Upload linux-x64 archive, 98,745,856 bytes | 108 | 16:10:27–16:12:15 |
| Upload index, 887 bytes | <1 resolution | Both timestamps 16:10:27 |
| Upload SHA256SUMS, 391 bytes | <1 resolution | Both timestamps 16:10:27 |
| Create request, readback, local digest comparisons | Unavailable individually | Approximately 4 s outside the longest asset interval; not independently timed |
| GitHub asset-digest polling | 0 | No poll exists: one `gh release view`, then equality checks |
| Attest total | 100 | Local stage clock |
| Workflow dispatch / run discovery | Unavailable individually | Local log has no command timestamps; discovery polls every 5 s |
| Runner queue / scheduling | 6 | Run created 16:12:19, job starts 16:12:25 |
| Runner setup / action downloads | 3 | Job step timestamps |
| Checkout | 4 | Job step timestamps |
| Tag/source/draft checks and five asset downloads | 8 | One step; download/check splits unavailable |
| SBOM generation: darwin / linux-arm64 / linux-x64 | 3 / 1 / 1 | Job step timestamps |
| Batched build provenance (three archives + index) | 8 | Inner action: predicate 0.706 s, signing/upload 7.203 s |
| SBOM attestations: darwin / linux-arm64 / linux-x64 | 7 / 5 / 4 | Inner signing/upload actions: 6.166 / 4.735 / 4.490 s |
| Consumer archive hash + attestation fetch + installer verify: darwin / linux-arm64 / linux-x64 | 4.73 / 4.20 / 4.46 | Consecutive success-log intervals; fetch versus verifier unavailable |
| Index attestation verification / step tail | 3.44 | Last archive success to next step |
| Attach three SBOMs, choose Latest, publish and read back | 7 | Job step timestamps |
| SBOM upload intervals: darwin / linux-arm64 / linux-x64 | 1 / 1 / <1 resolution | Asset timestamps; calls are sequential |
| Job cleanup / finalization | About 1 | Job completes 16:13:34 |
| GitHub run lifecycle, including queue | 76 | Run created 16:12:19, updated 16:13:35 |
| Dispatch/discovery plus completion polling and log retrieval outside run lifecycle | About 24 combined | 100 minus 76; cannot allocate among these operations |
| Verify total | 105 | Local stage clock |
| Public downloads: SHA256SUMS / index / darwin / linux-arm64 / linux-x64 | Unavailable individually | Five sequential curl calls, no timestamps |
| Public byte comparisons and SHA256SUMS | Unavailable | Inside the same 105 s |
| Attestation API fetch, each platform | Unavailable | Three sequential bounded calls |
| Embedded installer verifier, each platform | Unavailable | Three sequential bounded calls; real pinned consumer policy |
| Extraction, codesign and Gatekeeper | Unavailable | Gatekeeper accepted; no duration recorded |

#### Prior art and ranked levers

[GitHub CLI's create implementation](https://github.com/cli/cli/blob/v2.83.0/pkg/cmd/release/create/create.go)
sets upload concurrency to five. Our single `gh release create ... "$DIST"/*`
already uses this path; all five assets started at 16:10:27. Splitting it into
parallel `gh release upload` processes is not a new optimization, and a single
CLI call still performs one HTTP upload per asset.

[Kronk's release workflow](https://github.com/ardanlabs/kronk/blob/main/.github/workflows/release.yaml)
uses GoReleaser then one wildcard/multi-path provenance action for archives,
packages, SBOMs and checksums. Our workflow already batches the three archives
and index into one provenance action. The
[pinned action](https://github.com/actions/attest-build-provenance/blob/e8998f949152b193b063cb0ec769d69d929409be/action.yml)
also supports checksum-file subjects; switching inputs alone does not remove
our mandatory byte checks. No independent upstream workflow speed measurement
is claimed.

The following savings are **estimates, not measured wins**, and are not
additive. Retain every checksum, byte comparison, attestation policy and
Gatekeeper check.

| Rank | Lever | Expected seconds saved | Risk / disposition |
|---|---|---:|---|
| 1 | Smaller compressed published archives | Potentially 50–150 across upload/download if size falls 2–4x and bandwidth dominates | Proposal only: ratio and CPU cost unmeasured; changes filenames/index/installer/reuse contract and signed-archive handling |
| 2 | Overlap five public downloads in one curl process | 0–60; upper bound is the currently unmeasured serial transfer portion | Implemented: cap five; same 600 s aggregate bound, redirects/retries and byte checks; bandwidth contention may save nothing |
| 3 | Poll completed run every 3 s instead of 20 s | 0–17 per completion, 8.5 expected under uniformly phased completion | Implemented: same 30-minute refusal deadline and bounded API calls; more read requests, about 23 extra for a 76 s run |
| 4 | Concurrent per-platform consumer verifications | About 8–10 on the runner, local saving unmeasured | Proposal: supervise all children and retain every failure; do not conflate runner timing with the signing Mac |
| 5 | Concurrent SBOM attestations | About 9–10 before extra scheduling overhead | Proposal: three distinct SBOM subjects/predicates must remain; workflow/OIDC execution changes need review |
| 6 | Batch the three SBOM asset uploads into one gh call | About 1–3 | Proposal: preserve skip-existing behavior and non-regressive Latest; small compared with archive transfer |
| 7 | Add upload parallelism or batch provenance | 0 | Already present; keep the native implementation |
| 8 | Tighten GitHub asset-digest polling | 0 | No such polling exists |

The safe changes alone do not establish the 166+ s reduction needed for the
four-minute goal, especially with tests and installation included. A new real
cut and installed-version readback remain necessary.

The local driver now logs `substep ... took Ns` separately for draft creation,
digest readback, workflow dispatch/discovery/completion/log retrieval, public
downloads, byte/checksum verification, each attestation fetch, each embedded
installer verification, and Gatekeeper. Curl logs each asset's transfer seconds
and result, including failed assets. Parallel downloads require curl 7.75+
(`--parallel` and write-out `exitcode`; the signing Mac has 8.7.1). This changes
neither published assets nor the installer trust root. The regression test uses
real loopback curl transfers with an all-archive request barrier, an HTTP 404,
and tampered bytes; separate controls prove runner failure still refuses.
