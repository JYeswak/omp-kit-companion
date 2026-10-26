### Fixed

- Lock conformance tests terminate and reap their own FIFO inheritor without relying on a transient EOF handshake. Child exit waits remain asynchronous and bounded, preserving descriptor-inheritance checks and reporting a named timeout after forced cleanup.
