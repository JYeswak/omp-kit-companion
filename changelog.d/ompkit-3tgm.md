### Fixed
- Scratch reaper: session dirs skipped for owner-label mismatch or an invalid label now age into quarantine (dead owner, no open files, 72 h idle) instead of stranding; failed quarantine/rename/delete actions record the exact path, action and OS error on stderr and the run receipt and fail the run, while expected safety refusals are counted and exit 0. (ompkit-3tgm)
