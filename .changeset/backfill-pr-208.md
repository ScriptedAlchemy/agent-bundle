---
"@agent-bundle/runtime": patch
---

The sqlite state driver closes its connection through an infallible finalizer again: a close failure on the success path surfaces as a defect instead of breaking the declaration build, and on the failing path the original failure stays the reported cause. (#208)
