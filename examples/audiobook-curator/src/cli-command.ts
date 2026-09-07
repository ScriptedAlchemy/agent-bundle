/**
 * The context every `src/operations/*.ts` handler receives from the curator
 * tool routes, whichever surface — MCP or the tools' `<tool>.cli.ts`
 * projections — invoked them.
 */

export interface CliCommandContext {
  readonly signal: AbortSignal;
}
