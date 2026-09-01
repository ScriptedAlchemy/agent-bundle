---
"agent-bundle": patch
---

Discover plain `src/scripts/` modules as conventional script entries (#102
stage 1). An unclaimed plain `.ts` module directly under `src/scripts/` now
compiles through the existing explicit-`scripts` pipeline to
`scripts/<name>.mjs` in every selected target artifact, carrying
`provenance.kind: 'conventional'`; explicit `scripts` configuration keeps
claiming its files. Rendered (`.tsx`/`.jsx`), nested, and
identity-conflicting script routes fail source validation with the new
`AB4807`–`AB4809` diagnostics instead of building silently.
