---
"create-agent-bundle": patch
---

Make the scaffolded `npm test` test the plugin. In the `mcp-server` template the default `test` script now runs the plain module tests (`test:unit`, new), the route-unit pool (`test:routes`), and the in-memory MCP projection pool (`test:projection`) in turn; in `cli-tool` it runs `test:unit` and the `cli-dispatch`/`script-dispatch` projection pool (`test:projection`). Each pool is its own labeled run, so a route that stops rendering or a command that stops dispatching fails the ordinary test command while domain tests stay green. `check` in both templates is now `build && typecheck && npm test`. The focused scripts remain for a tight loop and take Rstest flags after `--`; packed and native proof stays opt-in. The `minimal` template still ships no route pool; its README shows the same aggregate wiring to add with the first route (#763)
