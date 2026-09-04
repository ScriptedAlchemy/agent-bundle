---
"@agent-bundle/runtime": patch
---

Add React-owned final-only Flight execution behind the public render-dispatcher
and execution-host seam. Decode intrinsic `Agent.*` output into one immutable
Agent Document and propagate request cancellation without changing the existing
synchronous MCP lowerer path.
