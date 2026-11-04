# kit-tool-result-is-not-json — retired static matcher

Retired by ompkit-fp72.120.16.169 (TTSRFRICTION1). The October/November 2026 friction
sample labeled 13 of 13 fires false (Wilson 95% false share 0.772–1.0): every fire was
`JSON.parse` inside a command on a file, an environment variable, stdin, `spawnSync`
stdout or an HTTP/WebSocket response, the compliant form this rule itself recommended.
The token `JSON.parse` cannot tell those inputs from tool-result text, so no narrowing
keeps a measured true fire. Evidence: `docs/evidence/mine-october-2026-11-04/ttsr-friction.json`
in omp-kit (rule `kit-tool-result-is-not-json`). Rollback: the last shipped rule text has
sha256 `e89a5c5f54e34a8f81d7b07e541a62135ab275d346552f5a1366994dcdeb6c8b`.

The measured failure (LOOPGUARD1, ompkit-xa5s.18: one turn repeated a `JSON.parse` of
tool-result text for 2h) stays covered by the runtime loop guard in
`extensions/kit-loop-guard.ts`, which acts on the repeated failure itself.

Guidance kept for that guard: tool-result text carries a `Wall time` trailer and large
output is truncated into an artifact, so it is not JSON. Parse inside the command with jq
(`br show <id> --json | jq '.title'`) or parse the captured stdout of a subprocess.

This marker permits the existing ownership-aware installer retirement.
