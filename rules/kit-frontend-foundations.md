---
description: "Read frontend-foundations before a first page shell or a missing decisions file"
condition:
  # First-touch document shell, or an explicit missing-foundations.json signal.
  # Consume the shell literal before scanning for a checklist. Subtract its length
  # so the exclusion still starts at offsets 0..4000 from the original shell start.
  - '<!DOCTYPE html(?![\s\S]{0,3986}(?:frontend-foundations|frontend\.foundations\.json|omp-kit frontend check))'
  - '<html(?![\s\S]{0,3995}(?:frontend-foundations|frontend\.foundations\.json|omp-kit frontend check))[\s>]'
  - 'missing frontend\.foundations\.json'
scope:
  - 'tool:write(**/*.{html,htm,css,scss,jsx,tsx,vue,svelte,astro})'
  - 'tool:edit(**/*.{html,htm,css,scss,jsx,tsx,vue,svelte,astro})'
interruptMode: never
---
**Before the first page shell, or when `frontend.foundations.json` is missing, read the `frontend-foundations` skill.** Decide all 30 foundations before building: run `node <skill>/scripts/init.mjs` if the project has no decisions file, implement each `verifiers/<ID>.mjs`, and ship only after `omp-kit frontend check` passes. Ordinary component, stylesheet, `className`, and `@media` edits do not need this reminder. A write that already names `frontend.foundations.json`, `frontend-foundations`, or `omp-kit frontend check` stays quiet. This reminder firing does not prove the skill was applied.
