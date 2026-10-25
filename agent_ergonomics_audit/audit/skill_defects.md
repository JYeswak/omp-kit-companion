# Skill defects observed during ERGO1 completion

## Intent runner safety metadata and skip exit codes

Source: installed skill `scripts/run_intent_corpus.sh:187-200`. `safe_to_run=false` causes a skip only when `mutates=true`; it is not a general execution allowlist. At line193 `exit_code=0` is initialized before that skip. A skipped row can therefore contain exit0 even though no process ran. Audit mitigation: conservatively mark unsafe candidates as mutating/not-safe before executing the stock runner, then normalize skipped exit codes to null with explicit reasons. Null is not a successful process exit. Never use --apply/--yes; no mutation without a documented explicit plan/dry-run.

## Intent runner outcome classifier overclaims inference

Source: `scripts/run_intent_corpus.sh:169-173`. Any exit0 with nonempty output falls through to `inferred_and_acted`, without checking whether intended work occurred. An ignored misspelled env variable followed by version/help output is not proven intent recovery. Lines146-166 also accept generic help pointers as `useful_hint`, weaker than Phase3's exact-correction requirement. Audit mitigation: preserve raw script classifications and captured streams/exits, report semantic limitations separately; never claim generic success proves recovery.

Additional executed-script failures, if present, are recorded with full producer output and exact source location in the owning phase documents. No skill source was changed in this task.

## Honest skipped exits conflict with bundled schema

`assets/schemas/intent_inference_corpus.schema.json:25` permits only integer exit_code. A skipped command has no process exit and must be null under this audit's explicit user contract. Nulls are retained, not changed to fictitious zeros to satisfy that schema. This is distinct from scorecard validation.

## Naive generator coverage limits

`scripts/generate_intent_corpus.sh:244-245` treats a subtree without a space as top-level; the source inventory represents nested `lessons add` with subtree `lessons`, so a root alias may be generated for a nested operation. Mutating alias candidates remain skipped.

`scripts/generate_intent_corpus.sh:303` excludes env prefixes shorter than four characters, including OMP and XDG. Generated G entries therefore do not cover all37 source env surfaces.

The first generation attempt exited5 after categoryD. A later diagnostic invocation completed with exit0; inventory was being rewritten concurrently. That first failure is not established as a remaining skill serialization bug. Preserve both producer records rather than claiming either no failure or a proven root cause.

## Full aggregation exceeds the per-script bound

The full `scripts/aggregate_scores.sh` invocation reached the600-second deadline after writing2,317/2,506 rows, with empty stdout/stderr. Complete producer record: `partial/phase2_aggregate_output.json`. This is not a successful full invocation. At lines239–244, every new row filters/rewrites the growing entire output file; the script also launches multiple jq processes per surface. The remaining189 surfaces are completed through the same canonical script's explicit surface-ID mode, each independently bounded. No scores or aggregation algorithm are replaced to force a pass.

Performance authority: only the deadline and partial row count were measured. Repeated jq launches/output rewrites are source-observed candidate costs, not a profiled hotspot ranking. No speedup, comparative benchmark or skill optimization is claimed; this audit does not authorize skill edits.
