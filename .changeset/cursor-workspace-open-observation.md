---
"agent-bundle": patch
---

Support Cursor's canonical `workspace/open` event route as a fire-and-forget
observation. The generated wrapper accepts Cursor's sessionless `workspaceOpen`
envelope and emits no output; the optional native `pluginPaths` return channel
is deliberately not modeled.
