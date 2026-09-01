---
"@agent-bundle/runtime": patch
---

`lowerMcpResult` now follows MCP SDK wire semantics for `undefined` inside
`structuredContent` and `_meta`: object properties whose value is `undefined`
are dropped and `undefined` array elements lower to `null`, exactly as
`JSON.stringify` serializes them (#44). Handlers written against SDK
serialization no longer fail at runtime when an optional field stays
`undefined` on some input path. Every other strict rejection — cycles,
accessors, sparse arrays, non-finite numbers, non-plain objects — is
preserved, and the JSON-boundary error now names the offending key path
instead of a fixed message.
