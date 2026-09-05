---
"agent-bundle": patch
---

Execute Workbench route invocations through leased published artifacts by default, including generated CLI projection, event preflight, compiler aliases, persistent project state across rebuilt epochs, and measured runtime telemetry. Select MCP, CLI, event, script, or explicit `unit-render` surfaces independently from the canonical operation id, record the resolved surface, and add diagnostics `AB8239`, `AB8250`–`AB8254`; preserve literal text while rewriting `.js` module specifiers to `.tsx` sources. Report a completed invocation's `outcome` (`success`, `represented-error`, or `process-exit` with the generated bin's exit code) separately from its execution `status` in the `RouteInvocation` envelope, the `route.invocation` project event, and the Workbench route workspace and Trace. (#643)
