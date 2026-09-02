---
"agent-bundle": minor
---

Add the stage-3 installed-host contract matrix boundary (#218). `openInstalledHostMcpServer` verifies and discovers a clean installed host layout, spawns its emitted MCP command over stdio, and observes the live initialize identity. `runInstalledHostContractMatrix` reuses the shared matrix at `host-install` proof level and reports a fail-closed source, built-artifact, installed-artifact, and running-process version quadruple with host binary, adapter, manifest/schema, and framework metadata.
