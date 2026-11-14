### Fixed

- The opt-in SLB bridge uses the native `slb hook guard` protocol instead of a machine-specific private adapter. It preserves reviewed execution-input handoffs and protected DELETE admission, rejects unsupported revisions and incomplete output, and bundles its shared bounded-process dependency for installed extensions. Native ask/deny and unavailable-tool failures remain non-allow; no approval policy changes.
