---
"create-agent-bundle": patch
---

Make the scaffolded `npm test` test the plugin: in the `mcp-server` and `cli-tool` templates the default `test` script now runs every deterministic pool the project ships — the plain module tests (`test:unit`, new), the route-unit pool (`test:routes`), and the in-memory projection pool (`test:projection`) — each as its own labeled run, so a route that stops rendering or a server that stops registering it fails the ordinary test command while domain tests stay green. `check` is now `build && typecheck && npm test`. The focused scripts remain for a tight loop and take Rstest flags after `--`; packed and native proof stays opt-in. The `minimal` template still ships no route pool; its README shows the same aggregate wiring to add with the first route (#763)
