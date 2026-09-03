---
"agent-bundle": patch
---

Compile the conventional route tree into an immutable route-graph IR (#93, PR-1) and expose it through `agent-bundle inspect --routes`.

- Discovery covers `src/mcp/<server>/{tools,resources,prompts,apps}/*.{ts,tsx}` (direct children per MCP kind), `src/events/<family>/*.{ts,tsx}` (`event:<family>/<name>`), `src/providers/*.{ts,tsx}` (a separate provider collection), and nested `src/cli/**` / `src/scripts/**` identities. Project ignore rules, private `_`/`.` segments, and `*.d.ts` files are skipped. Modules referenced by explicit `scripts`/`hooks`/`bin`/`lib`/`mcp` configuration are claimed by that declaration and never become routes, so existing layouts (for example `scripts` entries under `src/scripts/`) stay route-free without a migration.
- The graph is deep-frozen, every route carries `config: {}` until the config extractor lands (PR-2), and the graph digest covers project-relative identity only, so equal trees hash equally on every machine.
- Collisions are hard errors, never silent choices: `AB4800` (routed MCP server vs existing entry claim), `AB4801` (`src/cli.ts` vs `src/cli/`), `AB4802` (duplicate route id), `AB4803` (unsafe identity segment), `AB4804` (invalid `routes` mode override). Explicit `routes.servers.<id>` (`generated`/`custom`/`command`/`remote`) and `routes.cli` (`generated`/`conventional`) overrides resolve conflicts; without one, the conflicting surface keeps its discovered routes in `conflict` mode beside the error.
- `discoverProject` attaches the graph only when it is non-empty, `validate` surfaces its diagnostics, and `inspect({ focus: 'routes' })` / `agent-bundle inspect --routes` dump the compiled graph like the bundler focus. `CapabilityState`/`CapabilityEvidence` types ship with the IR; population follows with the host-component work (#100).
