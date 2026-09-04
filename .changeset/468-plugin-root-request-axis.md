---
'@agent-bundle/runtime': patch
'agent-bundle': patch
---

Expose the resolved plugin root on the request context: `(await agent()).plugin` is an observed `{ root, stateRoot }` — `source: 'native'` from an expanded `AGENT_BUNDLE_PLUGIN_ROOT`, `'derived'` from the shell's fallback (the artifact root, or `$PWD/.agent-bundle` for the npm bin) — and conventional providers receive the same value as `plugin` beside `invocation` and `signal` (`AgentProviderContext.plugin`). Every generated shell (MCP entry and Flight worker, routed CLI executable and render worker, hook wrappers) now resolves the anchor once through the new `resolvePluginRoot` export of `@agent-bundle/runtime` and mounts its SQLite state, notice ledger, and lineage journal on that one `stateRoot`, so `plugin.stateRoot` is the directory they use by construction; an unexpanded `${…}` token is treated as unset and reported once on stderr instead of being joined into a path. `renderRoute`, `invokeCli`, `runScript`, and `openInMemoryMcpServer` publish the axis the same way and accept `context.plugin`; `createGeneratedRouteMcpServer` takes `pluginRoot`. `AGENT_REQUEST_STORE_VERSION` is 4. Fixes #468. (#532)
