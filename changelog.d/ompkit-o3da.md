- GH2: one shared CI poller (ETag/304, Retry-After, cache with fetched_at+source per row); `ci status` reads only the cache.
- GH2 red-main fix: localhost fixtures bypass the proxy (`NO_PROXY`/`no_proxy` gain 127.0.0.1 + localhost) — ubuntu runners carry proxy vars and Bun routes 127.0.0.1 through them, refusing instantly. Reproduced with a poison proxy (same 3 ERRORs), green with the bypass.
<!-- release coverage: (commit 41662be) -->
