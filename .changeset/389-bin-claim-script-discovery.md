---
"agent-bundle": patch
---

Keep a conventional `src/scripts/<name>.ts` module in script discovery when a `bin` or `lib` config entry also references it, so `agent-bundle build` emits both `dist/bin/<name>.js` and the artifact `scripts/<name>.mjs` and `agent-bundle inspect --json` lists the module under both `packageBuild.bins` and `scripts` instead of silently dropping the script. Explicit `scripts`, `hooks`, and `mcp` entries still claim the module they reference. Report `AB4737` when a `bin` entry points at a rendered `src/scripts/<name>.tsx` script that exports no named `main`, because its Server Component cannot double as the bin's `main`. (#413)
