# SVCPIN1 (ompkit-v66l.26): first spawn after a kit release dies on a launch constraint

Measured 2026-10-18 local (2026-10-19Z), macOS 26.5.2 (25F84), by PeachLeopard.

## What happens

Background Task Management gives each notified legacy LaunchAgent a launch requirement
(LWCR) when launchd spawns it (`launchctl print` properties: `managed LWCR | has LWCR`).
The kit binary is ad hoc and linker-signed (`Identifier=a.out`, `TeamIdentifier=not set`),
so the requirement pins its cdhash. A kit activation swaps the binary behind
`~/.local/bin/omp-kit`, and the next spawn of every kit agent fails. launchd asks for a
new requirement and the following spawn succeeds. The job stays loaded, even though
launchd logs "removing service".

load-watch around the 0.2.50 switch (19:09:30), from
`log show --predicate 'process == "launchd"'` (lines cut):

```
19:09:35.994 [gui/501/com.omp-kit.load-watch [10016]:] xpcproxy exited due to OS_REASON_CODESIGNING | Launch Constraint Violation, error info: c[5]p[1]m[1]e[0], (Constraint not matched) launch type 0, failure proc [vc: 10]: /Users/josh/.local/opt/omp-kit/releases/0.2.50/bin/omp-kit
19:09:35.994 [gui/501/com.omp-kit.load-watch [10016]:] removing service since it exited with consistent failure - OS_REASON_CODESIGNING | Launch Constraint Violation ...
19:09:35.994 [gui/501/com.omp-kit.load-watch [10016]:] Requesting LWCR update on next spawn
19:10:36.007 [gui/501/com.omp-kit.load-watch [11536]:] Requesting repair LWCR update: runs=11
19:10:36.329 [gui/501/com.omp-kit.load-watch [11536]:] Updated BTM identifiers: CA659BF2-46A2-4905-BF69-300EFBE14D02 New LWCR needed: 1
19:10:36.333 [gui/501/com.omp-kit.load-watch [11536]:] Successfully spawned omp-kit[11536] because interval
19:10:39.043 [gui/501/com.omp-kit.load-watch [11536]:] exited due to exit(0), ran for 3043ms
```

Every `xpcproxy exited due to OS_REASON_CODESIGNING` in the retained log (since the
00:54Z reboot), counted per job and binary:

| job | 0.2.49 | 0.2.50 | 0.2.51 |
|---|---|---|---|
| ci-poller | 1 | 1 | 1 |
| load-watch | 1 | 1 | 1 |
| kit-update | - | 1 | 1 |
| fleet-watch | 1 | - | - |
| fleet-flush | 1 | - | - |

Each job lost exactly one spawn per release. None was lost for good: afterwards
load-watch showed `runs = 53`, `last exit code = 0`. Per InstallHeal's reading of the code,
no postcheck step touches the launchd agents, so these lost spawns do not explain the UNDONE
postcheck.

## Disposable-label repro (AC1): inconclusive

The probe is `tests/e2e/svcpin-launch-constraint.sh`. It builds two ad-hoc C binaries with
different cdhashes, puts them behind a two-level symlink in the kit's layout, and runs the link
from `com.omp-kit.test.svcpin` (StartInterval 10). Each run then flips the link to the second
binary. There were four runs with `--launch direct`. The first two had no BTM warm-up. Run 3
re-bootstrapped after 20 s. Run 4 rewrote the plist and then re-bootstrapped:

```
{"launch":"direct","cdhash_a":"5a36cafb…","cdhash_b":"5e2226bd…","a_runs_before_flip":2,"b_runs":5,"constraint_violations":0,"codesigning_exits":0}
{"launch":"direct","properties_before_flip":"runatload | inferred program","pinned_before_flip":false,"a_runs_before_flip":31,"b_runs":5,"constraint_violations":0}
{"launch":"direct","properties_before_flip":"runatload | inferred program","pinned_before_flip":false,"a_runs_before_flip":33,"b_runs":5,"constraint_violations":0}
{"launch":"direct","properties_before_flip":"runatload | inferred program","pinned_before_flip":false,"a_runs_before_flip":15,"b_runs":5,"constraint_violations":0}
```

In all four runs the second binary ran on every spawn, because the label never got a requirement. In
backgroundtaskmanagementd/smd the item stays `disposition=[enabled, allowed, not notified]`
after BTM posts its "“svcpin” can run in the background" advisory (19:32:38, 19:36:00,
19:43:15). launchd sends no `first run` or `repair LWCR update` for it. On the fourth run BTM
logged `Exceeded max notifications for svcpin` and `should post advisory=false`. By contrast,
kit-update went from `not notified` (18:59:02, after login) to `notified` (19:00:24) and got
`Requesting first run LWCR update` at 19:04:02. The step that marks an item notified did not
happen for the disposable label within this session, and the probe cannot force it. The
script therefore reports `INCONCLUSIVE` (exit 3), never a pass, when no requirement is
attached. Do not loop it: every run posts a user notification until BTM's cap.

Cleanup: `launchctl print gui/501/com.omp-kit.test.svcpin` returns "Could not find service"
(exit 113), and `~/Library/LaunchAgents/com.omp-kit.test.svcpin.plist` is absent.

## Fix options (not landed; see the bead)

- A. Make ProgramArguments `/bin/sh -c 'exec "$0" "$@"' ~/.local/bin/omp-kit service run JOB`
  so that launchd spawns, and BTM pins, the platform `/bin/sh`. There is live support for
  this: `com.cfs.keychain-probe` (program `/bin/sh`) holds `has LWCR`, and no `/bin/sh` job
  appears in the codesigning kills. It is not proven whether the requirement also applies to
  the `exec` after the shell starts; that needs a pinned label (above). It also reverses the
  S1 design assertion `expect(text).not.toContain("/bin/sh -c")` in
  `tests/cli/service.test.ts`.
- B. Re-bootstrap every kit agent after an activation. Not measured. BTM keeps the
  requirement in its own store across bootstraps (the test item logged "updated item with
  same LWCR" when it was re-bootstrapped). The inference is that a re-bootstrap alone would
  not clear the pin, and the first spawn would still fail.
