# Changelog

## 0.1.1 — 2026-09-29

- The standalone installer now prevents its Python subprocesses from writing standard-library bytecode into a fresh macOS HOME. Offline and online dry runs, and a failed online archive download, leave the isolated HOME untouched; the real-archive regression also runs on native macOS CI.
- Rebuild and recertify all four native release targets against the exact tagged source. The `v0.1.0` assets remain immutable; upgrade only by explicitly choosing `v0.1.1`'s reviewed local index and archive.

## 0.1.0 — 2026-09-29

- First public source-only root for the compiled `omp-kit` companion. The original working repository and its prior history remain private; this root does not inherit those commits. The [MIT license](LICENSE) and [release assets](https://github.com/JYeswak/omp-kit-companion/releases/tag/v0.1.0) describe the published boundary.
- The CLI inspects OMP, checks 18 rules against 274 fire/quiet cases and streamed prefixes, runs isolated live/mock-model scenarios, previews guarded rule/policy/extension changes, records receipts, and offers read-only profile, LSP and MCP examples. Installed checks do not certify a user's effective profile.
- Versioned macOS and Linux arm64/x64 archives are distributed only for native-certified targets in the release index. The standalone installer checks the archive digest and internal file manifest before atomically selecting a versioned executable. Index hashes give integrity, **not** publisher authentication. OMP, models and profiles are never installed by implication.
- The kit-only updater requires an exact newer version and matching **local** index and archive. At initial publication no newer release existed; OMP updates remain external. A failed post-check leaves a pending recovery receipt rather than claiming rollback or GREEN.
- The README hero was graded on its [exact shipped JPEG](visual/hero-identity-grade.json) with the hash-locked Yuzu anchor and unchanged 70-point numeric formula: ChatGPT OAuth `gpt-5.6-luna` scored 80.9; independent xAI `grok-4.7` scored 79.5. The original `gpt-4o-mini` judge did **not** run; the receipt identifies the substitution.

This is the beginning of the public timeline, not a relabeling of the older private development history. See [NEGATIVE_EVIDENCE.md](NEGATIVE_EVIDENCE.md) for measured limits and refuted claims.
