---
"agent-bundle": patch
---

Publish `.agent-bundle/routes.d.ts` during project preparation (`agent-bundle build`, `agent-bundle dev`, and every API call that prepares a project) through Effect `FileSystem`: the staging file is removed on every exit path, including interruption, while the generated declarations, the atomic rename, and thrown Node errors are unchanged. (#520)
