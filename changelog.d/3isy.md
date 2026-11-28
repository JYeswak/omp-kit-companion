### Fixed
- macOS update postchecks no longer report a partial install for concurrent self-replay receipt writes when the postcheck was fenced from those files. Unfenced, aliased, and unrelated changes still fail verification. (`ompkit-3isy`)
