export interface CliCommandContext {
  readonly signal: AbortSignal;
}

interface Schema<Output> {
  readonly _output: Output;
  parse(value: unknown): Output;
}

type SchemaOutput<Value> = Value extends Schema<infer Output> ? Output : never;

interface CliProjection<Input, Result> {
  readonly exitCode?: (result: Result) => 0 | 1 | 2;
  readonly name: string;
  readonly parse: (args: readonly string[]) => Input;
  readonly summary: string;
  readonly usage: string;
}

interface CliCommandDefinition<
  InputSchema extends Schema<unknown>,
  ResultSchema extends Schema<unknown>,
  ParsedInput,
  HandlerInput,
> {
  readonly cli: CliProjection<ParsedInput, SchemaOutput<ResultSchema>>;
  readonly handler: (input: HandlerInput, context: CliCommandContext) => unknown;
  readonly id: string;
  readonly inputSchema: InputSchema;
  readonly resultSchema: ResultSchema;
}

export const defineCliCommand = <
  InputSchema extends Schema<unknown>,
  ResultSchema extends Schema<unknown>,
  ParsedInput,
  HandlerInput,
>(
  definition: CliCommandDefinition<InputSchema, ResultSchema, ParsedInput, HandlerInput>,
): CliCommandDefinition<InputSchema, ResultSchema, ParsedInput, HandlerInput> => Object.freeze(definition);

interface RuntimeCliCommand {
  readonly cli: CliProjection<unknown, unknown>;
  readonly handler: (input: unknown, context: CliCommandContext) => unknown;
  readonly inputSchema: { parse(value: unknown): unknown };
  readonly resultSchema: { parse(value: unknown): unknown };
}

const runtimeCommands = (commands: readonly unknown[]): readonly RuntimeCliCommand[] =>
  commands as readonly RuntimeCliCommand[];

export const runCliCommands = async (
  definitions: readonly unknown[],
  argv: readonly string[],
  options: { readonly signal?: AbortSignal; readonly write?: (value: string) => void } = {},
): Promise<0 | 1 | 2> => {
  const commands = runtimeCommands(definitions);
  const write = options.write ?? ((value: string) => process.stdout.write(value));
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    write(`${commands.map((command) => `${command.cli.usage}\n  ${command.cli.summary}`).join('\n')}\n`);
    return 0;
  }
  const command = commands.find((candidate) => candidate.cli.name === argv[0]);
  if (command === undefined) throw new Error(`Unknown command: ${argv[0]}`);
  if (argv[1] === '--help' || argv[1] === '-h') {
    write(`${command.cli.usage}\n${command.cli.summary}\n`);
    return 0;
  }
  const signal = options.signal ?? new AbortController().signal;
  const input = command.inputSchema.parse(command.cli.parse(argv.slice(1)));
  const result = command.resultSchema.parse(await command.handler(input, { signal }));
  write(`${JSON.stringify(result)}\n`);
  return command.cli.exitCode?.(result) ?? 0;
};
