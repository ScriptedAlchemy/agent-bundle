---
"agent-bundle": minor
---

Add an opt-in MCP conformance lane that builds a generated route server,
adapts its stdio transport to loopback Streamable HTTP, and runs the official
`@modelcontextprotocol/conformance` active suite for specification
`2025-11-25`. The manually dispatched workflow preserves per-scenario runner
artifacts and keeps known gaps in a stale-detecting expected-failure baseline.
