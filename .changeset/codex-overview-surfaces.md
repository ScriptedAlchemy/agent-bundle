---
'agent-bundle': patch
---

Publish dated four-state Codex capability rows for the plugins-overview parts under `plugin.overviewSurfaces`, exposed on the `codex` adapter as `mcpUi`, `browserExtensions`, and `scheduledTaskTemplates` and intersected to `unavailable` by the unified `plugin` adapter: optional MCP UI is `degraded` because the compiled MCP server serves `ui://` MCP Apps resources that Codex CLI 0.147.0 does not render, and browser extensions and scheduled task templates are `unavailable` because no plugin manifest or package contract publishes an authoring field for them (#415)
