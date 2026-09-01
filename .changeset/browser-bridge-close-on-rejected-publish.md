---
"agent-bundle": patch
---

Force-close the MCP App bridge when the initial tool result publication is rejected in mountBrowserApp, so the test binding is released instead of leaking.
