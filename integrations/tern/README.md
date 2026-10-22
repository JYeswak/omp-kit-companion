# Tern SDK integration — INCOMPLETE UPLOAD / DO NOT MERGE

This draft preserves the portion of the previously delivered Tern integration
bundle that could be uploaded through the connected GitHub tool. The user
explicitly requested publication as a pull request; this branch does not change
`main` or activate any new commands in the existing CLI.

**This directory is not runnable yet.** The source upload was blocked by an
automated tool check while submitting `src/tern/transport.ts`. It must not be
presented as a complete implementation, a successful integration, or a native
Tern certification. The block did not state that the code itself was unsafe.

## Uploaded source

- `src/tern/model.ts`
- `src/tern/api.ts`
- `src/tern/command.ts`
- `src/tern/registry.ts`
- `src/tern/receipts.ts`
- `src/tern/omp-adapter.ts`
- Standalone `package.json` (do not replace the repository's package.json)
- `integration/omp-kit.patch` (not applied)

## Still missing from this PR

The source catalog, transport, Luau compiler/generator, coverage verifier, TSP
codec, script-route inventory, standalone scripts, tests, fixtures, native plugin,
and full documentation/verb map remain in the complete downloadable bundle
supplied in the originating conversation. Generated bindings can be reproduced
from its generator. No claim is made that these missing files are in this branch.

Complete bundle: `omp-kit-tern-integration-2026-10-16.zip`

SHA-256: `5330617e644953da3c973984b342c9e553f9392a7dd88bf6e88b870b5ce90929`

## Verification scope

Before publication, the complete local bundle's `FILES.sha256` check passed,
all 40 Node tests passed, and all five Python documentation-census tests passed.
Those results apply to the complete local bundle, **not this incomplete PR tree**.

A full clone could not be obtained in this execution environment because GitHub
DNS resolution failed. Repository-wide tests, the applied integration patch,
compiled Bun release checks, installed-SDK declaration equivalence, and live
Tern behavior have not been verified in this publication attempt.

## Completion conditions

Import the remaining original bundle files without changing their meaning,
reconcile and apply the included patch against the current repository, add the
new tests to the existing CI path, and run the repository's required checks.
Preserve explicit native-context and non-undoable-effect boundaries. Keep this
pull request draft until its source is complete and the remaining validation
limits are clearly recorded.

Targets recorded by the original bundle:

- omp-kit: `033598f89e9b12c5449965ecf74e5e9baf024747`
- Tern SDK: `f3f9fee82bf692166c2a477a895a347ac2a47ca2`
- Tern declaration blob: `0dcdd18378712fde1ae40322d18b7c022939950a`
