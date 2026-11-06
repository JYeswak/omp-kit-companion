---
status: current
---

# Static gate wiring audit

The pre-push adapter audits the pushed commit's archive, never the shared working tree. Configure `.omp/gate-wiring.json` in each adopting repository. Without it, the hook prints `SKIP gate-wiring` and makes **no wiring judgment**. The kit does not invent a repository's thresholds or grandfather existing debt.

## Policy version 1

All five fields are required; unknown or duplicate keys fail:

| Field | Value |
|---|---|
| `version` | Integer `1` |
| `gate_globs` | Nonempty list of repo-relative glob patterns defining gate files; discovery includes newly added matching files |
| `entrypoints` | Nonempty list of existing repo-relative shell chain roots |
| `thresholds` | Object with nonnegative integer `unwired`, `unreachable`, and `expired_quarantine` maxima; booleans are invalid |
| `quarantines` | Object keyed by gate path; each record requires nonempty `owner`, `reason`, and `expires_on` (`YYYY-MM-DD`) |

Patterns use Python `fnmatchcase` on complete POSIX relative paths: `scripts/check-*.sh` also matches subdirectories. Paths cannot be absolute, contain `..`, or use backslashes. Symlinks are not inventory or entrypoints. Policy paths cannot escape either archive.

A quarantine exempts its discovered gate from unwired/unreachable counts until its expiry. It expires after the named UTC day, not at its beginning. Expired records count in `expired_quarantine`, even if their gate is wired. Removing a gate removes its quarantine finding. Each maximum is inclusive; exceeding it refuses the push and names every gate in that category. There is no automatic baseline rewrite.

The **base commit's** checker and policy judge the candidate archive. A candidate cannot raise its own maximum, narrow discovery, extend its own quarantine, or delete the policy to clear that push. Initial adoption uses the candidate's checker/policy when the base has none. Subsequent policy changes take effect only after passing the incumbent policy. Candidate checker changes remain subject to the adapter's base-gate qualification.

Removing a quarantine immediately restores that gate's wiring check, so fixing and reconnecting a check can retire its exception without deleting the gate. Retained exceptions use the earlier incumbent/candidate expiry. Newly introduced expired exceptions are checked immediately; a new future exception cannot hide existing unwired debt on its introduction push. Both policy files must validate.

## Reachability contract

This is a bounded **static literal shell invocation graph**, not proof that a check executes successfully on every runtime branch. It calls no hosted-CI API and executes none of the discovered gates.

- Inventory excludes `.git`, `node_modules`, `var`, `dist`, `build`, `vendor`, and `coverage`. Gate globs apply to remaining regular files.
- Shell consumers are `.sh` files plus configured entrypoints. Gate bodies are terminal checks, not chain roots.
- Python standard-library `shlex` in POSIX mode owns quotes, escapes, and comments. The supported chain grammar is straight-line commands separated by newlines or single semicolons; literal direct paths, interpreter script arguments, `exec`, `command`, `env`, and leading assignments are recognized. Paths resolve from the repository root. Write explicit paths such as `sh scripts/check-required.sh`.
- An invocation under an entrypoint, directly or through another literal shell wrapper, is statically reachable. A gate with consumers only in disconnected wrappers is `unreachable`; a gate without a recognized invocation is `unwired`. Comments, `echo`, and arbitrary string arguments do not count.
- `exit`, `return`, and `exec` stop subsequent edges. Compound shell, pipelines, boolean operators, redirection/heredocs, dynamic expansions and malformed quoting in a reachable wrapper refuse with `invalid`, rather than certify an incomplete graph. Unsupported disconnected wrappers cannot establish wiring. Non-shell mediators (including JavaScript, Python, package-script aliases, and workflow YAML) are not traversed.
- Runtime command success, shell options, installed hook freshness, and trigger conditions are not certified. Configure roots that are actually invoked by the repository's hook chain; merely listing a path is not runtime installation proof.
- Admission bounds: 20,000 inventory files, 1 MiB per input file, 16 MiB cumulative shell-source bytes. Exceeding a bound refuses; inputs are never silently truncated.

## Run and repair

Run `python3 -B scripts/gate-wiring.py --repo .` from the kit checkout to inspect an adopting repo (replace `.` with its path). For an archived candidate with incumbent policy, add `--policy-root BASE_ARCHIVE`.

Exit codes: `0` configured thresholds satisfied **or explicitly not configured**; `1` thresholds exceeded; `2` invalid policy, missing entrypoint, unsupported reachable shell, unreadable input, or admission limit. Distinguish `GREEN` from `SKIP` in output.

Repair unwired gates by adding real literal invocations to the chain. Connect orphan wrappers to a real entrypoint. Remove obsolete gates or fix quarantined checks; do not raise maxima or extend dates merely to clear a refusal. For unsupported mediators, provide an actual supported chain or extend the parser with executable controls before claiming reachability.

`sh tests/cli/gate-wiring.test.sh` exercises real local bare-origin pushes through the adapter, including unwired, disconnected-wrapper, expired-quarantine and candidate-policy-weakening refusals, paired passing controls, and checker boundary cases. These fixtures carry minimal unrelated checker contracts; they do not certify the full production push chain or fleet rollout.
