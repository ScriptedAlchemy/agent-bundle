---
"@agent-bundle/runtime": patch
---

Add `useAgent()` to `@agent-bundle/runtime`, the synchronous convenience over `await agent()` for Server Components and server utilities that cannot await. It returns the identical request handle from the same realm-singleton store under the same lease rules — `outside-invocation` when no request is in the async context, `request-closed` on a handle captured from a completed request — and never suspends, because the handle is already resolved in the request's async context. (#402)
