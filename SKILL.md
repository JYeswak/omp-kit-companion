---
name: omp-kit
license: MIT
description: "Source-maintainer workflow for changing omp-kit managed rules, cases, manifest, policy and optional extensions in this checkout. Installed users run the compiled omp-kit CLI instead; not for project-local .omp/rules edits."
---

# omp-kit

The source for this rule pack is this checkout, not the installed `~/.agents/rules/`
copies. The installed user surface is the **compiled `omp-kit` executable**;
`installer/install.sh` installs a separately verified local archive without applying
rules or changing a profile. Source-only shell scripts below remain maintainer
tools. Command behavior, release limits, and safe first commands live in `README.md`.

## Rule-change workflow (case first)

1. Add or modify the fire and quiet rows in `cases/cases.tsv` for the rule. A quiet row differs
   from a fire row by one element of the defect. Bash snippets are the raw command; the harness
   wraps them as the `{"command": ...}` JSON that omp matches live.
2. Edit `rules/<name>.md` until the cases hold:
   `bun scripts/ttsr-harness.ts --gate` (G1 compile, G2 wire cases, G3 streamed-prefix sweep).
3. Run `sh scripts/ladder.sh`: in a checkout with `.git`, it derives ignored `MANIFEST.tsv` before the gates; in an installed release, it checks the bundled manifest without mutation. Then it runs G1-G4 and the planted negative. A rule edit needs no paired manifest update. Against an installed local archive, also run `omp-kit test --json` and `omp-kit test --full --json` from an unrelated working directory.
4. Release packaging generates a fresh `MANIFEST.tsv` from `rules/` and includes it in the archive's hashed file set. Never commit `MANIFEST.tsv`.
5. Only for explicit source-rule deployment, if no generated file exists, run `sh scripts/build-manifest.sh`; then run `sh scripts/install.sh --dry-run`, read the plan, then `sh scripts/install.sh`. This does not install the compiled CLI.
6. `sh scripts/doctor.sh` must exit 0 before claiming the local source deployment is ready.
   It checks the rule pack, TTSR policy, router skills, checkers, and extensions; model/provider routing is outside its scope.

Retiring a rule: move it to `retired/`, add a `retired/REASONS.tsv` row with evidence, then run
`sh scripts/ladder.sh` to regenerate the checkout's ignored manifest and validate the pack before installation.

Policy change: edit `policy/ttsr.json`, then `sh scripts/apply-policy.sh --dry-run --include-default`,
then without `--dry-run`, then the doctor.

## Scripts

| Script | Does | Writes |
|---|---|---|
| `scripts/ttsr-harness.ts --gate` | G1 compile, G2 wire cases, G3 prefix sweep through omp's own `TtsrManager` | `reports/` |
| `scripts/e2e-live.sh` | G4 live: real omp, mock model, isolated HOME | temp dirs, `reports/` |
| `scripts/build-manifest.sh [--check|--stdout]` | Derives the rule TSV; default writes ignored `MANIFEST.tsv`, `--check` compares it with `rules/`, and `--stdout` supplies package-time bytes without touching the checkout | `MANIFEST.tsv` (default) |
| `scripts/rule-class.ts <rule.md>...` | Prints `name<TAB>class` from omp's own rule parse; the one classifier the harness, `tests/live/lib.mjs coverage` and the manifest use | nothing |
| `scripts/install.sh [--dry-run] [--target DIR] [--state DIR]` | Refuses a stale manifest; backs up the target to `STATE/backups/<UTC>/`; installs atomically; removes retired rules; lists unmanaged files; idempotent | target, `~/.local/state/omp-kit/` |
| `scripts/apply-policy.sh [--dry-run] [--profiles all\|p1,p2] [--include-default] [--target DIR]` | Sets `ttsr.enabled`, `repeatMode`, `repeatGap`, `disabledRules` in each profile to `policy/ttsr.json` and reads them back; refuses a profile whose cleared disable would re-enable a rule file still in the target | profile `config.yml` |
| `scripts/install-extensions.sh [--dry-run]` | Copies each extension in `policy/extensions.json` to `~/.omp/omp-extensions/` (backs up a differing copy) and appends it to every profile's `extensions` list except `skipProfiles`, reading each list back; idempotent | `~/.omp/omp-extensions/`, profile `config.yml` |
| `scripts/doctor.sh` | Checks target hashes, policy, loaded rules, shadows, router skills, checker selftests, and extension installation; it does not judge model/provider routing. Exit 1 on any RED. Uses omp CLI reads that may migrate settings; back up existing profiles first. | no direct writes; omp CLI may migrate config |
| `extensions/kit-guard-optin.ts` | Loads an opted-in repository's own guard when `.omp/kit-guard.json` is present; does not load in other repos and does not duplicate a repository extension. An opted-in guard that cannot load refuses tool calls. | nothing |
| `extensions/kit-save-guard.ts` | Tracks successful local `write`/`edit`/`ast_edit` paths per session and repo; turn end blocks at most twice for owned dirty paths or this session's unpushed commits, then warns once. Foreign dirty files, ignored paths and `var/agent-tmp/` are excluded; `session_shutdown` remains the warning backstop. Load through a profile extension path, an enabled OMP plugin's `extensions` manifest, or an explicit `omp --extension <path>` invocation. | nothing |
| `extensions/kit-flywheel-guard.ts` | `COMPACTION_REREAD`: on OMP's `session_compact` injects a reminder to reread the AGENTS.md nearest the session cwd and `br show` the in-progress bead. `SELF_CLOSE_REFUSED`: blocks a bash `br close <id>`/`bd close <id>` when the bead's assignee (read-only `br show <id> --json`, 3 s cap) is the caller (`--actor`/`--agent-name`, `BR_ACTOR`, `BR_AGENT_NAME`, `AGENT_NAME`, or the Agent Mail pane identity file); unknown identity, empty assignee or a failed `br show` allow with a warning. | nothing |
| `checkers/check-claim-discipline.sh`, `checkers/check-readiness.sh` | Checkers the rules point at; `--selftest` passes under macOS `/bin/sh` | nothing |

## Traps

- `omp ttsr test` feeds a whole string to `checkSnapshot`; it never sees JSON escaping or streamed
  prefixes. Only the harness G3 sweep and G4 live catch prefix fires.
- Per-rule `repeatMode`/`repeatGap` frontmatter is not parsed by omp 18.2; only the profile policy applies.
- Unset `OMP_PROFILE`, `PI_PROFILE` and `PI_CODING_AGENT_DIR` before `omp --profile`; an inherited
  profile redirects which config omp reads.
- For a throwaway config, give `omp` a command-local HOME pointing at an isolated
  directory and do not inherit profile variables or agent-dir overrides. Use `omp config path`
  to confirm the target before any mutation.
- A project-local `.omp/rules/<name>.md` copy can shadow a global rule; doctor WARNs on drift.
- Backups never live inside the target: any `*.md` there loads as a rule.
- Non-interactive `omp -p` reads piped stdin before it starts: under a harness whose stdin never
  closes (hub `pty: false`) it hangs in `readPipedInput`. Give every scripted omp call `< /dev/null`.
