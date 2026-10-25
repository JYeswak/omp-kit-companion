# Fetch-backed source citations

`scripts/sources.py` uses Python 3.9+ and the standard library. It proves that a fetched page contained each supplied quote after Unicode, punctuation and whitespace normalization (case-insensitive matching). Stored body/text hashes and excerpt hashes preserve the observation. It does **not** prove that the claim follows from the quote, that the page is authoritative, or that it has not changed. A non-author must read the claim against its quotes; `verify` checks current availability, not faithfulness.

## Commands

```sh
python3 scripts/sources.py add --url https://example.org/article --quote 'Exact source words' --claim 'Claim supported by these words' --id article
python3 scripts/sources.py check plan.md --json
python3 scripts/sources.py verify --ids article
```

`add` fetches with a 30-second socket timeout and an 8 MiB body limit. Every quote must match before anything is written. HTML script/style content is excluded; PDFs require optional `pdftotext` on PATH, run with a deadline and output cap. Duplicate IDs require `--replace`. Rows default to `docs/research/sources.jsonl`; `--registry`, `--repo` and `--by` override location/attribution.

`check` is offline. It refuses memory citations (`[standard reading]` or `cited from memory`), unknown `[src:ID]`, unregistered HTTP(S) links, and altered excerpts. Registered original and redirect URLs both count; fragments, trailing slashes and HTTP versus HTTPS do not distinguish links.

Only `UNREGISTERED_LINK` counts can be grandfathered. Seed `.omp/sources-baseline.json` with `check plan.md --write-baseline`; subsequent writes may only lower existing counts. Pass the entire opted-in document set when updating a baseline. `--baseline PATH` selects another baseline. Memory, unresolved-source and excerpt-integrity findings never have an allowance.

`verify` re-fetches every row (or `--ids ID ...`) and reports `OK`, `QUOTE_MISSING` or `FETCH_FAILED`; any failure exits 1. Unsupported PDF content on `add` exits 2.

## Staged gate

Opt in by creating `.omp/sources.toml` containing one key:

```toml
globs = ["*.md", "docs/**/*.md"]
```

The hook installer installs `52-omp-kit-staged-sources` with its Python helpers. It checks staged matching Markdown blobs, using the staged registry and baseline, so unstaged corrections do not pass a commit. A baseline already in HEAD may only shrink. Without the config the member is a no-op. No network request runs during commit.
