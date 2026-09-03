---
"agent-bundle": patch
---

Make Workbench MCP App teardown and project reloads robust under load: the MCP App frame relay default `closeTimeoutMs` is now 5s and the server graceful-close receipt window 35s, so a healthy graceful close is no longer superseded by the force-close timer; project preparation re-reads a config that changed between load and snapshot instead of serving a stale model under a fresh revision; script playground readiness is sequenced through the process tree and PID files are published atomically. (#118)
