---
"agent-bundle": patch
"create-agent-bundle": patch
---

Address the fourth wave of review findings. Rendered CLI commands, projected
MCP commands, and rendered scripts now forward the dispatched `invocation` to
the Flight worker, so conventional context providers that branch on
`invocation.kind` receive it instead of `undefined`. The transcribed Codex
plugin schema rejects line terminators in component, interface-asset, and
screenshot paths so a newline followed by `/../` cannot slip past the traversal
guard (codex adapter 1.8.0, plugin adapter 1.23.0). Any-JSON `permission/request`
`tool_input` is admitted only for Codex, whose pinned schema declares it; Claude
envelopes stay object-shaped. `agent-bundle build --help` and `prepack --help`
describe the `artifact` default those commands actually use. The MCP probe
redaction no longer treats a URI scheme's `://` as a path separator, so
documentation links survive, and plugin-data removal now follows the transport
teardown instead of racing a slow stdio shutdown. Doctor probes runtime
endpoints concurrently (eight at a time), bounding a directory of silent
runtimes as a whole. Scaffolded READMEs render install instructions for the
selected targets rather than a hard-coded `install claude`.
