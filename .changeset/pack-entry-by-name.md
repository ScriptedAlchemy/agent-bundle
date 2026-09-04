---
"agent-bundle": patch
---

Select the intended `npm pack --json` entry by package name in `packOutputFromJson`, `scripts/run-packed-tests.mjs`, the release audit, and the packed test harnesses, so workspace-aware pack output that lists sibling packages no longer breaks `test:packed`, `test:packed:native`, or `audit-packed-release` (#432)
