---
"@agent-bundle/runtime": patch
"agent-bundle": patch
---

Type `renderRoute` and `renderRouteEvents` (from `agent-bundle/test`) against the project's own routes: the generated `.agent-bundle/routes.d.ts` now registers an `AgentBundleRouteContracts` map (`{ input, result }` per route id) on `@agent-bundle/runtime`'s new `Register` interface, so once that file is in the project's TypeScript program a string-literal route id is checked against the compiled ids, `input` is typed from the route's `inputSchema`, and `result` from its `resultSchema`. `@agent-bundle/runtime` exports `Register`, `RegisteredRoutes`, `RegisteredRouteContract`, `RegisteredRouteId`, `RegisteredRouteInput`, and `RegisteredRouteResult`; `agent-bundle/test` exports `RouteTargetConstraint`, `RouteTargetInput`, and `RouteTargetResult`. Nothing is required: a value typed `string`, a module target, or a program without the generated file sees the previous types (any id, `unknown` input and result). (#456)
