---
"@agent-bundle/runtime": patch
"agent-bundle": patch
---

Type `renderRoute` and `renderRouteEvents` (`agent-bundle/test`) against the project's own routes: the generated `.agent-bundle/routes.d.ts` registers each route's harness contract on the new `Register` interface of `@agent-bundle/runtime`, so a string-literal route id is checked against the compiled ids, `input` is typed from the route's `inputSchema` (an event route's `{ canonical, native }` payload), and `result` from its `resultSchema` (`undefined` for event routes). Add `Register`, `RegisteredRoutes`, `RegisteredRouteContract`, `RegisteredRouteId`, `RegisteredRouteInput`, and `RegisteredRouteResult` to `@agent-bundle/runtime`, and `RouteTargetConstraint`, `RouteTargetInput`, and `RouteTargetResult` to `agent-bundle/test`; a program without the generated file keeps the previous `string` / `unknown` types. (#456)
