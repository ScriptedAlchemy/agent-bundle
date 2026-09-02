---
"agent-bundle": minor
---

Project generated MCP tools into the framework-owned routed CLI with
`routes.mcpCommands`. The in-house G7 implementation selects tools from the
compiled route graph, merges them through the existing collision checks,
accepts one JSON object through `--input`, enforces `--yes` for tools not
explicitly annotated read-only, and preserves rendered Markdown, JSON,
NDJSON, progress, schema validation, provenance, and the tool request
contract without adding MCPorter or any other dependency.
