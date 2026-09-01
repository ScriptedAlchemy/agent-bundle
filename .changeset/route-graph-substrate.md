---
"agent-bundle": patch
---

Add the #93 route-compiler substrate: deterministic discovery of route
modules under the conventional roots (`src/mcp/<server>/{tools,resources,prompts,apps}/`,
`src/events/`, `src/providers/`, `src/cli/`, `src/scripts/`) compiled into an
immutable, consumer-invisible route graph, a new `AB480x` diagnostic family
for mode conflicts (route directory versus entry-file conventions, duplicate
route ids, unsafe route names), and an `inspect --routes` focus that lists
the discovered graph. Modules explicit configuration already claims are never
routes, so existing layouts keep working unchanged; nothing generates entries
or registries from the graph yet.
