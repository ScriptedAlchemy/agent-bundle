---
"create-agent-bundle": patch
---

Scaffolded `agent-bundle.config.ts` no longer repeats the deprecated `plugin.version`; every template derives its release version from `package.json`, matching the #94 identity contract.
