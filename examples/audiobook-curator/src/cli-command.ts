/**
 * The operation-definition helper behind `src/operations/*.ts`: one shared
 * core (`id`, `inputSchema`, `handler`, `resultSchema`) that the generated
 * MCP routes and the routed `src/cli/` commands both consume. The manual
 * CLI projection (`cli.parse`/`usage`/`exitCode`) and its `runCliCommands`
 * dispatcher were retired by the #102 stage-3 migration — the framework
 * compiles `src/cli/**` routes into the executable instead.
 */

export interface CliCommandContext {
  readonly signal: AbortSignal;
}

interface Schema<Output> {
  readonly _output: Output;
  parse(value: unknown): Output;
}

/** Exported so consumer declaration emit can name the registry types (#174). */
export interface CliCommandDefinition<
  InputSchema extends Schema<unknown>,
  ResultSchema extends Schema<unknown>,
  HandlerInput,
> {
  readonly handler: (input: HandlerInput, context: CliCommandContext) => unknown;
  readonly id: string;
  readonly inputSchema: InputSchema;
  readonly resultSchema: ResultSchema;
}

export const defineCliCommand = <
  InputSchema extends Schema<unknown>,
  ResultSchema extends Schema<unknown>,
  HandlerInput,
>(
  definition: CliCommandDefinition<InputSchema, ResultSchema, HandlerInput>,
): CliCommandDefinition<InputSchema, ResultSchema, HandlerInput> => Object.freeze(definition);
