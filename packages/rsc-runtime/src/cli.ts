import type { RscApplication } from './application.js';

export interface RscCliOptions {
  readonly signal?: AbortSignal;
  readonly write?: (value: string) => void;
}

const help = (application: Readonly<RscApplication>): string => {
  const commands = application.operations.flatMap((operation) => operation.cli === undefined
    ? []
    : [`  ${operation.cli.usage.padEnd(34)} ${operation.cli.summary}`]);
  return `${application.name}${application.description === undefined ? '' : ` - ${application.description}`}\n\nCommands:\n${commands.join('\n')}\n`;
};

export const runRscCli = async (
  application: Readonly<RscApplication>,
  argv: readonly string[],
  options: RscCliOptions = {},
): Promise<0 | 1 | 2> => {
  const write = options.write ?? ((value: string) => process.stdout.write(value));
  const [commandName, ...commandArguments] = argv;
  if (commandName === undefined || commandName === '--help' || commandName === '-h') {
    write(help(application));
    return 0;
  }
  const operation = application.operations.find((candidate) => candidate.cli?.name === commandName);
  if (operation?.cli === undefined) throw new Error(`Unknown command: ${commandName}`);
  if (commandArguments.length === 1 && (commandArguments[0] === '--help' || commandArguments[0] === '-h')) {
    write(`${operation.cli.usage}\n\n${operation.cli.summary}\n`);
    return 0;
  }
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const result = await operation.execute(operation.cli.parse(commandArguments), { signal });
  signal.throwIfAborted();
  write(`${JSON.stringify(result)}\n`);
  return operation.cli.exitCode(result);
};
