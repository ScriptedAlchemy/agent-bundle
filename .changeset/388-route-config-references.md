---
"agent-bundle": minor
---

Let static route `config` reference an MCP App instead of repeating its `ui://` literal (#388). A new `agent-bundle/routes` subpath exports `appResourceUri('<app>')`, which the route-graph compiler resolves to the referenced App route's `config.resourceUri` (`AB4826` for an unknown App); the static grammar also accepts `const` string-literal identifiers declared in the route module or `export const`-ed by a relative sibling module, and `AB4806` now names both supported forms. `ToolConfig`/`ResourceConfig`/`PromptConfig`/`AppRouteConfig._meta` type `ui.resourceUri` (`RouteMeta`, `RouteUiMeta`). An App route's `config.template` now resolves relative to the route module like its imports; the legacy project-root-relative form is still accepted while unambiguous, and `AB4827` names both candidate paths when they conflict or neither exists.
