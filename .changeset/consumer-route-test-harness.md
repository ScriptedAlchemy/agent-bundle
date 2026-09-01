---
"agent-bundle": minor
---

Ship the consumer route test harness as two new public subpaths.

`agent-bundle/rstest` exposes `agentBundleRstest()`: it runs the same
route-graph compilation the build runs — one compiler pass, through the shared
project service, with no artifact build — and returns a plain Rstest
configuration object that registers the compiled test manifest and the route
loaders, resolves React under the `react-server` condition, and selects the
automatic JSX runtime. `agent-bundle/test` exposes `renderRoute`, which executes
a route by compiled id or by module through the real final-only Flight
dispatcher and the real request store and resolves to the final Agent Document,
plus `expectDocument` matchers over the Agent Document contracts
(`toHaveStatus`, `toContainMarkdown`, `toContainText`, `toHaveValue`,
`toHaveError`, `toHaveNodeKinds`) and `testManifest()` for iterating the route
inventory in process. Failures name the route id, target kind, and module
provenance.

`@rstest/core` and `react` are optional peer dependencies: a project that does
not test routes installs neither, and neither becomes a runtime dependency.
`@agent-bundle/runtime` stays undeclared and is loaded through a dynamic
import, matching how the generated entry shells already import it from the
consumer project.

This is the route-unit proof level, labeled as such. Transport, packed, and
browser levels are not included and are not scaffolded.
