---
"agent-bundle": patch
---

Address the third-wave review findings across the adapters: Codex artifacts honor `plugin.logo` (interface field + shipped image), the generated fallback prompt is bounded to the pinned 128-code-point limit and authored prompts are counted in code points, the transcribed Codex plugin schema rejects backslash parent traversal in component and interface-asset paths and accepts case-insensitive HTTP(S) schemes, Claude marketplace relative paths allow harmless `.` segments again (only `..` escapes), `permission/request` envelopes accept every `tool_input` shape the pinned schema declares, adapter revisions advance for the promoted event contracts (claude 1.22.0, codex 1.6.0, cursor 1.8.0, plugin 1.21.0), the G5 agents provenance note reconciles with the published parity rows, and the repository-owned capability-table hash pins are removed per the documented hashing policy.
