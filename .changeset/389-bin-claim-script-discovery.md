---
"agent-bundle": patch
---

A `bin` (or `lib`) entry that references a conventional `src/scripts/<name>.ts` module no longer removes it from script discovery. The npm bin (`dist/bin/<name>.js`) and the artifact script (`scripts/<name>.mjs`) are disjoint outputs, so the same entry now ships on both surfaces and `inspect` lists it under both `packageBuild.bins` and `scripts`; previously the artifact script silently disappeared. Explicit `scripts`, `hooks`, and `mcp` entries still claim the module they reference. A `bin` entry pointing at a rendered `src/scripts/<name>.tsx` script is the new `AB4737` error, because a rendered script's Server Component cannot double as a bin's `main`.
