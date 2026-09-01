---
"@agent-bundle/rsc-runtime": patch
---

Published-metadata fix: the `react-server-components` keyword is removed from
`packages/rsc-runtime/package.json`. #89 rewrote the `description` in that same
file to state that the package is a React-element result DSL rather than a
React Server Components renderer, but left the keyword asserting the opposite,
so the npm manifest contradicted itself and the registry surfaced the package
against RSC-renderer searches it cannot serve. The remaining keywords —
`agent-bundle` and `mcp` — describe what the package actually is. No runtime
code, export surface, or package name changes; the name is tracked separately.
