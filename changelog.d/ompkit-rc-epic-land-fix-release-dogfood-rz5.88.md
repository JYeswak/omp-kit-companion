### Fixed
- Pre-push runs the committed base's fresh gate when judging code or its executable inputs change, preventing gate deletion or `exit 0` bypasses without adding a second fresh-gate run to ordinary pushes.
