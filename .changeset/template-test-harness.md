---
"create-agent-bundle": minor
---

Scaffold the framework test harness with the `mcp-server` template (#103
migration step 8).

A new `mcp-server` project starts with two generated pools beside its plain
module tests, each naming the proof level it carries and each reported
separately, because a pass at one level is never a receipt for another:

- `rstest.route-unit.config.ts` + `tests/route-unit/report-status.test.ts` —
  `testManifest()` for the compiled route inventory and clean compiler
  diagnostics, then `renderRoute` and `expectDocument` over the `report-status`
  route. Real renderer, no artifact, no transport.
- `rstest.projection.config.ts` + `tests/projection/mcp-in-memory.test.ts` —
  `listMcpSurface` and `invokeMcpTool` against the real generated MCP server
  over the SDK's in-memory transport, asserting that the projected
  `structuredContent` is the same value the route rendered. Protocol-contract
  proof only: not a process, not the packed artifact.

`test` now excludes both directories, `test:routes` and `test:projection` run
them, and `check` runs all three pools.

The `minimal` and `cli-tool` templates deliberately keep their plain tests: a
skills-only project compiles no routes, and the `cli-tool` CLI is a
config-declared script bundle rather than a compiled route, so a harness pool
in either would pass without addressing anything. Both READMEs now document
what the pools would prove and the exact wiring to add with the first route
module.
