### Fixed
- Fetch required Sigstore bundles during online installation and document the offline bundle and verifier requirements.
- Supply controlled attestation inputs to installer tamper regressions so digest, manifest and member-type checks run without weakening authority refusal.
- Fetch digest-bound attestation sidecars when polling published kit updates, before strict planning and activation.
- Keep plugin relink and undo regression fixtures independent of the installed OMP environment and preserve real receipt values across matcher assertions.
- Keep upgrade regression packages complete with fleet rules and manifests, automatically retire read-only and compiled fixture releases, and check unavailable postchecks by their declared stage rather than generic wrapper messages.
