---
"agent-bundle": minor
---

Expose credential-free request provenance for Workbench lifecycle replays, including explicit host, session, actor, workspace, and invocation axes with typed absence. Lifecycle routes now execute under the same receipt-sourced context shown in the Workbench, and the strict client decoder rejects unsupported wire fields.

Deprecate `plugin.version` in favor of package identity. Compiled MCP App routes now consume compiler-stamped `agent-bundle/meta` identity, while the prebuilt RSC example centralizes its host slug and derives its release version from `package.json`, so runtime registries and App modules no longer restate project identity.
