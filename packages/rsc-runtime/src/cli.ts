import type { RscApplication } from './application.js';
import { available, runAgentRequest, unavailable } from './agent-request.js';

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
  const cli = operation.cli;
  if (commandArguments.length === 1 && (commandArguments[0] === '--help' || commandArguments[0] === '-h')) {
    write(`${cli.usage}\n\n${cli.summary}\n`);
    return 0;
  }
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const cwd = process.cwd();
  const result = await runAgentRequest({
    capabilities: Object.freeze({
      command: unavailable(),
      filesystem: unavailable(),
      network: unavailable(),
      projectRoot: available({ root: cwd }, 'derived'),
    }),
    host: unavailable('unsupported-surface'),
    invocation: {
      kind: 'cli',
      operationId: operation.id,
      surface: cli.name,
    },
    signal,
    workspace: available({ root: cwd }, 'derived'),
  }, async () => operation.execute(cli.parse(commandArguments), { signal }));
  signal.throwIfAborted();
  write(`${JSON.stringify(result)}\n`);
  return cli.exitCode(result);
};
