---
"agent-bundle": patch
---

Ignore the package build's `.<output>.compile-XXXXXX` scratch directory in the `agent-bundle dev` source watcher, so a `dist/` package build no longer republishes the epoch it just produced and Workbench invocations run under the epoch that was active when they were queued. (#669)
