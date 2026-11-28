### Changed
- `next --role worker|director --json` returns compact fact summaries by default; `--full-facts` explicitly includes complete adapter payloads without changing the selected next action.
- `capabilities --json --command NAME` narrows discovery to requested commands (repeatable or comma-separated); help and robot guidance teach targeted discovery.
- Command typo hints count adjacent transpositions as one edit, rank a unique transposition first while naming tied substitutions, and never run the suggested command. Unknown `handoff` explains the existing landing and verification workflow.
- Scoped help no longer advertises root-only `--info`; discovery marks it standalone. Uninstall guidance names supported read-only status inspection instead of an undeclared preview flag.
- DCG denials include bounded reason and explanation from DCG without exposing approval instructions or changing the decision. Fleet override reasons retain their rule grouping.
- The enabled DCG bridge evaluates the Bash tool's target directory instead of the session's starting directory, and refuses when its DCG executable is unavailable.
- Scratch, stale-worktree, and recognized hashline edit refusals name the next inspection or recovery command instead of leaving callers with a bare denial.
