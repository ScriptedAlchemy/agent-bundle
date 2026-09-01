# my-agent-plugin

A convention-driven MCP server built with [agent-bundle](https://github.com/ScriptedAlchemy/agent-bundle).
The single route `src/mcp/status/tools/report-status.tsx` owns its schemas,
static protocol metadata, execution, and `Agent.*` rendering. Its path creates
the `status` server; no handwritten server factory or server config is needed.

## Commands

```sh
npm run dev
npm run build
npm run check
npx agent-bundle mcp list --server status --target portable --artifact artifact
```

## Layout

- `agent-bundle.config.ts` — plugin identity, targets, and project policy.
- `src/mcp/status/tools/report-status.tsx` — the complete MCP tool route.
- `src/scripts/check-status.ts` — an artifact script with a generated process envelope.
- `src/status.ts` — shared domain logic covered by `tests/`.

The scaffold pins matching `agent-bundle` and `@agent-bundle/runtime` builds.
For preview URL forms, see [Preview packages](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/docs/preview-packages.md).
