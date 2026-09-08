---
'create-agent-bundle': patch
---

Offer every compiled target in project creation: `--targets amp` and the interactive target
prompt now accept `amp`, matching `createDefaultRegistry()`. `amp` with the `mcp-server`
template is a usage error naming the templates Amp can carry, because Amp's skill-scoped MCP
contract refuses that template's compiler-owned local server (`amp.mcp.generated-local`).
Scaffolded READMEs invoke `npx --no-install agent-bundle` so a missing local install cannot
fetch an unrelated package. (#758)
