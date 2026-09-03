---
"agent-bundle": patch
---

Close a Workbench MCP App preview immediately when its sandbox proxy has not loaded yet: closing the preview (or switching its profile, deactivating the MCP page, or ending the session) before the proxy signals readiness now releases the binding at once instead of posting a teardown no window can acknowledge and holding the preview in its closing state for the full five-second force-close budget (#PR)
