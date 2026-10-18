### Fixed
- Fleet scratch checks now leave process control, agent messaging, and tool-device routes to their native authority checks instead of treating them as cwd-relative files. Filesystem URI targets remain scratch-checked after decoding; session-local targets use the caller's actual backing root and fail closed when it is unavailable.
