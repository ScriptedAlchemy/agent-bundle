---
"agent-bundle": minor
---

Derive Workbench navigation and its route catalog from the compiled route graph
instead of artifact counts alone (#105 stage 1).

The dev server exposes one new read-only route, `GET /api/routes/manifest`,
which projects the prepared project's existing `CompiledRouteGraph` into a
browser-safe DTO: route id, kind, project-relative source, provenance, a
flattened static `config` summary, MCP server surfaces with their packaging
mode, the generated CLI command surface with its argv projection, conventional
scripts, context providers, the graph digest, and the graph's own diagnostics.
There is no second discovery pass — the manifest is a projection of the compiler
pass the build, inspect, and test harness already share.

The Workbench gains a Routes page under **Build** that renders that catalog
grouped by server and by project surface, and reports whether the manifest
matches the published build or is ahead of it. Hooks, MCP playground, and
Playground now open when either the artifact catalog or the compiled graph
declares the surface, so a routed project no longer needs configuration to reach
its own pages. Every existing page is preserved: an absent or refused manifest
degrades only the Routes page.
