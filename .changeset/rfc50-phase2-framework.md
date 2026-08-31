---
"agent-bundle": minor
---

RFC #50 Phase 2, framework side. `validate`/`inspect`/`build`/`dev` now
report informational migration nudges (never errors — migrations stay
optional): `AB4730` for a self-connecting stdio MCP entry that a
default-exported factory would upgrade to the framework lifecycle shell, and
`AB4731`/`AB4732`/`AB4733` when `src/cli.ts`, `src/index.ts`, or
`src/mcp/<server-id>.ts` is present but shadowed by explicit configuration.
`agent-bundle inspect --bundler` dumps the synthesized Rslib/Rsbuild
configuration for every generated output — artifact scripts, MCP entries,
hook wrappers, MCP App views, and the `dist/` package build — post-`tools`-
hatch merge with the invariant hook visible, composed by the same functions
the build lowers so the dump cannot drift. `agent-bundle dev` extends the
debounced, serialized rebuild pass to the framework-owned package build:
`dist/` bin/lib outputs rebuild when their provenance-tracked inputs change,
and a package build failure surfaces as one `AB7103` warning without
invalidating the committed artifact epoch. New `docs/diagnostics.md`
reference documents the diagnostic families and the new codes.
