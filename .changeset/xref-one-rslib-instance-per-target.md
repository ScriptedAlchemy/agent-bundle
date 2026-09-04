---
'agent-bundle': patch
---

Compile every agent-host surface of a target — the routed CLI bin, bundled scripts, hook wrappers, MCP stdio entries, and their react-server Flight workers — through one Rslib instance per target instead of one instance per surface, with the optional browser MCP Apps stage ordered first only for targets that declare App routes; `agent-bundle build`, `dev`, and `prepack` emit byte-identical artifacts with the same manifest source inputs while spending less time in bundler setup and stats collection (#503)
