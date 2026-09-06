---
"agent-bundle": patch
---

Bind Workbench production route invocations to the exact executables the epoch's `agent-bundle.manifest.json` names — `executables.bins[]`, `executables.scripts[]`, `executables.mcpServers[].launch.worker`, the host's `executables.hooks[]` wrapper row and the worker its `routes.events[].execution` selects — before anything runs, instead of listing `*-flight.mjs` candidates and hopping to the next worker on a missing-route error. The binding fails closed: a root without a readable manifest is `AB8250`; a route the manifest does not compile, a hosted event with no wrapper row, or a shared-runtime event with several candidate servers and no named owner is `AB8251`; a canonical submission of an event route whose preflight only a host wrapper can run, or a bound bin or wrapper missing its preparation export, is `AB8252` — the handler is never reached, and a handler failure inside the bound worker never runs another executable (#680)
