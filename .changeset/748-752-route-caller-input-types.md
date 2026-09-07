---
"agent-bundle": minor
"create-agent-bundle": patch
---

Type route callers by schema input and route components by schema output in the generated `.agent-bundle/routes.d.ts`: `createAppClient().call`, `onToolInput`, `renderRoute`, `invokeMcpTool`, and the contract matrix accept what a caller sends (a `.default()`ed field is optional, a `.transform()`ed field is spelled as the wire carries it), while `ToolRouteProps` keeps the parsed output. A structural schema declaring only `_output` uses it for both. `renderRoute` now parses its input through the route's own `inputSchema` before the component runs and fails with an `invalid-input` harness error on rejected input. `agent-bundle validate` reports `AB4834` once per TypeScript program that imports `agent-bundle/app`, `agent-bundle/test`, `agent-bundle/eval`, or `@agent-bundle/runtime` and omits the generated declaration — following `references` transitively — instead of accepting any one referenced program that includes it. The `mcp-server` and `cli-tool` starters run `agent-bundle validate` inside `npm run typecheck`, so a clean checkout type-checks against current route declarations. (#PR)
