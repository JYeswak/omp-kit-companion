---
status: current
---

# Commit import hooks

## Reviewed installed-template imports

The commit-import gate parses changed TypeScript-family source with
the host TypeScript compiler API, then resolves real relative import/export,
type-only and literal dynamic-import specifiers against that commit's tree.
Quoted examples, comments, regex literals, JSX text and template text are inert;
imports inside template expressions remain active. Packaging templates may also
resolve through an explicitly reviewed installation projection; a template
directory is never exempted.

The gate requires host Node and a globally installed `tsc`, with its compiler
library outside the target repository. It never evaluates project source or
loads project configuration. `--parser-info --repo "$REPO"` reports the compiler
version, library path and SHA-256. Installation checks this prerequisite before
effects; read-only installer `--check` reports stale/unavailable tooling as rc3.
Missing tooling, syntax/UTF-8 errors or parser admission limits refuse rather
than silently fall back to text matching. Limits are 4 MiB source, 250,000 AST
nodes, depth 4,096, 4,096 specifiers and 1 MiB extracted output; these are not an
OS memory or execution-time sandbox.

The project keeps one committed JSON dictionary of installed destination paths
to sources relative to its template root, consumed by its actual installer.
A separately reviewed declaration has these fields:

| Field | Meaning |
|---|---|
| `schema_version` | Integer `1` |
| `projections` | Nonempty list of reviewed installation projections |
| `map_path` | Repository-relative path to the committed JSON dictionary |
| `map_sha256` | SHA-256 of that dictionary's exact committed bytes |
| `source_root` | Repository-relative root for dictionary source values |
| `install_root` | Repository-relative installed root, such as `.omp` |

Each projection must explicitly include the importing source. Every installed
destination for that source must resolve the import to a regular source blob in
the same commit. Unreferenced generated outputs do not need to be committed.
This projection path requires Python 3; unavailable or invalid data is a refusal,
not a fallback permission.

Read-only validation uses the declaration's externally reviewed digest:

```sh
sh scripts/check-commit-imports.sh \
  --validate-template-import-map "$DECLARATION" --sha256 "$REVIEWED_SHA"
```

Only an authorized repository operator activates the hook configuration:

```sh
sh scripts/install-commit-msg-bead.sh \
  --template-import-map "$DECLARATION" \
  --template-import-map-sha256 "$REVIEWED_SHA" "$REPO"
sh scripts/install-commit-msg-bead.sh --check \
  --template-import-map "$DECLARATION" \
  --template-import-map-sha256 "$REVIEWED_SHA" "$REPO"
```

The installer copies the declaration and its digest into the configured Git
hooks directory under `hooks.d/pre-commit/template-import-map.{json,sha256}`.
Reinstallation without these options preserves existing reviewed data.
Candidate mapping edits cannot activate themselves: changed mapping bytes need
a new reviewed declaration. A matching digest proves integrity, not the quality
or authority of its review. Source support is not live activation; historical
commits without a matching reviewed projection can still fail.

