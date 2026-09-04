---
'@agent-bundle/runtime': patch
'agent-bundle': patch
---

Let a rendered route declare its own render budget: `config.render: { maxElapsedMs }` on `ToolConfig`, `ResourceConfig`, `PromptConfig`, and `CliRouteConfig` raises (or lowers) the 60-second `maxElapsedMs` of that route's render session, validated at build time as a positive integer of milliseconds up to `MAX_ROUTE_RENDER_ELAPSED_MS` (24 hours, exported from `agent-bundle`) — `AB4835` otherwise, including on a plain `.ts` command, which has no render session. The generated MCP server applies it per `tools/call`, `resources/read`, and `prompts/get` while still forwarding every progress report as `notifications/progress`; the compiled command carries it into the generated CLI executable (`CompiledCliCommand.render`, inherited by `routes.mcpCommands` projections); `renderRoute` and `openInMemoryMcpServer` apply it over the `limits` a test passes as the dispatcher's base. `AgentRenderDispatch.limits` layers per-dispatch limits over `createAgentRenderDispatcher`'s. Defaults are unchanged. Fixes #454. (#526)
