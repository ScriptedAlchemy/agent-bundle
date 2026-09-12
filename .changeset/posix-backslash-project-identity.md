---
"agent-bundle": patch
---

Keep literal backslashes in `createProjectContext` project-relative identities on POSIX so a filename containing `\` does not collapse onto a slash-separated path. (#790)
