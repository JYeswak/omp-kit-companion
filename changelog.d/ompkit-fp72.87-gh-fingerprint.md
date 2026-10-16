### Security

- `omp-kit doctor --scope github` no longer prints the first characters of a GitHub token: the credential fingerprint is now the first 16 hex characters of the token's SHA-256 digest (commit be800ef).
