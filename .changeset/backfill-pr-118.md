---
"agent-bundle": patch
---

Make Workbench MCP App teardown and project reloads robust under load: raise the MCP App frame relay default `closeTimeoutMs` to 5s and the dev-server graceful-close receipt window to 35s so a healthy graceful close is no longer superseded by the force-close timer, and re-read a project config that changed between load and snapshot instead of serving a stale model under a fresh revision. (#118)
