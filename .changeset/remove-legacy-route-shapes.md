---
"agent-bundle": minor
---

Drop the `complete` Flight worker message from the development server's production route invocation path. Generated workers have streamed `chunk` and `end` since #718, so an artifact compiled before that and restored from the epoch store now fails its render with `Compiled route worker failed.` instead of rendering one buffered document. Rebuild the project to restore rendering. (#838)
