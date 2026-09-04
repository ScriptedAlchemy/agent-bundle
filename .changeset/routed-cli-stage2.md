---
"agent-bundle": patch
---

Compile `src/cli/**` routes into a routed CLI (#102 stage 2). Conventional
command routes now compile into one collision-checked command graph —
path nesting is identity (`src/cli/library/audit.ts` runs as
`<bin> library audit`), the static `config` export supplies description,
aliases, positionals, and the exit-code policy, and a bounded, documented
zod grammar projects each route's `inputSchema` onto argv (options,
positionals, arrays, defaults) with named `AB4814` diagnostics for
constructs outside it. The graph feeds the existing package-build pipeline
as one generated Rslib executable named after the plugin, superseding the
`src/cli.ts` bin convention for that project; commands run inside the typed
Agent request context, write one canonical JSON line to stdout, accept
`--json`, and map exit codes deterministically (0/1/2, 130/143 on signals).
Command-tree and alias collisions, contract violations, and rendered
(`.tsx`) command routes fail source validation with the new
`AB4813`–`AB4816` diagnostics instead of building silently.
