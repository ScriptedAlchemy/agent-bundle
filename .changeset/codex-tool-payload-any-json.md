---
'agent-bundle': patch
---

Accept any JSON `tool_input` / `tool_response` on Codex `PreToolUse` / `PostToolUse` hook input, matching the pinned rust-v0.147.0 generated schemas (`"tool_input": true`, `"tool_response": true`). The generated Codex hook wrapper and the event-route envelope validator now require presence only for Codex, so string, number, boolean, and null tool payloads reach the handler instead of failing with `must be an object`; Claude keeps its documented object requirement.
