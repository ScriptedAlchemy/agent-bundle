---
"agent-bundle": patch
---

Raise the dev-server MCP session default request timeout from five seconds
to thirty. A session request can legitimately sit behind an rsbuild compile
or Chrome startup on a small machine, and the old ceiling manufactured
-32001 request timeouts there; thirty seconds stays interactive while
remaining well under the MCP SDK's own sixty-second default. The Workbench
session form now defers to the server default instead of forcing 5000ms,
still validating any explicit entry. Also moves the published toolchain
pins onto the Rsbuild 2.2 line (`@rsbuild/core` 2.2.1, `@rspack/core`
2.2.1, alongside the workspace's react-server-dom-rspack 0.1.0).
