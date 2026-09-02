---
"agent-bundle": patch
---

The Workbench Agent Document panel migrated its hand-rolled request state to
`@effect/atom-react` atoms keyed by run id under a root `RegistryProvider`,
keeping the strict zod decoding and imperative client lifecycles unchanged.
