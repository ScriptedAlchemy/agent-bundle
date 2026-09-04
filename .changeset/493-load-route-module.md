---
'agent-bundle': patch
---

Export `loadRouteModule(id)` from `agent-bundle/test`: the evaluated module behind one compiled route id, through the same registered loader `renderRoute` uses, so `inputSchema`, `resultSchema`, `config`, and `default` are the route's own exports by reference and a schema-identity suite can iterate `testManifest().routes` instead of maintaining static route imports. A literal id is checked against the registered route ids and the schemas' parsed values are typed from the registration; outside an `agentBundleRstest()` pool or against a foreign manifest it fails closed with `manifest-unavailable`. Fixes #493. (#499)
