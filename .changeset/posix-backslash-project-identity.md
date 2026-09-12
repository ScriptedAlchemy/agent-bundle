---
"agent-bundle": patch
---

Fail closed when `createProjectContext` or project preparation encounters a source identity that is not a relocatable POSIX path, including a POSIX filename containing `\`, so `agent-bundle build` never serializes a backslash into `agent-bundle.manifest.json` (`AB7003`). (#790)
