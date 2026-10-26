### Fixed

- The skill-stations config cites the fleet rule file as `~/.agents/AGENTS.md`, not `/Users/josh/.agents/AGENTS.md`, so the shipped kit holds no machine-specific path and the packaged kit's own invariant gate passes its shipped-config stage again. Three regex and slow-path station citations had carried the literal since SKILLSTATION1. (ompkit-fp72.135.3.53)
