### Fixed
- Heavy runtime limits now default to sourced, exact-label budgets in `config/heavy-labels.json`, with no runtime limit for undeclared labels; `load.json` label budgets and `--max-runtime` override the table. The former global `default_runtime_s` no longer applies.
- Runtime expiry names its budget and source (flag or label table) and retains exit 124, separate from admission deferral 75.
