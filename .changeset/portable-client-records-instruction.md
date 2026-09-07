---
"agent-bundle": patch
---

Record the three instruction-and-skill hosts in the pinned portable capability table: Swival reads the emitted `skills/` tree in place through `--skills-dir` and reads the emitted `mcp.json` only when it is named with `--mcp-config`; JetBrains Junie reads the same tree once it is registered with `--skill-location` or `skill-locations`; and Cascade (Devin Desktop) reads a skill directory copied into one of its own roots, with its MCP configuration kept in `~/.codeium/windsurf/mcp_config.json` and its Devin Local agent profile deferring to the separately recorded Devin CLI. Each record names the manifest, MCP, placeholder, and hook surfaces these hosts do not read, with the dated page that says so. (#727)
