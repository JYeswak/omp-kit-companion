### Fixed

- On native OMP hosts (18.17 and later), the spawn-model policy is enforced only by the `before_subagent_spawn` check on the patterns OMP resolves; the task-call path, whose settings-source import a compiled host cannot resolve and which refused every background agent, now runs on legacy hosts only. Opus-class children of chief/director seats are still refused. (ompkit-xa5s.45, SPAWNNATIVE1)
