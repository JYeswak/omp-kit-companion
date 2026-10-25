# Fetch-backed source citations

`scripts/sources.py` uses Python 3.9+ and the standard library. It proves that a fetched page contained each supplied quote after Unicode, punctuation and whitespace normalization (case-insensitive matching). Stored body/text hashes and excerpt hashes preserve the observation. It does **not** prove that the claim follows from the quote, that the page is authoritative, or that it has not changed. A non-author must read the claim against its quotes; `verify` checks current availability, not faithfulness.

## Commands

```sh
python3 scripts/sources.py add --url https://example.org/article --quote 'Exact source words' --claim 'Claim supported by these words' --id article
python3 scripts/sources.py check plan.md --json
python3 scripts/sources.py verify --ids article
```

`add` fetches with a 30-second socket timeout and an 8 MiB body limit. Every quote must match before anything is written. HTML script/style content is excluded; PDFs require optional `pdftotext` on PATH, run with a deadline and output cap. Duplicate IDs require `--replace`. Rows default to `docs/research/sources.jsonl`; `--registry`, `--repo` and `--by` override location/attribution.

`check` is offline. It refuses memory citations (`[standard reading]` or `cited from memory`), unknown `[src:ID]`, unregistered HTTP(S) links, altered excerpts, and registered citations without a valid application row (`APPLICATION_MISSING`). Registered original and redirect URLs both count; fragments, trailing slashes and HTTP versus HTTPS do not distinguish links.

Every registered source cited by `[src:ID]` or URL in a checked document requires a row in the repo's `docs/research/APPLICATION.md`. Use a pipe-delimited table with `Source`, `Decision`, `Artifact`, `Status`, and `Gap bead` columns (`Decision it changed` and `Applied by (artifact)` are also accepted headers). Source cells accept exact IDs, backtick-wrapped IDs, or `[src:ID]` markers, comma-separated; wildcard IDs do not grant coverage. Cells cannot contain pipe delimiters. Decision must be nonempty; Artifact must name a `path:line` (positive line number) or bead ID. Status must be exactly `cited`, `procedure`, `built-not-wired`, `applied`, or `enforced`; `cited` additionally requires a gap bead. Example:

```markdown
| Source | Decision | Artifact | Status | Gap bead |
|---|---|---|---|---|
| `article` | Use the quoted method | plan.md:12 | cited | ompkit-663q4 |
```

Only exact normalized `UNREGISTERED_LINK` URL identities can be grandfathered, per file. Seed `.omp/sources-baseline.json` with `check plan.md --write-baseline`; subsequent writes may only remove identities, never substitute a new URL. Format: `{"plan.md": {"UNREGISTERED_LINK": ["https://example.org/old"]}}`. Fixing a grandfathered finding passes. Pass the entire opted-in document set when updating a baseline. `--baseline PATH` selects another baseline. Nonempty legacy count baselines fail closed with `INVALID_BASELINE`: counts cannot recover which links were grandfathered. Review the original baseline revision's links and explicitly replace each count with its normalized URL list; do not seed from newly substituted links. An empty `{}` remains valid. Memory, unresolved-source, application and excerpt-integrity findings never have an allowance.

`verify` re-fetches every row (or `--ids ID ...`) and reports `OK`, `QUOTE_MISSING` or `FETCH_FAILED`; any failure exits 1. Unsupported PDF content on `add` exits 2.

## Staged gate

Opt in by creating `.omp/sources.toml` containing one key:

```toml
globs = ["*.md", "docs/**/*.md"]
```

The hook installer installs `52-omp-kit-staged-sources` with its Python helpers. It checks staged matching Markdown blobs, using the staged registry, application table and baseline, so unstaged corrections do not pass a commit. A baseline already in HEAD may only shrink by URL identity. Without the config the member is a no-op. No network request runs during commit.
