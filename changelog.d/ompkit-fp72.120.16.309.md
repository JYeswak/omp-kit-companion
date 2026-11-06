### Changed
- Release installation reuses a completed reconciliation's plugin relink only while its durable receipt covers every current profile and live links target the verified release; final alignment and version checks remain mandatory, with relinking if profile coverage changes during readback.
- Public release verification runs up to three independent attestation-fetch and installer-verifier chains concurrently, preserving all byte, checksum, authority and Gatekeeper checks and refusing on any failed, timed-out or truncated chain.
