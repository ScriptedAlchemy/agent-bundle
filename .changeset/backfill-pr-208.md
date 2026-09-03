---
"@agent-bundle/runtime": patch
---

Close the `@agent-bundle/runtime/state/sqlite` connection through an infallible finalizer again: a close failure on the success path surfaces as a defect, and on the failing path the original failure stays the reported cause. (#208)
