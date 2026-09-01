---
"agent-bundle": patch
---

Hold Cursor's 64-character plugin-name bound in the standalone `cursor` planner as well as the unified `plugin` planner, and reject capability states outside the four-state contract with a typed `CapabilityStateError` at the registry boundary instead of returning a fabricated truthy state.
