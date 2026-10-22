### Fixed

- Tern seat observation pins the daemon socket (`TERN_DAEMON_SOCKET`, else `$TERN_CONFIG_DIR/daemon.sock`, else the default settings socket) and resolves the seat's window before any read: an explicit key is verified with `--window KEY`; an empty key addresses Tern's default window only when that window lists the configured session. Unresolvable seats are refused, never observed blind. (ompkit-kdbz.2.16)
