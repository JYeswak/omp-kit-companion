### Fixed
- Reduce subprocess peak memory by releasing discarded pipe buffers promptly. Captured output and chunks accepted by streaming callbacks are never detached by the drain; partial views and non-detachable buffers retain their ordinary lifetime.
