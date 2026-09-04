---
"agent-bundle": patch
---

Add `agent-bundle serve-app <server>/<app>` and `serveApp` in `agent-bundle/api`: serve one built MCP App standalone in a browser, bound to the plugin's own packed MCP server. The server launches exactly as `mcp run` does (same artifact resolution, `.env` layering, and plugin-data root), the App is hosted through the Workbench's MCP App host stack (sandbox proxy, consent authority, bridge) on `127.0.0.1` behind a per-launch token (`AB8003` / `AB8004` on refusal), and the App's tool is called once so it opens populated. `--tool`, `--input`, `--port`, `--profile`, `--allow <capability>`, `--open`, and the `mcp run` environment flags select the binding; `serveApp` returns `{ url, close, closed }` so a plugin's own CLI route can offer an "open the dashboard" command. Fixes #514. (#537)
