### Fixed

- Land resolves the owner from a native Tern pane via `TERN_PANE` to `tern:<id>` with existing Agent Mail pane resolution when no `TMUX_PANE` is present; tmux keeps precedence, and a Herdr caller (`HERDR_PANE_ID`) is refused instead of borrowing an outer key (ompkit-kdbz.1.2.1). A missing, malformed, or unregistered pane key is refused as `OWNER_UNKNOWN` before any Git effects, with all lease, base, consent, and no-force guards unchanged.
