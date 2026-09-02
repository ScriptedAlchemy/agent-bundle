---
"agent-bundle": patch
---

The Workbench route input editor migrated its coordinated local state to
`@effect/atom-react` atoms keyed by manifest digest and compiled route id,
preserving typed and raw validation behavior while releasing state on unmount.
