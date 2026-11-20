---
description: "Use the frontend-foundations skill before building or changing web UI"
condition:
  - '\bcomponent\b'
  - '\bstylesheet\b'
  - '\blanding page\b'
  - '\bresponsive\b'
  - '\bbreakpoint\b'
  - '</(?:div|section|main|button|form)>'
  - '\b(?:useState|className)\b|@media\b'
scope:
  - 'tool:write(**/*.{html,htm,css,scss,jsx,tsx,vue,svelte,astro})'
  - 'tool:edit(**/*.{html,htm,css,scss,jsx,tsx,vue,svelte,astro})'
interruptMode: never
---
**Before building or changing web UI (pages, components, styles, motion, dashboards, tokens), read the `frontend-foundations` skill first.** Decide all 30 foundations in `frontend.foundations.json` before building: run `node <skill>/scripts/init.mjs` in the project if it has no decisions file, implement each `verifiers/<ID>.mjs`, and ship only after `omp-kit frontend check` passes — it runs every verifier itself, binds results to the build and decisions digests, reports judge items as NEEDS_JUDGE (never PASS), and with `--require-approval` demands an owner approval naming those digests. Preview with `node <skill>/scripts/build-reference.mjs` (overlay optional). Show the owner the rendered page. This reminder firing does not prove the skill was applied.
