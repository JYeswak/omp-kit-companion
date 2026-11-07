---
name: fleet-restart
description: Native Tern session persistence and OMP goal lifecycle; read-only release profile alignment.
---

# Native session lifecycle

NATIVESESSION1 (ompkit-1ra0d.37) retires the kit's fleet respawn, watcher-resume and composer reconstruction machinery.

- Tern's daemon keeps running programs across window replacement. Use `tern restart` for a Tern update; its response may explicitly say the executable was unchanged and kept. That is not proof of a daemon replacement, nor an OMP upgrade.
- Use OMP's native session restore (`omp --restore`, or the exact saved session file) for a stopped OMP process. Keep the original owner identity. Do not reconstruct argv or goal prompts from screen text.
- Read native goal state with `goal get`; only explicit owner intent authorizes `goal create`, `pause`, `resume` or `drop`. A paused or goal-less session must not be automatically rearmed. OMP process restore may intentionally leave a saved goal paused; do not turn that into an implicit resume.
- Settings reload, Tern restart, OMP process restore and loaded extension-version verification are different operations. A Tern restart does not reload code inside an existing OMP process.
- No kit timer, sentinel, dead-man LaunchAgent or fleet respawn command is available to restart work. Await native asynchronous results or an explicit work event.

For an explicit owner-controlled restart, snapshot each seat with native `goal get` before stopping it. Keep its owner identity and goal id. After native session restore, verify the same goal id, then issue one native `goal resume` only if the saved goal was enabled and active. Issue no resume for a previously paused or goal-less seat. This one-shot owner action is not a timer or sentinel. OMP 18.18 has no startup keep-active setting (`goals/settings.ts:3–39`); RPC startup deliberately pauses active goals (`modes/rpc/rpc-goal.ts:312–316`).

## Release alignment (read only)

The release installer still verifies its profile links without acting on seats:

```sh
python3 skills/fleet-restart/scripts/fleet_restart.py align --home "$HOME" --releases "$HOME/.local/opt/omp-kit/releases" --version X.Y.Z
```

Exit 0 means all observed links point to the existing requested release. Exit 3 means stale links or no links. Use `omp-kit apply plugin` for installation; this reader never repairs links or restarts programs.

## Acceptance

`bun test extensions/kit-goal-keepalive.test.ts -t NATIVESESSION1` exercises an isolated real Tern daemon stopped with SIGTERM and restarted, a paused native OMP goal and an active control. The timer regression test plants a re-arm callback and demonstrates rejection by the same no-rearm oracle. It does not claim an in-place executable replacement after an update.
