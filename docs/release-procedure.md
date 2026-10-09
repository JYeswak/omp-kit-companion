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

A commit touching shipped paths with neither fails the check.

## 2. Assemble the changelog

```sh
sh scripts/release-notes.sh assemble --base-tag vX.Y.Z --head main \
  --version X.Y.Z --date YYYY-MM-DD --write
```

## 3. Tag semver

Tags are `vX.Y.Z` on the exact certified commit. The release workflow
(`.github/workflows/release.yml`) refuses anything else: exact tag shape,
tag on HEAD, tag commit equals HEAD.

## 4. Build platform archives with sha256

```sh
sh scripts/package-release.sh --version X.Y.Z --platform darwin-arm64-none --out ABSOLUTE_DIR
```

Repeat per platform. `release-index.json` lists every archive with its
sha256; the installer (`installer/install.sh --version X.Y.Z --index URL
--prefix DIR`) verifies the hash before installing and refuses on mismatch.
Release candidate indexes contain exactly `darwin-arm64-none`, `linux-arm64-gnu`,
and `linux-x64-gnu`. `darwin-x64-none` is a non-shipping CI probe and is
excluded from published indexes and attestations. Release-mode candidate
generation requires both minimum and certified OMP receipts for all three
ship targets; a missing or refused ship receipt blocks attestation.

## 5. Signing (delegated)

Archive signing, SBOM and SLSA provenance are rz5.59.3, not this procedure:
this step is a pointer there, not a duplicate. Until signing lands, the
sha256 index plus the tag-bound workflow are the integrity story.

## 6. Publish and install-check

Publish the GitHub release from the tag, then install from the published
index on a machine that did not build it (fresh HOME where possible).
