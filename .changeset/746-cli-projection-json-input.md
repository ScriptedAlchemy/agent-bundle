---
"agent-bundle": minor
---

Add `input: 'json'` to `CliProjectionConfig`: a tool's `<tool>.cli.ts` projection may take the tool's canonical input as one JSON object through `--input` — like the bulk `routes.mcpCommands` projection — when its `inputSchema` has no faithful flag form (a nested object, a union, a transform). The object reaches the tool's own `inputSchema` unchanged, schema issues are spelled under `--input.<path>`, a non-object `--input` exits 2 before the tool runs, and `command`, `aliases`, `description`, `confirm` (`--yes`), and `exitCode` behave as for a flag-bound projection. `AB4814` on a projected tool now recovers with this mode; combining it with `flags`, `positionals`, or a `mapInput` export is `AB4844`. Help, `inspect`, and `agent-bundle.manifest.json` record the mode as `projection.input: "json"`, which advances the closed artifact contract to `manifestVersion` 5. (#760)
