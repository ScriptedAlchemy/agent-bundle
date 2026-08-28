---
"agent-bundle": minor
---

Add a first-class `cursor` compile target. The standalone Cursor artifact
carries the `.cursor-plugin/plugin.json` manifest with explicit document
pointers, Cursor's auto-discovered typeless `mcp.json`, and shared skills,
scripts, and assets, all validated against the pinned Cursor schemas. The
unified `plugin` bundle now shares one Cursor lowering with the new adapter,
and the target MCP runtime reads shape-discriminated server documents.
