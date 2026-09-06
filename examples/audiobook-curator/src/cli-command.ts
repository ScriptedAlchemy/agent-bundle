/**
 * The context every `src/operations/*.ts` handler receives from the generated
 * MCP routes and the routed `src/cli/` commands. The manual CLI projection
 * (`cli.parse`/`usage`/`exitCode`) and its `runCliCommands` dispatcher were
 * retired by the #102 stage-3 migration — the framework compiles `src/cli/**`
 * routes into the executable instead.
 */

export interface CliCommandContext {
  readonly signal: AbortSignal;
}
