---
"@agent-bundle/runtime": patch
---

Keep next-event notice admission deterministic across invocation replays,
scope replayed deliveries to the matching principal, exclude notices created
after an event started, and interrupt delivery authorization when the request
is aborted.
