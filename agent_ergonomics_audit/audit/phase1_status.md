# Phase 1 — supplied runtime inventory merged

Consumer: ERGO1 phases 2–4 scoring and recommendation synthesis. This evidence replaces stale claims that the wrapper cannot execute; retain for this audit and supersede on the next full inventory.

- Supplied `var/agent-tmp/aergo-p1c.28881/runtime-inventory.jsonl`: 720 rows (76 verb, 644 flag); no inventory rerun.
- 555 unique canonical surfaces receive `runtime.status: HELP_VERIFIED`; duplicate walker records merge into the same descriptor.
- All 2,504 pre-existing IDs preserved; 2 previously absent runtime flags added (`flag__heavy__max-runtime`, `flag__send__control`): total 2,506.
- Match uses kind/subtree/name. Walker verb subtree includes the verb itself; canonical source subtree is its parent. Wrapper root `omp-kit-src` maps to existing `verb__omp-kit`. No source metadata is replaced with runtime nulls.
- Remaining 1,951 surfaces retain UNVERIFIED with precise class-specific reasons. Help coverage does not establish canonical-task success, flag acceptance, safety, errors, JSON contracts, or determinism.
- Full descriptor mapping and counts: `partial/runtime_inventory_merge.json`. Flag excerpts are null in supplied records; their parent help exit is recorded without inventing missing text.

No source/test edits, no commits, no builds/lint/tests/formatters. Audit artifacts only.
