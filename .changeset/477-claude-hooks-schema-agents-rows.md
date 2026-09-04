---
"agent-bundle": patch
---

Re-pin the Claude Code `hooks.schema.json` to the documented hook handler contract so a `claude.nativeHooks` document may use every handler type (`command`, `http`, `mcp_tool`, `prompt`, `agent`), the per-type fields (`args`, `async`, `asyncRewake`, `shell`, `url`, `headers`, `allowedEnvVars`, `server`, `tool`, `input`, `prompt`, `model`, `continueOnBlock`), the common `if`, `once`, `statusMessage`, and `timeout` fields, and all 33 documented events, each closed to the handler types the reference allows for it; the compiler still emits shell-form `command` handlers only. Update the `claude` host's agents capability rows with `color`, `initialPrompt`, and `experimental.cacheTtl`, record that `permissionMode`, `mcpServers`, and `hooks` are ignored for plugin subagents, pin the anchored `^<plugin>:<agent>$` `agent_type` matcher note, and bump the Claude `adapterRevision` to `1.26.0`. (#488)
