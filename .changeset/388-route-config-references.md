---
"agent-bundle": patch
---

Reference an MCP App from static route `config` instead of repeating its `ui://` literal: import `appResourceUri('<app>')` from the new `agent-bundle/routes` subpath and the route-graph compiler resolves it to the App route's `config.resourceUri` (`AB4826` for an unknown App or one on a non-generated server, `AB4828` when the App is not built for every target the server ships to), or use a `const` string-literal identifier declared in the route module or `export const`-ed by a relative sibling module; `AB4806` now names both supported forms, and `ToolConfig`/`ResourceConfig`/`PromptConfig`/`AppRouteConfig` type `_meta.ui.resourceUri` through `RouteMeta`/`RouteUiMeta`. Resolve an App route's `config.template` relative to the route module like its imports, keep accepting the project-root-relative form while unambiguous, and report `AB4827` with both candidate paths when they conflict or neither exists (#418)
