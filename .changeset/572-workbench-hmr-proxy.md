---
'agent-bundle': patch
---

Let the documented contributor HMR loop complete a Workbench session: `agent-bundle dev --workbench-dev-origin <origin>` (repeatable; `startDevServer({ workbenchDevOrigins })`) makes the foreground server accept session bootstrap, mutation, and project-event requests whose `Origin` is that explicitly listed loopback Rsbuild dev-server origin instead of answering `AB8003`, and `GET /api/project/session` reports the list as `devOrigins` so the Workbench UI served from that origin accepts the session. Values that are not loopback `http(s)` origins are refused before the server starts (`startDevServer` rejects with `AB8000`); without the flag the same-origin guard is unchanged, and the proxy never rewrites `Origin`. (#572)
