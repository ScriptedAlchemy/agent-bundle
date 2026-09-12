---
"agent-bundle": patch
---

Treat a dangling symlink ancestor as its target when `createProjectContext` judges a missing path, so a leaf under an escaping symlink still fails closed as outside the project root instead of reconstructing a lexical-inside path that can resolve outside after the target appears. (#789)
