---
"agent-bundle": minor
---

Add explicit target-capability fixtures to `agent-bundle/test`.

`createTargetCapabilityFixture()` records support or denial for image, audio,
resource, and progress projection while keeping text as the always-supported
baseline. `projectTargetCapabilities()` projects a real `renderRouteEvents()`
result through the runtime's MCP projector, preserving its rich-content
fallback and fail-closed behavior without claiming transport, packed artifact,
or host proof.

`expectDocument()` now includes field-aware assertions for image, audio, and
resource nodes.
