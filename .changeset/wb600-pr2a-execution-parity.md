---
"agent-bundle": patch
---

Execute Workbench route invocations through leased published artifacts by default, including generated CLI projection, event preflight, compiler aliases, persistent epoch state, and measured runtime telemetry. Add explicit `unit-render` preview mode and diagnostics `AB8239`, `AB8250`–`AB8252`; preserve literal text while rewriting `.js` module specifiers to `.tsx` sources. Report a completed invocation's `outcome` (`success`, `represented-error`, or `process-exit` with the generated bin's exit code) separately from its execution `status` in the `RouteInvocation` envelope, the `route.invocation` project event, and the Workbench route workspace and Trace. (#643)
