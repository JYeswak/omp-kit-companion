# Release procedure

How any fleet repo cuts a versioned release (PUB1c). The companion repo is
the reference implementation; uds adopts this same procedure next.

## 1. Fragments, every commit

Each change ships with `changelog.d/<bead>.md` (one line or more), or a
`[no-changelog]` reason in the commit message. The release workflow enforces
it:

```sh
sh scripts/release-notes.sh check --base-tag vX.Y.Z --head REF
```

A commit touching shipped paths with neither fails the check. The pre-push gate runs the same coverage for the pushed range first (`scripts/check-pushed-notes.sh` via `fresh-gate.sh`), so a missing trailer, reason or naming fragment refuses the push, not the release.

## 2. Assemble the changelog

```sh
sh scripts/release-notes.sh assemble --base-tag vX.Y.Z --head main \
  --version X.Y.Z --date YYYY-MM-DD --write
```

## 3. Tag semver

Tags are `vX.Y.Z` on the exact certified commit. The release workflow
(`.github/workflows/release.yml`) refuses anything else: exact tag shape,
tag on HEAD, tag commit equals HEAD.

### 3a. Rehearse before spending the version

A tag cannot be reused, so a release that fails after tagging abandons its
version. Rehearse the identical pipeline from main first:

```sh
gh workflow run release.yml --ref main -f version=X.Y.Z -f rehearsal=true
```

The rehearsal runs the changelog check, the whole CI candidate, `attest-platforms`
and the attest SBOM on the throwaway version `X.Y.Z-rehearsal.RUN.ATTEMPT`. It
refuses when `vX.Y.Z` already exists, creates no tag or release, and skips the two
signing steps (build provenance, SBOM attestation), which only a real run
exercises. Green: tag the same SHA and dispatch for real. Red: no version spent.

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

Archive signing, SBOM and SLSA provenance are rz5.59.3, not this procedure:
this step is a pointer there, not a duplicate. Until signing lands, the
sha256 index plus the tag-bound workflow are the integrity story.

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
