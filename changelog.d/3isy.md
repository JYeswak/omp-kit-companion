### Fixed
- Scheduled update polling acquires the existing update lock before writing the release index, archive, or attestation bundle; a manual update in progress defers those writes instead of contaminating the isolated postcheck.
