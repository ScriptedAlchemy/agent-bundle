---
"agent-bundle": patch
---

Accept a re-exported default component in the route contract check (`AB4810`): `agent-bundle validate`, `inspect`, and `build` now follow `export { default } from '../shared.tsx'` and `export { Page as default } from` through relative modules (including `.js` specifiers for `.ts`/`.tsx` sources and re-export chains) and judge the default export in the module that declares it, so one tool can be placed on two generated MCP servers with a second route module that carries only its own `config` and re-exports the component and schemas from the first. A sync component behind the re-export is still `AB4810`, and the message now names the re-exported module; a default re-exported from a package the check cannot read is accepted and verified when the route loads. The same resolution applies to the layout (`AB4830`), provider (`AB4940`), event-route, routed-CLI, and bin-shared rendered-script (`AB4737`) contract checks. Fixes #446 (#524)
