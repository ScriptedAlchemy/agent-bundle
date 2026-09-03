---
"agent-bundle": patch
---

Keep development hosts connected across rebuilds with an epoch-aware Streamable HTTP MCP endpoint and stable stdio proxy. New calls use the active artifact while in-flight calls retain their original epoch, and catalog changes reach hosts without reinstalling the plugin.
