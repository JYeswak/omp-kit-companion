### Fixed
- LSP readiness honors a validated `OMP_SRC` source tree when the launcher binary has no source layout beside it (e.g. a compiled manager binary), and refuses mixed identities where both resolve differently. Binary-only launchers no longer report opaque defaults when a matching source tree is configured.
- The real-request LSP tests add the hermetic `OMP_SRC` tree only for a binary-only launcher; an npm-installed launcher with its source beside it (CI) is used as is, instead of tripping the mixed-identity refusal.
