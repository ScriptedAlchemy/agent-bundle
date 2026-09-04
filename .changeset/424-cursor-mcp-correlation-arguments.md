---
"@agent-bundle/runtime": patch
"agent-bundle": patch
---

Resolve `request.lineage` for concurrent Cursor MCP calls by their arguments. Cursor's `tools/call` `_meta` names no conversation, so a generated MCP server correlated a call only through the open `MCP:<tool>` pre-tool hook and reported `id-not-resolvable` whenever several conversations had the same tool open. The pre-tool hook's `tool_input` is the call's arguments verbatim, so the lineage registry now records their digest on each open window (`inputDigest`) and the generated server passes the call's raw wire arguments (captured before schema parsing, so input defaults never make two calls look alike) to `resolveToolCall`; a concurrent call with different arguments resolves (`resolution: inferred`, provenance `derived`), identical arguments still refuse, a window recorded without a digest stays in contention, and a single open conversation is unaffected. (#483)
