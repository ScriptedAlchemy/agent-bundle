---
"@agent-bundle/runtime": patch
"agent-bundle": patch
---

Accept an optional `now` time source on `createAgentRenderEventSequence` and run the render dispatcher's `maxElapsedMs` deadline — the event sequence's elapsed check and the pending-boundary deadline sleep — against one injectable clock, so a Flight render's deadline can be driven by a test clock instead of wall-clock time. Add a `timers` option (`McpProbeTimers`) to the Workbench MCP probe service so its total-budget timeout, bounded teardown wait, and detached plugin-data cap can be scheduled without real timers; production behavior is unchanged. (#PR)
