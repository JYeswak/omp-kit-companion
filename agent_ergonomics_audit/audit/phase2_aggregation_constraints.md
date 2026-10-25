# Aggregation execution constraint

Installed skill `scripts/aggregate_scores.sh:239` uses `mktemp /tmp/aerg_aggregate.XXXXXX` whenever its output already exists. Running the full multi-surface aggregation would violate the user's explicit no-/tmp rule after the first row, regardless of TMPDIR. It was inspected but not executed.

Independent source-only scorer partials remain evidence of provisional rubric judgments, not runtime verification. A direct in-memory median aggregation may preserve those judgments and enable artifact validation without creating forbidden temporary files; that is not a claim that the requested shell aggregator ran. The shell aggregator and runtime scoring exit criteria remain unfulfilled until a compliant canonical tool is available.
