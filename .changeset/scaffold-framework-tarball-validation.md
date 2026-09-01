---
"create-agent-bundle": patch
---

Validate a local `file:` framework tarball for framework-only templates too, so a missing, corrupt, or misnamed archive fails the scaffold with a usage error instead of reporting the project ready with an unusable dependency.
