---
"agent-bundle": patch
---

Judge a projected command's `z.enum` choices with the canonical schema after `mapInput` runs when the `<tool>.cli.ts` projection exports `mapInput`, so a mapper can split a comma-separated enum list (`--regions us,uk`); a value outside the enum still exits 2 as `Invalid value for --<option>[<index>]`. The `audiobook-curator` example now ships its sixteen commands as `<tool>.cli.ts` projections of its sixteen curator tools instead of a parallel `src/cli/` tree and the bulk `routes.mcpCommands` group. (#732)
