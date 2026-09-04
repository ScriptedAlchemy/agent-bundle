---
'@agent-bundle/runtime': patch
'agent-bundle': patch
---

Project an `Agent.Progress` node streamed in a `Suspense` fallback (any `shell`/`replace` document) to `notifications/progress` when the MCP request carries `_meta.progressToken`, under the same monotonic `progress` rule as `progress.report()` so a re-streamed fallback or an explicit report of the same step is never duplicated. A fallback alone is now enough; `announce()`-style shims that repeat the fallback message through `progress.report()` are unnecessary. Fixes #448. (#498)
