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
  authentication uses the keychain profile (`zscast`, override with
  `OMP_KIT_NOTARY_PROFILE`). The identity is selected by SHA-1
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
(default `zscast`), `OMP_KIT_SIGNING_KEYCHAIN` (default `~/Library/Keychains/uds-signing.keychain-db`),
`OMP_KIT_SIGNING_KEYCHAIN_PASSWORD` (the uds lane's password file, default
`~/.config/uds/signing-keychain.pw`), `OMP_KIT_REPO` (default `JYeswak/omp-kit-companion`) and
`OMP_KIT_DEVID_STATE` (dispatch receipts and the `main` mirror, default
`~/.local/state/omp-kit/devid-sign`).

Open prerequisite (2026-10-19): the notary keychain profile `zscast` is in neither the
login keychain nor `uds-signing.keychain-db` (that keychain holds only the Developer ID
identity), so the preflight refuses with `No Keychain password item found for profile:
zscast`. Store the App Store Connect API key credentials once in the signing keychain:
`xcrun notarytool store-credentials zscast --keychain <uds-signing keychain> ...`. Then
rerun `--dry-run`.

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
