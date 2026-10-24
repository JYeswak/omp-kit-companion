### Fixed

- `repair --plan`, `status` and plain `test` no longer write the rch socket inode baseline (`rch-socket-ino.json`) into the kit state root; only `doctor` records it, and the other commands still compare against an existing baseline, so a replaced socket is still `SOCKET_UNLINKED`. (ompkit-lrbd.3)
