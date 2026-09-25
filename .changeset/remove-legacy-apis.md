---
"agent-bundle": minor
"@agent-bundle/runtime": minor
"rsc-markdown-stream": patch
---

Remove `plugin.version` and mismatch diagnostic AB4008 (retired); the key now fails with AB4001, and `AgentBundlePluginConfig` drops its index signature, so unknown `plugin.*` keys are type errors. Remove the `agent-bundle install --force` alias (use `--replace`); the emitted `install.mjs` exits 2 on `--force` without `--uninstall`. Tool routes must default-export `defineTool(...)`; split named tool exports fail with AB4810. Route App `config.template` resolves only from the route module, else AB4827. Remove `ServedApp` and generated CLI `isTty`. `@agent-bundle/runtime` removes the `Hook`/`Mcp` lowerers, `createRscRequestContext`, `RscRequestContext`, `AgentDocumentSnapshot`, and the `McpResultProps`, `McpDataProps`, `McpResourceLinkProps`, and `McpEmbeddedResourceProps` types. `rsc-markdown-stream` drops its React 18 element, provider, and dispatcher paths (#810)
