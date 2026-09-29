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
3. `sh scripts/e2e-live.sh` (G4: real omp binary, mock model, isolated HOME). Against an installed local archive, also run `omp-kit test --json` and `omp-kit test --full --json` from an unrelated working directory.
4. `sh scripts/build-manifest.sh` to refresh `MANIFEST.tsv`; `--check` must pass.
5. Only for explicit source-rule deployment, `sh scripts/install.sh --dry-run`, read the plan, then `sh scripts/install.sh`. This does not install the compiled CLI.
6. `sh scripts/doctor.sh` must exit 0 before claiming the local source deployment is ready.
   Report a `models` RED separately: it indicates an unresolved profile role or provider,
   not proof that a rule is broken.

Retiring a rule: move it to `retired/`, add a `retired/REASONS.tsv` row with evidence, rebuild the
manifest, install (the installer backs up and removes it from the target).

Policy change: edit `policy/ttsr.json`, then `sh scripts/apply-policy.sh --dry-run --include-default`,
then without `--dry-run`, then the doctor.

## Scripts

| Script | Does | Writes |
|---|---|---|
| `scripts/ttsr-harness.ts --gate` | G1 compile, G2 wire cases, G3 prefix sweep through omp's own `TtsrManager` | `reports/` |
| `scripts/e2e-live.sh` | G4 live: real omp, mock model, isolated HOME | temp dirs, `reports/` |
| `scripts/build-manifest.sh [--check]` | `MANIFEST.tsv`: name, sha256, class, pack; `--check` exits 1 when stale | `MANIFEST.tsv` |
| `scripts/rule-class.ts <rule.md>...` | Prints `name<TAB>class` from omp's own rule parse; the one classifier the harness, `tests/live/lib.mjs coverage` and the manifest use | nothing |
| `scripts/install.sh [--dry-run] [--target DIR] [--state DIR]` | Refuses a stale manifest; backs up the target to `STATE/backups/<UTC>/`; installs atomically; removes retired rules; lists unmanaged files; idempotent | target, `~/.local/state/omp-kit/` |
| `scripts/apply-policy.sh [--dry-run] [--profiles all\|p1,p2] [--include-default] [--target DIR]` | Sets `ttsr.enabled`, `repeatMode`, `repeatGap`, `disabledRules` in each profile to `policy/ttsr.json` and reads them back; refuses a profile whose cleared disable would re-enable a rule file still in the target | profile `config.yml` |
| `scripts/install-extensions.sh [--dry-run]` | Copies each extension in `policy/extensions.json` to `~/.omp/omp-extensions/` (backs up a differing copy) and appends it to every profile's `extensions` list except `skipProfiles`, reading each list back; idempotent | `~/.omp/omp-extensions/`, profile `config.yml` |
| `scripts/doctor.sh` | Checks target hashes, policy, loaded rules, shadows, router skills, checker selftests, model roles/quota, and extension installation; exit 1 on any RED. Uses omp CLI reads that may migrate settings; back up existing profiles first. | no direct writes; omp CLI may migrate config |
| `extensions/kit-guard-optin.ts` | Loads an opted-in repository's own guard when `.omp/kit-guard.json` is present; does not load in other repos and does not duplicate a repository extension. An opted-in guard that cannot load refuses tool calls. | nothing |
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
