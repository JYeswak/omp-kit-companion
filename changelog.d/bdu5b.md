### Fixed
- Scratch quarantine no longer fails across devices: when the global quarantine sits on another device than the scratch root (EXDEV, e.g. ovnfs checkouts on the mount), the reaper falls back to a quarantine inside that root and expires it on the same schedule.
- Scratch under an ovnfs checkout's `var/agent-tmp` is no longer reported as foreign: it is skipped as checkout-owned (`checkout-owned-scratch`) and left to the checkout lifecycle, instead of failing every run.
- A release marker now survives an APFS reboot: the retire recheck tolerates the renumbered device id when the machine rebooted since the release (same inode), so pre-reboot scratch is releasable by its owner again.
